# EZiL CLI: deploy and operator steps

## How it deploys now

`.github/workflows/ci.yml` in `EZiLHQ/ezil-cli`. Every `main` commit runs four steps, in order:
1. **check:** typecheck, unit tests, gateway tests and the full-chain e2e.
2. **staging:** `wrangler deploy --env staging`, binds the secrets, probes that `/health` reports the commit with `configured=true`, then runs `tests/live` against `git-staging.ezil.work`.
3. **production:** the same deploy, secret binding and probe for `github.ezil.work` + `git.ezil.work`, then the live smoke. The Worker is rolled back if the smoke fails.
4. **release:** a `v*` tag builds unsigned binaries and `SHA256SUMS`.

The jobs run on this repository's own runner service `ezil-aws-cli` (label `ezil-private`). It's on the same private AWS host as `ezil-aws-works` and `ezil-aws-gateway`.

## One-time setup (founder)

Run `bash "/data/openclaw/projects/ezil/EZiL CLI/ops/founder-setup.sh"`. It:
- creates the `staging` and `production` environments;
- sets the repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GIT_GATEWAY_SECRET`, `IP_HASH_SALT` and `EZIL_E2E_QA_PASSWORD`;
- registers the runner service. It follows the same procedure as `EZiL-Works/infra/aws-runner/register.sh`: a short-lived token through an SSM SecureString, plus a temporary read policy, both removed afterwards.

No value is printed. The script reads the gateway secret and salt from `/root/.config/ezil-git-gateway/`. They are the same values the Works API (Vercel `GIT_GATEWAY_SECRET`) and the staging Worker already hold.

If the Cloudflare token in `.env` can't deploy Workers, the staging job fails at `wrangler deploy` with an auth error. In that case, mint an "Edit Cloudflare Workers" token in the dashboard and run `gh secret set CLOUDFLARE_API_TOKEN --repo EZiLHQ/ezil-cli`.

## Rotating the gateway secret

1. Generate a new value.
2. Set it on Vercel `ezil-works-api` (`GIT_GATEWAY_SECRET`, sensitive, production) and redeploy the API.
3. Run `gh secret set GIT_GATEWAY_SECRET --repo EZiLHQ/ezil-cli`.
4. Re-run the latest `main` workflow.

Between steps 2 and 4, the gateway fails closed (503), and no access is granted.

## Rollback
- **Gateway:** run `wrangler rollback` in `apps/git-gateway` (CI does this on a failed production smoke). Or remove the Custom Domain, which takes the hostname offline.
- **API secret:** delete the Vercel variable. `/internal/git/*` then refuses everything, which fails safe.
- **Schema:** it's additive and stays. Nothing writes to it unless the CLI is used.

## Known limits (from the independent review, 2026-10-02)
- **Staging is a second production edge.** `git-staging.ezil.work` talks to the production Works API (`api.ezil.work`; there is no staging API) with the same `GIT_GATEWAY_SECRET`. Its live E2E pushes a throwaway branch to a real QA-tenant repository and deletes it. What staging isolates is the gateway code, not the data.
- **The GitHub environments have no reviewers,** and the secrets are repository-level. So `production` runs automatically after a green staging run, the same as `ezil-ai-gateway`. To gate production, add a required reviewer to the `production` environment.
- **The runner user is in the `docker` group,** so the `check` job of a same-repository PR has near-root access to the shared host. That's the same as the existing `register.sh` services. Fork PRs never run on it.
- **The QA builder's password is the seeded default** in EZiL-Works `tools/seed-qa.ts`, and it is known to anyone with read access to that repository. Rotating it means updating the account, the `EZIL_E2E_QA_PASSWORD` secret, and the Works QA suites together.
- **`/health` is public** and shows the deployed commit SHA.
- **The contract digests pin each repository against itself only.** Cross-repository compatibility is proven at runtime: the gateway parses production answers strictly, and the live E2E parses `/cli` answers. See `packages/contract/src/digest.test.ts`.
