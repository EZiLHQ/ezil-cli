# Operations

## Pipeline (`.github/workflows/ci.yml`, GitHub-hosted runners)

| Trigger | Jobs |
|---|---|
| pull request (forks included; drafts skipped) | `check`: typecheck, unit + gateway + e2e + installer tests, the npm package under Node 22 |
| push to `main` | `check` → `staging`: deploy `git-staging.ezil.work`, bind secrets, `/health` must report this commit with `configured: true`, live E2E → `production`: the same for `github.ezil.work` (canonical) and its `git.ezil.work` compatibility alias, live smoke; on failure after a successful deploy, roll back to the exact version that served before it and re-probe |
| tag `v*` (must equal `packages/cli/package.json` version; tags are admin-only) | `check` → `release`: binaries + `SHA256SUMS` → GitHub release → install from the live URL + live E2E with the installed binary → npm publish with provenance |

The `staging` and `production` environments accept deployments from `main` only. Workflows from outside contributors
need a maintainer's approval every time.

## Hostnames

| Host | Role | Worker |
|---|---|---|
| `github.ezil.work` | the canonical production Git host: every clone, fetch and push URL EZiL generates, the installers and the CLI defaults | `ezil-git-gateway` |
| `git.ezil.work` | compatibility alias for remotes cloned before the rename; served by the same Worker, never printed or generated | `ezil-git-gateway` |
| `git-staging.ezil.work` | staging only; never a default, never in a production URL | `ezil-git-gateway-staging` |

Each is a Worker Custom Domain (`apps/git-gateway/wrangler.jsonc`), which creates its proxied DNS record and certificate. No
`workers.dev` address is enabled, and the gateway never returns the Cloudflare Artifacts address: an upstream redirect is
rewritten to the gateway path or refused. `apps/git-gateway/src/canonical-host.test.ts` pins the routes, the CI targets and these docs.

## Secrets and variables

Set with `ops/setup-secrets.sh` (values from the environment, passed on stdin).

| Name | Kind | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secret | deploy the Worker |
| `GIT_GATEWAY_SECRET` | secret | HMAC shared with the EZiL Works API |
| `IP_HASH_SALT` | secret | salt for the client-IP hash |
| `EZIL_E2E_QA_EMAIL` / `EZIL_E2E_QA_PASSWORD` | variable / secret | a dedicated QA builder for the live E2E |
| `NPM_TOKEN` | secret | publish `@ezilhq/cli` |

## Releasing

1. Bump `packages/cli/package.json` and add the version to `CHANGELOG.md`; merge to `main` and wait for its run.
2. `git tag v<version> && git push origin v<version>`.

## Rotating the gateway secret

Generate a new value, set it on the EZiL Works API and redeploy it, then `gh secret set GIT_GATEWAY_SECRET` here and
re-run the latest `main` workflow. In between, the gateway fails closed (503): no access is granted.

## Rollback

- Gateway: `wrangler rollback <version-id>` in `apps/git-gateway` (CI does this automatically after a failed smoke),
  or remove the Custom Domain to take the hostname offline.
- Hostnames: the three hosts are independent Custom Domains. Taking the `git.ezil.work` alias offline (remove only its Custom
  Domain) leaves `github.ezil.work` untouched; never move a production URL to the alias or to staging as a rollback.
- A bad CLI release: publish a fixed version; `npm deprecate @ezilhq/cli@<bad>` and mark the GitHub release.

## Known limits

- `git-staging.ezil.work` talks to the production EZiL Works API (there is no staging API) with the same HMAC secret;
  its live E2E pushes and deletes a throwaway branch in a QA-tenant repository. Staging isolates gateway code, not data.
- `production` deploys automatically after a green staging run; add a required reviewer to the environment to gate it.
- `/health` is public and reports the deployed commit.
- Binaries are not code-signed (macOS Gatekeeper and Windows SmartScreen may warn when downloaded by a browser).
