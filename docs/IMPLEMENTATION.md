# EZiL CLI + Artifacts Git auth: implementation status

Written for the founder and whoever resumes this work. Updated 2026-10-01 ~18:30Z by native Claude session 9220995a.

> **Update 2026-10-01 (evening):**
> - **Schema live in production.** `cli-git-auth.sql` was applied to `btgqfmnzycdecmeyqubx` with `hosted-rollout.ts`, plan `7e3f33ce…`.
>   - Catalog moved `c0d13708…` → `02a13a4b…`.
>   - The rollout ledger row matches the file hash.
>   - The app role has select/insert/update only, RLS is on, and the anon role has no access.
> - **PR #39** (schema plus the hosted-rollout entry) is merged as `4e9089c3`.
> - **PR #40** (code) is open against `main` for review.
> - **Before applying,** the tables were switched to UUID keys (so no sequence grants are needed), and a 30-per-minute cap was added on login starts.
> - **Wrangler:** this session's OAuth login can't refresh non-interactively. The `.env` `CLOUDFLARE_API_TOKEN` is an active EZiL account token that can read Workers and Custom Domains; it's the path for the gateway deploy.

**Where:**
- Worktree: `EZiL-Works.worktrees/ezil-cli-git-auth`
- Branch: `feat/ezil-cli-git-auth`, from `origin/main @ 49053080`
- State: staged, **not committed, not pushed, not deployed**. Nothing has touched the hosted database.

**Toolchain:** Bun **1.3.14**, the version CI pins. The machine's default Bun is 1.3.1, which installs two copies of `drizzle-orm` and breaks typecheck. A verified 1.3.14 binary is in this session's scratchpad.

## Built (plan sections A–E)

| Area | Files | What |
|---|---|---|
| Schema | `packages/schema/src/cli-git-auth.sql` (+ test), `packages/db/src/schema.ts`, `schema-files.ts`, `.github/production-migrations.json` | Route names on projects and repos, which are immutable once set; `cli_sessions` (rotating refresh plus a hashed access token); `cli_login_requests`; `git_grants` (≤15 min, one repo, scope-shaped). Guard triggers allow only the designated columns to change, and rows can never be deleted or truncated. |
| Shared credential service | `apps/api/src/services/repository-access.ts` (+ test) | One deadline/mint rule for the builder token route and the gateway: explicit scope, provider expiry checked against the deadline. The existing token route now writes `artifacts_token.issued` before handing out a token. |
| DB repository | `packages/db/src/repositories/cli-auth.ts` | Device and loopback login, exchange, refresh with reuse detection (revokes the session), authenticate, revoke (cascades to grants), sessions, issue/resolve grants, lazy Git route assignment (`project-name-<6hex>/<project-name>.git`, so clones land in the real folder, not `source/`). |
| API | `apps/api/src/routes/cli.ts` (+ unit and e2e tests), `env.ts` (`GIT_GATEWAY_SECRET`), `manifest.ts`, `mcp/tools.ts` (digest refresh) | `/cli/login/{device,loopback,approve}`, `/cli/token`, `/cli/whoami`, `/cli/git-grant`, `/cli/logout`, `/cli/sessions[/:id]`, `/internal/git/{authorize,annotate}` (HMAC; live `builderTokenAuthority` on every operation; audit for every authorize and deny). |
| Contract | `packages/contracts/src/surface/git-gateway.ts` (+ test) | The pinned wire format between the gateway and the API, plus the strict path parser. |
| Gateway | `apps/git-gateway/**` | Worker for github.ezil.work: smart-HTTP allowlist, Basic challenge, fail-closed, 60 s allow-cache, streamed proxy, receive-pack ref correlation, rate limit, redacted logs. |
| CLI | `packages/cli/src/git-auth.ts` (+ test), `bin/ezil.ts` | `ezil auth login|logout|status|sessions`, `ezil whoami`, `ezil git-credential`. Storage is the keychain (macOS, Secret Service) or a 0600 file. Refreshes are single-flight, so concurrent helpers can't trip reuse detection. |
| Web | `apps/web/src/screens/builder/cli-approve.tsx`, `routes.ts` | `/cli/approve`, the device-code approval page. |

## Evidence

All of these ran locally, with no network or hosted resources:
- **Schema:** 11 tests. This found and fixed a NULL-passes-CHECK hole in the device-login shape.
- **CLI routes:** 8 tests, covering login, whoami, grants, authorize for fetch and push, an unselected repo, read-only push, cross-repo grant, stranger, task closed, staffing ended, logout, refresh rotation and replay, signatures, and token-type separation.
- **Real-git e2e (1):**
  - Stock `git clone` through the real `ezil git-credential` binary, the real gateway, the real API on PGlite, and a real `git http-backend` standing in for Artifacts.
  - The clone lands in `paid-loop-fixture/`, not `source/`.
  - Push succeeds, and the audit records the ref and the exact SHAs.
  - Pushing an unselected repo is refused as `scope_read_only`.
  - After logout, fetch is refused.
- **Other suites:** gateway 14, CLI 7, contracts 6, credential service 5, existing token routes plus act-as plus audit (green, with the new audit test), MCP pin and manifest 34.
- **Mutation checks:**
  - Removing the read-only push guard fails 2 tests.
  - A wrong upstream bearer fails the e2e (`fatal: Authentication failed`).
- **Typecheck:** clean across every package.
- **CI gate (`./tools/ci-test-gate.sh`):** see the result recorded at the end of the session.

## Deviations from the plan

- **No read counters.** Under the repo's "every write is audited" invariant, a read counter is itself an audited write, so every authorize call is audited instead. Volume stays bounded by the gateway's 60 s allow-cache, at under 1 row/s for 50 builders × 3 repos.
- **Device login only in the CLI.** `ezil auth login` uses the device flow and opens the browser automatically. The API also supports PKCE loopback, but the CLI doesn't use it yet.
- **Task binding takes the first candidate.** When several tasks qualify, the grant binds the first one `builderTokenAuthority` returns, rather than the one with the latest expiry. Authority is re-checked on every operation, so this can't widen access.
- **No Azure workers.** The Azure worker launcher produced no output twice (`/usr/bin/codex` silent, also confirmed by a separate QA session). The coordinator built the gateway directly; no other provider was used.

## Not done, and gated on the founder

1. **Decision D0:** confirm github.ezil.work as a thin Git endpoint only (the survival-architecture doc advises against a user-facing product).
2. **Commit and PR:** review this branch.
3. **Hosted DB rollout:** apply `cli-git-auth.sql` via the production-migrations flow (Supabase CLI, never `db push`). The manifest only registers the file; a hosted-rollout entry with catalog digests is still needed.
4. **Secrets:**
   - `GIT_GATEWAY_SECRET`: at least 32 characters, distinct from every other channel secret. It goes in both the API (Vercel) and the gateway (`wrangler secret put`).
   - `IP_HASH_SALT`: gateway only.
5. **Deploy:**
   - The API (with the flag off, or simply unused until DNS exists).
   - `wrangler deploy --env staging` for the gateway. `wrangler login` has expired on this host.
   - Custom Domain `git-staging.ezil.work`, then `github.ezil.work`.
6. **Staging E2E:** follow PLAN.md "Test-user setup", with real Artifacts and real git. The zone is on the Free plan, so pushes are capped at 100 MB.
7. **CLI distribution:** `bun build --compile` binaries, signing and notarisation (blocker B4), and an install script.
8. **Notion task:** its automation re-blocks the task because the "EZiL Work / app.ezil.work" project has no allowlisted Coder project ID.
