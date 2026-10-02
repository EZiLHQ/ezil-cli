# EZiL CLI: the founder's deploy steps

These are the steps this session's permission check won't let the agent run: secret writes and a direct `wrangler deploy`. Run them from a terminal on this VM. The secrets were generated as root-only files, so these commands read them and never print them:

- `/root/.config/ezil-git-gateway/git-gateway-secret`: the HMAC shared by the API and the gateway.
- `/root/.config/ezil-git-gateway/ip-hash-salt`: gateway only.

## 1. Give the production API the gateway secret (before or right after PR #40 merges)
```bash
VT=$(python3 -c 'import json;print(json.load(open("/root/.local/share/com.vercel.cli/auth.json"))["token"])')
TEAM=$(curl -s -H "Authorization: Bearer $VT" https://api.vercel.com/v2/teams/ezil | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
python3 -c 'import json;print(json.dumps({"key":"GIT_GATEWAY_SECRET","value":open("/root/.config/ezil-git-gateway/git-gateway-secret").read().strip(),"type":"sensitive","target":["production"]}))' \
  | curl -s -X POST -H "Authorization: Bearer $VT" -H "Content-Type: application/json" \
      "https://api.vercel.com/v10/projects/ezil-works-api/env?teamId=$TEAM" --data @- | python3 -c 'import json,sys;print(json.load(sys.stdin).get("created",{}) and "created" or "check output")'
```
- **If you set it before #40 merges:** the release from `main` picks it up.
- **If you set it after:** redeploy the API by re-running the latest `Works CI/CD` run on `main` (manual dispatch), or with `tools/deploy-api.sh`.

## 2. Deploy the gateway Worker, staging first
```bash
cd /data/openclaw/projects/ezil/EZiL-Works/apps/git-gateway   # after #40 is on main; or use the worktree path
export CLOUDFLARE_API_TOKEN=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' /data/openclaw/projects/ezil/EZiL-Works/apps/api/.env | cut -d= -f2-)
wrangler deploy --env staging                                    # creates git-staging.ezil.work (Custom Domain)
wrangler secret put GIT_GATEWAY_SECRET --env staging < /root/.config/ezil-git-gateway/git-gateway-secret
wrangler secret put IP_HASH_SALT --env staging < /root/.config/ezil-git-gateway/ip-hash-salt
```
Then tell the agent "staging is up". It runs the staging end-to-end test against real Artifacts, then asks you to promote:
```bash
wrangler deploy                                                  # github.ezil.work + git.ezil.work
wrangler secret put GIT_GATEWAY_SECRET < /root/.config/ezil-git-gateway/git-gateway-secret
wrangler secret put IP_HASH_SALT < /root/.config/ezil-git-gateway/ip-hash-salt
```

## Rollback
- **Gateway:** `wrangler deployments rollback`, or delete the Worker. Without it, the hostnames are simply offline.
- **API secret:** delete the variable in Vercel. `/internal/git/*` then refuses everything, which fails safe.
- **Schema:** the schema is additive and stays. Nothing writes to it unless the CLI is used.
