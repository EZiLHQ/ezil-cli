#!/usr/bin/env bash
# One-time setup for EZiLHQ/ezil-cli CI/CD (GitHub-hosted runners). Run by the founder: it writes repository secrets,
# which the agent's permission guard refuses. Idempotent; prints no secret value.
#
#   EZIL_E2E_QA_PASSWORD=... bash "/data/openclaw/projects/ezil/EZiL CLI/ops/founder-setup.sh"
#
# 1. GitHub environments staging + production.
# 2. Repo secrets: Cloudflare token + account (from EZiL-Works/apps/api/.env), the gateway HMAC and IP salt (from
#    /root/.config/ezil-git-gateway, the same values the Works API and the Workers hold), the QA builder password for
#    the live E2E (from the environment, never a default), and NPM_TOKEN (from ~/.npmrc) for the release job.
set -euo pipefail
REPO=EZiLHQ/ezil-cli
ENV_FILE=/data/openclaw/projects/ezil/EZiL-Works/apps/api/.env
SECRETS=/root/.config/ezil-git-gateway
val() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r'; }

echo "== 1. environments"
for e in staging production; do gh api -X PUT "repos/$REPO/environments/$e" >/dev/null && echo "  $e"; done

echo "== 2. secrets (values via stdin, never printed)"
val CLOUDFLARE_API_TOKEN  | gh secret set CLOUDFLARE_API_TOKEN  --repo "$REPO"
val CLOUDFLARE_ACCOUNT_ID | gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO"
tr -d '\n' < "$SECRETS/git-gateway-secret" | gh secret set GIT_GATEWAY_SECRET --repo "$REPO"
tr -d '\n' < "$SECRETS/ip-hash-salt"       | gh secret set IP_HASH_SALT       --repo "$REPO"
if [ -n "${EZIL_E2E_QA_PASSWORD:-}" ]; then printf %s "$EZIL_E2E_QA_PASSWORD" | gh secret set EZIL_E2E_QA_PASSWORD --repo "$REPO"; fi
npm_token="$(sed -n 's#^//registry.npmjs.org/:_authToken=##p' ~/.npmrc 2>/dev/null | head -1)"
if [ -n "$npm_token" ]; then printf %s "$npm_token" | gh secret set NPM_TOKEN --repo "$REPO"; fi
unset npm_token
gh secret list --repo "$REPO" | awk '{print "  " $1}'
echo "Done."
