#!/usr/bin/env bash
# One-time setup for EZiLHQ/ezil-cli CI/CD. Run by the founder: it writes secrets and registers a runner,
# which the agent's permission guard refuses. Idempotent; prints no secret value.
#
#   bash "/data/openclaw/projects/ezil/EZiL CLI/ops/founder-setup.sh"          # everything
#   bash "/data/openclaw/projects/ezil/EZiL CLI/ops/founder-setup.sh" runner   # only the runner (step 3)
#
# 1. GitHub environments staging + production.
# 2. Repo secrets: Cloudflare token + account (from EZiL-Works/apps/api/.env), the gateway HMAC and IP salt
#    (from /root/.config/ezil-git-gateway, the same values the Works API and the staging Worker already hold),
#    and the QA builder password for the live E2E.
# 3. A third runner service, ezil-aws-cli, on the existing private AWS runner host (same procedure as
#    EZiL-Works/infra/aws-runner/register.sh: short-lived token via SSM SecureString, temporary read policy, both
#    removed afterwards).
set -euo pipefail
REPO=EZiLHQ/ezil-cli
REGION=us-east-1
INSTANCE=i-0e6a6b8cb62624f82
ROLE=ezil-ci-runner
PARAM=/ezil/ci/runner/registration/cli
ENV_FILE=/data/openclaw/projects/ezil/EZiL-Works/apps/api/.env
SECRETS=/root/.config/ezil-git-gateway
val() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r'; }

# `founder-setup.sh runner` re-runs only step 3.
if [[ "${1:-}" != "runner" ]]; then
echo "== 1. environments"
for e in staging production; do gh api -X PUT "repos/$REPO/environments/$e" >/dev/null && echo "  $e"; done

echo "== 2. secrets (values via stdin, never printed)"
val CLOUDFLARE_API_TOKEN  | gh secret set CLOUDFLARE_API_TOKEN  --repo "$REPO"
val CLOUDFLARE_ACCOUNT_ID | gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO"
tr -d '\n' < "$SECRETS/git-gateway-secret" | gh secret set GIT_GATEWAY_SECRET --repo "$REPO"
tr -d '\n' < "$SECRETS/ip-hash-salt"       | gh secret set IP_HASH_SALT       --repo "$REPO"
printf %s "${EZIL_E2E_QA_PASSWORD:-qa-account-strong-pw}" | gh secret set EZIL_E2E_QA_PASSWORD --repo "$REPO"
gh secret list --repo "$REPO" | awk '{print "  " $1}'
fi

echo "== 3. runner ezil-aws-cli on $INSTANCE"
cleanup() {
  aws iam delete-role-policy --role-name "$ROLE" --policy-name ezil-ci-registration-cli 2>/dev/null || true
  aws ssm delete-parameter --region "$REGION" --name "$PARAM" 2>/dev/null || true
  rm -f "${TOKEN_FILE:-}" "${CMD_FILE:-}"
}
trap cleanup EXIT
TOKEN_FILE=$(mktemp); chmod 600 "$TOKEN_FILE"
gh api -X POST "repos/$REPO/actions/runners/registration-token" -q .token | tr -d '\n' > "$TOKEN_FILE"
aws ssm put-parameter --region "$REGION" --name "$PARAM" --type SecureString --value "file://$TOKEN_FILE" --overwrite >/dev/null
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws iam put-role-policy --role-name "$ROLE" --policy-name ezil-ci-registration-cli --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:$ACCOUNT:parameter$PARAM\"}]}"
echo "  waiting for IAM to propagate"; sleep 15
CMD_FILE=$(mktemp)
python3 - "$CMD_FILE" "$PARAM" <<'PY'
import json, sys
out, param = sys.argv[1:]
script = f"""set -euo pipefail
version=2.337.0; user=ezil-ci-cli; dir=/opt/ezil-ci/cli
archive=/tmp/actions-runner-linux-x64-$version.tar.gz
curl -fsSL "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz" -o "$archive"
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
getent group ezil-ci-build >/dev/null || groupadd --system ezil-ci-build
usermod -aG docker,ezil-ci-build "$user"
install -d -o "$user" -g "$user" "$dir"
if [ -f "$dir/.runner" ]; then echo already-registered; exit 0; fi
tar -xzf "$archive" -C "$dir"; chown -R "$user:$user" "$dir"
token="$(aws ssm get-parameter --region us-east-1 --name {param} --with-decryption --query Parameter.Value --output text)"
cd "$dir" && runuser -u "$user" -- ./config.sh --unattended --url https://github.com/EZiLHQ/ezil-cli --token "$token" --name ezil-aws-cli --labels ezil-private --work _work --replace >/dev/null
unset token
./svc.sh install "$user" >/dev/null && ./svc.sh start >/dev/null
rm -f "$archive"; echo registered"""
# AWS-RunShellScript runs /bin/sh (dash on Ubuntu), which has no pipefail: hand the script to bash.
json.dump({"commands": ["bash -s <<'EZIL_RUNNER_EOF'\n" + script + "\nEZIL_RUNNER_EOF"]}, open(out, "w"))
PY
CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "register ezil-aws-cli runner" --parameters "file://$CMD_FILE" --query Command.CommandId --output text)
aws ssm wait command-executed --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE" 2>/dev/null || true
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE" \
  --query '{status:Status,out:StandardOutputContent,err:StandardErrorContent}' --output json
gh api "repos/$REPO/actions/runners" -q '.runners[]|"  runner \(.name) \(.status) labels=\([.labels[].name]|join(","))"'
echo "Done. Tell the agent: setup done."
