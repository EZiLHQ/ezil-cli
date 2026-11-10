#!/usr/bin/env bash
# Register the one pre-existing direct Artifacts fixture for a verified EZiL ID subject.
# Usage: printf '%s\n' "$EZIL_ID_SUBJECT" | bash ops/register-standalone-fixture.sh staging
set -euo pipefail
mode=${1:-}
case "$mode" in
  staging) kv=9acf3a7f7772446baebbbfd5ddfc3f36 ;;
  production) kv=26c715893bab478ca4a1bd5a62f57107 ;;
  *) echo 'usage: register-standalone-fixture.sh staging|production < owner-subject' >&2; exit 2 ;;
esac
IFS= read -r subject
[[ $subject =~ ^[A-Za-z0-9|:_-]{3,200}$ ]] || { echo 'invalid EZiL ID subject' >&2; exit 2; }
root=$(cd "$(dirname "$0")/../../.." && pwd)
wrapper="$root/.ci-support/cloudflare-cli.sh"
[[ -x $wrapper ]] || { echo 'approved Cloudflare wrapper unavailable' >&2; exit 2; }
repo_json=$("$wrapper" artifacts repos get os-code-url-20261110-a --namespace default --json)
jq -e --arg remote 'https://2104e6f103f83b34f363985b093edc7c.artifacts.cloudflare.net/git/default/os-code-url-20261110-a.git' \
  '.id == "fg1wtcrexaf7acl0" and .name == "os-code-url-20261110-a" and .remote == $remote and .default_branch == "main" and .read_only == false' \
  <<< "$repo_json" > /dev/null || { echo 'provider fixture mismatch' >&2; exit 3; }
jq -cn --arg sub "$subject" '{providerId:"fg1wtcrexaf7acl0",ownerSub:$sub,publicRead:true}' |
  "$wrapper" kv key put 'repo:default/os-code-url-20261110-a' --namespace-id "$kv" --remote --path /dev/stdin > /dev/null
echo "registered provider fixture in $mode KV (owner subject withheld)"
