#!/usr/bin/env bash
# Set the CI/CD secrets a fresh deployment of this repository needs. Every value comes from the environment and is
# passed to `gh secret set` on stdin, so none is printed or put on a command line.
#
#   REPO=owner/ezil-cli CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… GIT_GATEWAY_SECRET=… IP_HASH_SALT=… \
#   EZIL_E2E_QA_EMAIL=… EZIL_E2E_QA_PASSWORD=… NPM_TOKEN=… bash ops/setup-secrets.sh
#
# CLOUDFLARE_API_TOKEN   Workers deploy + R2 write on the account that owns the gateway's zone
# GIT_GATEWAY_SECRET     HMAC shared with the EZiL Works API (its GIT_GATEWAY_SECRET); >= 32 random bytes
# IP_HASH_SALT           salt for the client-IP hash the gateway sends; random, gateway only
# EZIL_E2E_QA_*          a dedicated QA builder account for the live E2E (never a person's account)
# NPM_TOKEN              granular npm token that can publish the package (the release job)
set -euo pipefail
: "${REPO:?set REPO=owner/name}"
for e in staging production; do gh api -X PUT "repos/$REPO/environments/$e" >/dev/null && echo "environment $e"; done
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID GIT_GATEWAY_SECRET IP_HASH_SALT EZIL_E2E_QA_PASSWORD NPM_TOKEN; do
  if [ -n "${!name:-}" ]; then printf %s "${!name}" | gh secret set "$name" --repo "$REPO" && echo "secret $name"; else echo "skip $name (unset)"; fi
done
if [ -n "${EZIL_E2E_QA_EMAIL:-}" ]; then gh variable set EZIL_E2E_QA_EMAIL --repo "$REPO" --body "$EZIL_E2E_QA_EMAIL" && echo "variable EZIL_E2E_QA_EMAIL"; fi
