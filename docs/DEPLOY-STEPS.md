# EZiL CLI: deploy and operator steps

## How it deploys now

`.github/workflows/ci.yml` in `EZiLHQ/ezil-cli`. Every `main` commit runs four steps, in order:
1. **check:** typecheck, unit tests, gateway tests and the full-chain e2e.
2. **staging:** `wrangler deploy --env staging`, binds the secrets, probes that `/health` reports the commit with `configured=true`, then runs `tests/live` against `git-staging.ezil.work`.
3. **production:** the same deploy, secret binding and probe for `github.ezil.work` + `git.ezil.work`, then the live smoke. The Worker is rolled back if the smoke fails.
4. **release:** a `v*` tag must match `packages/cli/package.json`. It builds unsigned binaries and `SHA256SUMS`, uploads them to R2 `ezil-cli-releases` (served at `github.ezil.work/cli/<version>/`), then moves `cli/latest`. It then installs from the live URL and runs the live E2E with the installed binary, and publishes a GitHub release.

**To release:** bump `packages/cli/package.json`, merge, wait for the `main` run, then `git tag v<version> && git push origin v<version>`.

All jobs run on GitHub-hosted runners. The repository is public, so a self-hosted runner must never serve it: a fork's pull request runs the workflow file from the fork. The `ezil-aws-cli` runner service was deregistered on 2026-10-02. Workflows from outside contributors need approval every time (`all_external_contributors`).

## One-time setup (founder)

Run `bash "/data/openclaw/projects/ezil/EZiL CLI/ops/founder-setup.sh"`. It:
- creates the `staging` and `production` environments;
- sets the repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GIT_GATEWAY_SECRET`, `IP_HASH_SALT` and `EZIL_E2E_QA_PASSWORD`;
- sets `NPM_TOKEN` from `~/.npmrc`, for the release job's `npm publish`.

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
- **The QA builder's password was published.** It's the seeded default in EZiL-Works `tools/seed-qa.ts`, and it appeared in `ops/founder-setup.sh` while this repository was public. Treat it as compromised and rotate it: update the account, the `EZIL_E2E_QA_PASSWORD` secret here, and the Works QA suites together.
- **`/health` is public** and shows the deployed commit SHA.
- **The contract digests pin each repository against itself only.** Cross-repository compatibility is proven at runtime: the gateway parses production answers strictly, and the live E2E parses `/cli` answers. See `packages/contract/src/digest.test.ts`.
