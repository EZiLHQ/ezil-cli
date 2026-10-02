# EZiL CLI + Cloudflare Artifacts Git authentication — implementation plan

> Planning only. Nothing here has been implemented. Planning artifact for the peer-requested folder `/data/openclaw/projects/ezil/EZiL CLI/`. Approved 2026-10-01.
> Grounded in EZiL-Works `main @ b258604f` and the Cloudflare Artifacts docs as fetched on 2026-10-01.

## Context

Builders already get Git access to Cloudflare Artifacts. It works, but it isn't normal Git:

- **Paste a token by hand.** The web UI mints a 15-minute repo token (`POST /v1/projects/:projectId/repositories/:repositoryId/token`, `EZiL-Works/apps/api/src/routes/project-repositories.ts:214-254`). The builder then pastes it into a `GIT_CONFIG_*` extraHeader prefix (`apps/web/src/screens/builder/repositories.data.ts:50-61`).
- **Leak account details in the remote.** The remote is `https://<CF_ACCOUNT_ID>.artifacts.cloudflare.net/git/p-<uuid>/source.git`, which exposes the account ID and an opaque namespace.
- **Clone into a generic folder.** Every clone lands in `source/`, because the default repo is literally named `source` (`packages/db/src/repositories/projects.ts:324-325`, `project-repositories.ts:66`).
- **Re-paste every 15 minutes.** No refresh exists. Once the token expires, the next push fails until the builder pastes a fresh one.
- **No logins or revocation.** The CLI (`packages/cli`, Bun) only has `connect`/`hook`/`flush`. It signs in with email and password, keeps `~/.ezil/credentials` at mode 0600, and has no `login`, `whoami` or credential helper. An issued token can't be revoked, and issuing it writes no audit event unless the builder is acting as someone.

**Goal:** `ezil auth login` → `git clone https://github.ezil.work/<namespace>/<repo>.git` → normal `git add/commit/push`. Git stays stock Git. Identity comes from a git credential helper. Authorization is checked on every Git operation, and no Cloudflare credential ever reaches the client.

## What already exists and gets reused (don't rebuild)

| Need | Reuse |
|---|---|
| Per-task, per-repo authority check | `builderTokenAuthority(...)` in `packages/db/src/repositories/project-repositories.ts:35`: the task assignee, task state, the latest repo selection, production-access expiry, human approval, and an accepted work agreement |
| Project-level check | `builderAssigned(projectId, builderId)` in the same file, `:192` |
| Caller and role check | `caller()` in `apps/api/src/routes/project-repositories.ts:51`, `builder()` in `task-repository-selections-v1.ts:24` |
| Act-as | `requestIdentity(ctx)` and `delegatedRequest` (`apps/api/src/auth/delegation.ts`), `withDelegation` (`packages/db/src/repositories/delegation.ts`) |
| Minting Artifacts tokens | `apps/api/src/artifacts/adapter.ts` (`POST .../namespaces/$NS/tokens {repo, scope, ttl}`), and the token route's pattern: lifetime capped by authority, authority re-checked after the provider call, `no-store` |
| Audit | `withAudit` (`packages/db/src/with-audit.ts:98`), `appendAuditEvent`, `withAuditAttribution`. The hash-chained `ezil_works.audit_events` has a free-form `payload jsonb`, so correlation IDs go in the payload and no schema change to the chain is needed. Use `make_append_only()` for any new ledger table. |
| Push to downstream worker | Already wired: `push-subscriptions.ts` (`artifacts.repo` `pushed` → Queue) → `apps/valuator-events` → `/internal/repository-push-events` → source import / evaluation. The proxy forwards to the same Artifacts repo, so this path is unchanged. |
| Internal HMAC between services | `signedRequest` (valuator-events) / `REPOSITORY_PUSH_SECRET` pattern |
| CLI scaffolding | `packages/cli` (`bin/ezil.ts`, `credentials.ts`, `redact.ts`) |
| JWT verify (web/OS → API) | `verifySupabaseToken` + `principalFromToken` (`apps/api/src/auth/verify.ts:121`, `principal.ts:95`) |

## Architecture (minimal)

```
git (stock) ──► github.ezil.work  [new Worker: apps/git-gateway]
   ▲                │  1. Basic auth password = EZiL git grant (opaque, ≤15 min)
   │                │  2. POST /internal/git/authorize (HMAC) ──► apps/api (Vercel)
   │                │       grant valid? not revoked? builderTokenAuthority(repo)?
   │                │       service → scope (upload-pack=read, receive-pack=write)
   │                │       mint Artifacts token (exact scope, ttl 600s) via adapter.ts
   │                │       audit git_operation.authorized|denied
   │                │  3. stream request to the exact Artifacts `remote` + Bearer
   │                ▼
   │          <acct>.artifacts.cloudflare.net/git/<artifacts-ns>/<artifacts-repo>.git
   │                │  pushed event → existing Queue → valuator-events → API (unchanged)
ezil git-credential ◄── ezil CLI (CLI session in OS keychain) ──► apps/api /v1/cli/*
```

### Decisions and why

1. **Use a proxy Worker, not a CNAME.** Artifacts documents no custom hostname, and the remote is a host Cloudflare owns. So `github.ezil.work` has to be a Worker Custom Domain that proxies smart HTTP. It buys:
   - a branded, stable URL with no account ID in it;
   - authorization on every request;
   - instant revocation;
   - per-operation audit;
   - Artifacts tokens that never leave the server side.

   *Rejected alternative:* `url.insteadOf` written by `ezil auth login` to rewrite `github.ezil.work` to the Artifacts host, with no proxy at all. It needs no new service, but Artifacts tokens still reach the client, the account ID still leaks, there's no per-operation authorization or audit, and Git clients without the CLI config break in confusing ways. Keep it only as an emergency rollback (Phase 7).
2. **The git credential is an EZiL grant, not an Artifacts token or a Supabase JWT.**
   - Supabase JWTs aren't bound to an audience. Any `authenticated` token from the project is accepted (`apps/api/src/env.ts:155-160`), so they must never be accepted at the Git edge.
   - The grant is opaque, random and 256 bits, stored only as a hash. It's bound to builder, CLI session, repo and maximum scope, and lasts ≤15 minutes (the same cap as today).
   - Git doesn't tell credential helpers whether it's about to read or push. So the grant carries the *maximum* allowed scope, and the proxy turns the Git service into the *exact* Artifacts scope it mints.
3. **CLI sessions are EZiL-issued and narrow.** Reusing Supabase refresh tokens in the CLI was rejected. They're full-account and long-lived, can't be listed or revoked per machine, and need a password prompt in a terminal.
   - A CLI session issues 15-minute access tokens plus a rotating refresh token, and reuse of an old refresh token revokes the whole session.
   - Its tokens are valid only on `/v1/cli/*` (whoami, grant issue, logout, session list), never on the general `/v1/*` API.
4. **Fix the "source" problem with a route name, not a rename.** Artifacts has no rename API, so existing repos keep their Artifacts name. A new `route_name` column carries the real repo name, and new projects create the Artifacts repo under the real name from the start. Git uses the URL's last path segment as the clone folder, so `<repo>.git` clones into `<repo>/`.
5. **Things that are not needed:**
   - an OAuth or OIDC server;
   - Durable Objects, KV or a revocation list (the proxy asks the API on every operation);
   - a new audit system;
   - a GitHub App;
   - Workers Artifacts bindings (one binding per namespace can't follow per-project `p-<uuid>` namespaces; minting stays in the API through the REST adapter);
   - LFS.

## Components and concrete changes

### A. Data (EZiL-Works `packages/schema/src`, `packages/db/src/schema.ts`)
- `project_repositories.route_name`: a slug (`^[a-z0-9][a-z0-9._-]{0,99}$`), unique within the project's route namespace. Backfill existing rows (`source` → the project's slug, or keep `source` where the project has no slug). It's the URL segment and nothing else; the Artifacts `name` doesn't change.
- `projects.route_namespace`: a slug, unique and immutable once a repo exists. The default comes from a decision (D1).
- `cli_sessions`:

  | Column | What it holds |
  |---|---|
  | `id`, `public_id`, `account_id` | identity |
  | `device_label`, `os`, `cli_version` | what the device is |
  | `created_at`, `last_used_at`, `revoked_at`, `revoke_reason` | lifecycle |
  | `refresh_hash`, `refresh_family`, `refresh_generation` | refresh rotation |
  | `created_ip_hash` | first-seen IP, stored as a hash |

  Mutable columns are limited to the refresh fields, `last_used_at` and revocation. Rows are never deleted.
- `git_grants`: `id`, `public_id`, `cli_session_id`, `account_id`, `project_id`, `repository_id`, `task_id`, `max_scope (read|write)`, `token_hash`, `issued_at`, `expires_at`, `revoked_at`. Append-only except `revoked_at`.
- One-time **login codes**, for the browser loopback flow and the device-code fallback: `cli_login_requests` with `code_hash`, `pkce_challenge`, `state`, `expires_at` (5 min), `approved_account_id` and `consumed_at`.

### B. API (EZiL-Works `apps/api`, Hono on Vercel)
New module, `routes/cli.ts`, registered in `routes/manifest.ts`:
- `POST /v1/cli/login/start` and `GET /v1/cli/login/poll`: the device-code fallback for headless machines.
- `POST /v1/cli/login/approve`: needs a **Supabase web session**. The builder approves the code in `app.ezil.work/cli/approve`.
- `POST /v1/cli/token`: the PKCE code exchange, plus `grant_type=refresh_token` with rotation and reuse detection.
- `GET /v1/cli/whoami`: account, role, active CLI session and device, the tasks with Git access, and each `github.ezil.work` URL.
- `POST /v1/cli/git-grant {host, path}`. It:
  1. parses `<ns>/<repo>.git`;
  2. resolves the repository by `route_namespace`/`route_name`;
  3. computes max scope from `builderTokenAuthority` (write when the task is writable, else read; operations evaluators get read-only through the existing `evaluator` purpose);
  4. issues the grant, with expiry = min(15 min, authority expiry, CLI-session expiry);
  5. writes the audit event `git_grant.issued`.

  It returns `{username:"ezil", password:<grant>, expires_at}`.
- `POST /v1/cli/logout` and `GET`/`DELETE /v1/cli/sessions[/:id]`: revoking a session cascades to its live grants.
- `POST /internal/git/authorize`: HMAC-signed and reachable only from the gateway, using a new secret `GIT_GATEWAY_SECRET` in the same scheme as `REPOSITORY_PUSH_SECRET`.
  - Input: `{grant, routeNamespace, routeName, service, requestId, cfRay, ipHash, refUpdates?}`.
  - Re-checks: the grant hash, expiry, revocation, the CLI session's state, and **live** `builderTokenAuthority` for that repository (so a task closing, approval lapsing or a staffing change takes effect at the next Git operation).
  - Requires scope = read for `git-upload-pack`, write for `git-receive-pack`.
  - Mints an Artifacts token with that exact scope and `ttl: 600` through `adapter.ts`. Never omit the scope: Artifacts defaults to **write**.
  - Writes the audit event `git_operation.authorized|denied`.
  - Returns `{artifactsRemote, artifactsToken}`, or 401 (re-authenticate) or 403 (forbidden).
- Refactor: move the authority and deadline logic from `project-repositories.ts:214-254` into a shared `services/repository-access.ts`, used by both the existing token route and `git-grant`/`authorize`, so the two can't drift apart. Add the missing audit event (`artifacts_token.issued`) to the existing web token route while doing it.
- The repo creation path (`provision()`, `projects.ts:324`, `ensureDefault()`) takes a real name: new projects create their Artifacts repo as `<project-slug>` and set `route_name` to the same value.
- **Leave the existing `remote` field and `project_repositories.remote` exactly as they are** (the raw Artifacts URL). Three consumers depend on it:
  - EZiL-OS calls the token route (`works-launch/CONTRACT.md:95-110`) and checks `remote` against a regex (`EZiL-OS/worker/src/task-checkout.ts:48`) before using it with a Bearer extraHeader;
  - `reviewed-source-artifacts-v3.ts:110-112` checks the stored canonical remote;
  - the runner and the brokers use the raw remote.

  Add a new `cloneUrl` field (`https://github.ezil.work/<route_namespace>/<route_name>.git`) to repository and whoami responses for people. Add a regression test showing that EZiL-OS checkout still accepts the token route's response.
- **Route mounting.** The global `/v1/*` Supabase middleware (`apps/api/src/server.ts:104-118`) would reject CLI tokens and unauthenticated login calls. So mount the CLI module at **`/cli/*`**, outside `/v1`, with its own middleware:
  - `login/start`, `login/poll` and `token` need no auth;
  - `login/approve` keeps the Supabase verifier;
  - `whoami`, `git-grant`, `logout` and `sessions` take a CLI access token through a new `verifyCliToken` (hashed lookup, session not revoked).

  `/internal/git/authorize` uses HMAC only. Add tests that each route is reachable with its intended credential and refused with any other. (Below, `/v1/cli/...` means `/cli/...`.)
- **How a grant picks its task.** The input is only `{host, path}`. The repo comes from (`route_namespace`, `route_name`); both are unique, so no cross-namespace ambiguity. The task is chosen like this:
  1. Gather the builder's open tasks (`pending`/`running`) whose **latest** repository selection includes this repo and that pass `builderTokenAuthority`. Exactly one → bind it, with `max_scope` = write.
  2. More than one → bind the one with the latest `expiresAt` from its authority, so the longest-lived authority wins. Record every candidate task ID in the audit payload. Authority is re-checked at every operation, so picking the "wrong" one of two valid tasks can't widen access.
  3. None writable, but `builderAssigned(project, builder)` holds → **read-only** grant, with `task_id` null and reason `project_staffing`. Configurable; the default is on.
  4. Nothing → 403 `no_access`, plus the audit event `git_grant.denied`.

### C. Git gateway Worker (new: `EZiL-Works/apps/git-gateway`, Wrangler, Workers Paid)
- **Hostname.** Custom Domain `github.ezil.work` on the `ezil.work` zone, which must sit in the same Cloudflare account as the Worker; check this in Phase 0.
- **Allowlist only these routes.** Everything else gets 404, so there's no REST passthrough and no repo browsing:
  - `GET /<ns>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack`
  - `POST /<ns>/<repo>.git/git-upload-pack`
  - `POST /<ns>/<repo>.git/git-receive-pack`
- **Auth.** Without `Authorization: Basic`, answer 401 with `WWW-Authenticate: Basic realm="EZiL Git"` so Git calls the credential helper.
  - Call `/internal/git/authorize`, with a 5-second timeout and fail-closed.
  - Cache allow decisions per `(grant, repo, service)` in the isolate for at most 60 seconds, so one clone doesn't cost one authorize call per request. Never cache denials, so a fixed permission works at once.
- **Forwarding.**
  - Strip the client's `Authorization`, `Cookie` and `X-Forwarded-*` headers.
  - Set `Authorization: Bearer <artifactsToken>`.
  - Forward `Git-Protocol` (v2 for upload-pack; receive-pack is v1-only, so let the client negotiate).
  - Stream request and response bodies untouched. Keep `Content-Type`, `Content-Encoding` and caching headers. Never buffer.
- **Push correlation.** Order matters: **authorize the grant first** (so an unauthenticated client never makes the Worker read a body). Then, for `git-receive-pack`, read only the leading pkt-lines up to the flush packet: these are the `<old> <new> <ref>` commands, at most a few KB. Rebuild the upstream body as that prefix + the rest of the stream, with no `tee()` and no buffering of the pack. Git always sends `GET info/refs?service=git-receive-pack` before the push POST, so the POST normally arrives with an allow already cached from that GET. If it doesn't, the POST is authorized first. Then the prefix is read, and the `refUpdates` go to `/internal/git/annotate`, a non-blocking HMAC call that adds them to the operation's audit row.

  The audit row records the exact ref and the before and after SHAs. Optional ref policy can sit at the same point, for example refusing force-pushes or deletes of the default branch.
- **Logging.** Log request ID, cf-ray, grant public ID, repo, service, status, bytes and duration. **Never** log Authorization values or grant plaintext; reuse the `redact.ts` patterns. Workers Logs and Logpush stay on, with a field allowlist.
- **Limits.**
  - A push is one request body, so it's capped by the zone plan's body limit (100 MB on Free/Pro, 200 MB on Business, 500 MB on Enterprise). Document this; very large imports go through the API's existing server-side `import`/provision path.
  - Rate-limit per grant and per IP-hash, with the Workers rate-limit binding.

### D. CLI (EZiL-Works `packages/cli`)
- **New commands:**

  | Command | What it does |
  |---|---|
  | `ezil auth login [--device]` | browser loopback with PKCE by default; `--device` uses device codes for SSH or headless machines |
  | `ezil auth logout [--all]` | logs out, then removes the stored credential locally |
  | `ezil auth status` / `ezil whoami` | shows who you're logged in as |
  | `ezil auth sessions [revoke <id>]` | lists or revokes sessions |
  | `ezil git-credential <get\|store\|erase>` | the Git credential-helper protocol |
  | `ezil clone <task-or-repo>` | optional sugar for plain `git clone` |
- **What `ezil auth login` configures, written idempotently and shown to the user:**
  ```
  git config --global credential.https://github.ezil.work.helper ""          # reset other helpers for this host
  git config --global --add credential.https://github.ezil.work.helper "!ezil git-credential"
  git config --global credential.https://github.ezil.work.useHttpPath true   # per-repo grants
  ```
  The empty first helper stops osxkeychain or GCM from storing grants. The helper returns `password_expiry_utc` (Git 2.41 and later), so Git never reuses a dead grant. `store` and `erase` are no-ops, apart from dropping the in-memory copy.
- **Secure storage.** Store the refresh token in the OS keychain:
  - macOS: `security add-generic-password`;
  - Windows: Credential Manager through PowerShell `CredentialManager`/`cmdkey`;
  - Linux: `secret-tool` (libsecret).

  If no keychain is available, fall back to `~/.ezil/credentials` at mode 0600 with a visible warning, using the existing `credentials.ts`. Access tokens stay in memory only.
- **Packaging.** Today it's `bin/ezil.ts`, which needs Bun. Ship `bun build --compile` binaries for darwin-arm64/x64, linux-x64/arm64 and windows-x64. Use a signed manifest with checksums, an `install.sh`/`install.ps1`, and an `ezil update` command.
- **Interop.** The helper works for EZiL-OS sandboxes too: OS can keep calling the Works token route (`works-launch/CONTRACT.md:95-110`), or later move to a CLI-session-per-sandbox. That's out of scope here.

### E. Web (EZiL-Works `apps/web`)
- `/cli/approve`: the approval page for device and loopback codes. It shows the device label, OS, CLI version and approximate location.
- Settings → "Signed-in devices": list and revoke sessions.
- Builder assignment (`screens/builder/assignment.tsx:514-516`, `repositories.data.ts`): replace the paste-a-token prefix with `ezil auth login` + `git clone https://github.ezil.work/<ns>/<repo>.git`. Keep the manual-token path behind a "no CLI" disclosure until Phase 7.

### F. DNS / routing
- `github.ezil.work` → a Worker Custom Domain, which creates a proxied DNS record automatically. Earlier notes say `ezil.work` A records stay unproxied and wrangler can't manage DNS. A Custom Domain needs the zone on Cloudflare in the same account; if that's not the case, it's a blocker (B2).
- TLS: Cloudflare edge certificate. HSTS on. Only `/…/info/refs`, `git-upload-pack` and `git-receive-pack` are served; the apex path gets a short help page linking to the docs.
- Naming risk: "github.ezil.work" suggests GitHub, which risks trademark trouble and confuses people. Per D2, `github.ezil.work` is canonical (as the requested UX says) and `git.ezil.work` is an alias Custom Domain on the same Worker.

## Security model

- **What lives where:**
  - Client: a CLI refresh token (keychain), a 15-minute CLI access token (memory), and a ≤15-minute git grant (handed to Git per command).
  - Server only: Cloudflare API token, account ID, Artifacts tokens.
- **Revocation works at the next Git operation, which is the strongest guarantee here:**
  - `auth logout`, `sessions revoke`, an operations kill-switch, account suspension, task close or reassignment, or approval expiry → the next `authorize` call fails.
  - An Artifacts token that's already minted lives ≤600 s, but it only ever exists server-side inside one proxied request.
- **Refresh rotation:**
  - Every refresh rotates the token, and reuse of an old one revokes the whole session and writes `cli_session.refresh_reuse_detected`.
  - Absolute session lifetime is 30 days (D3) and the idle timeout is 7 days.
- **Machine trust:**
  - Each session records device label, OS, CLI version, a first-seen IP hash and `last_used_at`.
  - Approval in the browser needs an active web session (MFA wherever the web requires it).
  - Optional later: bind sessions to a device key with DPoP-style signed requests. It isn't needed for v1.
- **Scope:** read and write are enforced per Git service, and the Artifacts scope is minted for that exact service. Read-only builders and operations evaluators can never push.
- **Act-as:** operators using `x-ezil-act-as-session` can't create CLI sessions in v1. The audit rule requires every grant to name a real builder session. This is decision D4.

## Audit evidence (in `audit_events.payload`, using the existing `withAudit`)

| event_type | subject | Key payload fields |
|---|---|---|
| `cli_session.created` / `.refreshed` / `.revoked` / `.refresh_reuse_detected` | cli_session | account, device, cli_version, reason |
| `git_grant.issued` / `.revoked` | git_grant | cli_session, account(builder), project, task, repository, route path, max_scope, expires_at |
| `git_operation.authorized` / `.denied` | repository | grant, cli_session, builder, task, project, repo, service, scope, artifacts_token_id, artifacts_token_expires_at, request_id, cf_ray, ip_hash, ref_updates[{ref,old,new}], deny_reason |
| `artifacts_token.issued` (existing web route) | repository | purpose, scope, expiry, delegation |
| existing push ingest (`/internal/repository-push-events`) | repository | add `correlated_operation_id`, matched on repo + `after` SHA + ref against `git_operation.authorized.ref_updates` |

That gives one chain from builder → CLI session → grant → operation (with request ID and cf-ray) → Artifacts token ID → the pushed event → the downstream import or evaluation.

**Volume control.** `audit_events_seal` serializes every insert into the gapless chain, and IDE auto-fetch (VS Code fetches every 180 s per repo) would flood it. So:
- **Always audit:** every `receive-pack`, every denial, and every grant issue or revocation.
- **Audit `upload-pack` once per grant:** the first fetch or clone under a grant. Later reads under the same grant only update a counter (`git_grants.read_ops`, `last_read_at`) and Workers metrics.
- The isolate allow-cache (60 s) also stops one clone, which makes 2–3 HTTP requests, from producing several authorize calls and Artifacts mints.

## Failure modes and abuse cases (design response)

- **Expired grant mid-push:** the grant is checked only at request start, and the Artifacts token TTL of 600 s covers a long upload. Git calls the helper again for the next command.
- **API down or slow:** the gateway fails closed with 503 and `Retry-After`, and the helper shows a clear message. Reads are not cached on failure.
- **Artifacts outage, or 2,000 requests per 10 s per repo:** pass the 5xx/429 through and record `git_operation.upstream_error`. The product is in closed beta with no SLA, so that's a known risk.
- **Push larger than the zone's body limit:** clear 413 text (pushed through `remote:`-style messaging if possible) with a link to the import path.
- **Leaked grant:** ≤15 minutes, bound to one repo, revocable at once through the session. Hashed at rest.
- **Leaked refresh token:** rotation and reuse detection, plus the per-device list and revoke.
- **Stolen laptop:** revoke the device from the web.
- **Path tricks** (`..`, encoded slashes, extra suffixes, case folding): use strict regex routing and lowercase before lookup.
- **Credential confusion:** never accept Supabase JWTs or Artifacts tokens at the gateway, only `Basic` with a grant. The `ezil` username is ignored.
- **Brute force:** per-IP-hash rate limits and a 256-bit grant.
- **Host header or SSRF:** the upstream URL comes only from the API response (`artifactsRemote`) and is checked against `^https://[0-9a-f]{32}\.artifacts\.cloudflare\.net/git/`.
- **Logging leaks:** redaction tests cover the helper's stdout/stderr, gateway logs and API logs. `GIT_TRACE`/`GIT_CURL_VERBOSE` users are warned by the CLI docs, since Git itself redacts Authorization in curl traces.

## Phases (ordered; each has acceptance criteria)

**Phase 0: verify assumptions (blockers first).**
- Confirm Artifacts is available on the account, with no closed-beta limits on token minting.
- Confirm the `ezil.work` zone is in the same account and that a Custom Domain can be created.
- Confirm the zone plan's body limit.
- Confirm Git ≥2.41 on target builder machines (for `password_expiry_utc`; older Git still works without it).
- Decide D1–D4.
- *Accept:* a written check for each item, plus the decisions recorded.

**Phase 1: data and the shared access service.**
- Migrations: `route_namespace`, `route_name` (with backfill), `cli_sessions`, `cli_login_requests`, `git_grants` (with `make_append_only` where it applies).
- Extract `services/repository-access.ts`, and add the `artifacts_token.issued` audit to the existing route.
- *Accept:* migrations apply on a branch DB; the existing token-route tests pass unchanged; a new unit test proves the shared deadline is the minimum of 15 minutes, the entitlement and the delegation; the audit row is written.

**Phase 2: CLI auth API and CLI login.**
- `/v1/cli/login/*`, `/token`, `/whoami`, `/logout`, `/sessions`; the web `/cli/approve` page.
- CLI `auth login|logout|status|sessions` and `whoami` with keychain storage.
- *Accept:*
  - login works through the loopback and through `--device`;
  - `whoami` shows the builder and their tasks;
  - refresh rotates the token, and reusing an old refresh token revokes the session;
  - logout revokes on the server and wipes the keychain;
  - CLI tokens are refused on non-`/v1/cli/*` routes (negative test).

**Phase 3: grants and authorization.**
- `/v1/cli/git-grant` and `/internal/git/authorize`, with the HMAC, a live authority re-check, exact-scope minting, and the audit events.
- *Accept:* load check of 50 builders × 3 repos with 180-second auto-fetch for 1 hour against staging. It must show at most 1 audit row per grant for reads, authorize p95 under 300 ms, and no lock waits on `audit_events_seal` over 100 ms. Plus unit and integration tests for:
  - allow when the repo is in the task selection;
  - task binding: one task, several tasks (latest authority wins, all candidates in the audit), and staffing-only read;
  - deny when the repo isn't in the selection;
  - deny on a read grant plus receive-pack;
  - deny once the session is revoked;
  - deny once the task is closed;
  - deny after the grant expires;
  - Artifacts scope always explicit;
  - no secret in any logged line.

**Phase 4: the gateway Worker.**
- `apps/git-gateway`, with the route allowlist, Basic-auth challenge, streaming proxy, receive-pack command sniffing, rate limits and redacted logs.
- Deploy to a staging hostname (`git-staging.ezil.work`) first.
- *Accept:*
  - with real Git against staging: `info/refs` returns a 401 challenge, then 200 after the helper;
  - protocol v2 fetch works;
  - a push over v1 works;
  - a 50 MB push streams through;
  - a test over the size limit returns a clear 413;
  - every path outside the allowlist returns 404.

**Phase 5: credential helper and clone naming.**
- `ezil git-credential`, the git config writer, and the `route_name` remote in API responses and the builder UI.
- New projects create repos with real names.
- *Accept:*
  - `git clone https://git-staging.ezil.work/<ns>/<repo>.git` with no token pasted creates a `<repo>/` folder;
  - push works with no further prompts;
  - after 16 minutes the next `git push` succeeds through a fresh grant;
  - no grant is stored by osxkeychain or GCM.

**Phase 6: end-to-end (staging, then production) and the pushed-event correlation.**
- *Positive:* install the compiled CLI on a fresh macOS, Linux and Windows machine → `ezil auth login` → `ezil whoami` → `git clone https://github.ezil.work/<ns>/<repo-a>.git` → check the folder name is `<repo-a>` → commit → `git push` → check the Artifacts head with `head-verifier.ts` → check that `valuator-events` delivered the push and that the API's push ingest ran source import or evaluation for that SHA → check that the `git_operation.authorized` row and the push ingest row share a correlation ID.
- *Negative:* the same builder clones or pushes `<repo-b>`, a repo in the same project that isn't in their task selection, and gets 403 with `git_operation.denied` (reason `repo_not_selected`). Also cover:
  - a read-only builder pushing to repo-a gets 403;
  - after `ezil auth logout`, pushing gets 401 and the helper asks for login;
  - an operations kill-switch revoking all sessions blocks the next push.
- *Test fixtures:* a dedicated test builder account, a project with two repos, and one task whose selection includes only repo-a. Reuse the E2E account conventions in `EZiL-OS/app/.env` (`EZIL_E2E_EMAIL`) and watch the email daily cap noted in memory.
- *Accept:* both suites green in CI against staging, plus one recorded production run.

**Phase 7: rollout and rollback.**
- Turn the new path on with a feature flag: `cli_git_gateway_enabled` per project, then globally.
- Keep the manual-token route and UI disclosure for 30 days.
- *Rollback options:*
  - turn off the flag, so the UI shows raw remotes and the manual token path again;
  - remove the gateway Custom Domain;
  - as an emergency fallback, have the CLI write `url.insteadOf` to the raw Artifacts remote, using the existing token route.
- Grants and sessions revoke on their own; no data migration needs undoing, because `route_name` is additive.
- *Accept:* a documented rollback drill on staging.

## Test-user setup (Phase 6 fixtures; staging first)

Build every fixture through the real API paths, not raw SQL inserts, so the same checks a real builder passes also apply here.

1. **Accounts.**
   - Builder A, write access: `e2e+git-a@ezil.work`, with role `builder`.
   - Builder R, read-only: `e2e+git-r@ezil.work`.
   - Operator O: an existing operations account.

   Create them through the normal signup or ops invite path. Watch the 5-per-day email cap noted in memory, and reuse these accounts across runs rather than creating new ones.
2. **Project.** Operator O creates project `e2e-git-gateway`, with `route_namespace = e2e-git-gateway`.
3. **Repos.** Create two through `POST /v1/ops/projects/:projectId/repositories` and `.../provision`: `repo-a` and `repo-b`, with `route_name` set to the same values. `provision()` also creates the push subscription.
4. **Staffing.** Staff Builder A on the project, so `builderAssigned` is true.
5. **Task.** Create task T1, assigned to Builder A, in state `pending`/`running`. Its latest repository selection (`task-repository-selections-v1`) contains **only repo-a**.
6. **Authority prerequisites.** These make `builderTokenAuthority` pass:
   - the work agreement is accepted;
   - `builder_task_human_approved` is set;
   - `builder_production_access_until` is ≥24 h in the future.
7. **Read-only case.** Builder R is staffed on the project but has no task. Under the task-binding rule, step 3, R gets a read-only grant.
8. **Teardown.** End T1 and the staffing, and revoke all CLI sessions for A and R. Don't delete repos; archive the project.
9. **Seeding script.** Put this in `EZiL-Works/tools/e2e/seed-git-gateway.ts`, run idempotently with operator credentials taken from the environment, never written into the repo.

**The cases these fixtures exercise:**
- A clones and pushes repo-a: allowed.
- A clones or pushes repo-b: 403, `repo_not_selected`.
- R clones repo-a: allowed, read.
- R pushes repo-a: 403, `scope_read_only`.
- After T1 is closed, A pushes repo-a: 403, `authority_lapsed`.
- After `ezil auth logout`, A pushes: 401, and the helper asks A to log in.

## Deployment and DNS runbook for github.ezil.work

1. **Phase 0 checks.**
   - `wrangler whoami` → the account ID matches the one that owns Artifacts (`CLOUDFLARE_ACCOUNT_ID` in the API environment).
   - Confirm `ezil.work` is a zone in that same account: `GET /zones?name=ezil.work`.
   - Record the zone plan, which sets the body limit.
2. **Worker config.** `EZiL-Works/apps/git-gateway/wrangler.jsonc`:
   ```jsonc
   {
     "name": "ezil-git-gateway",
     "main": "src/index.ts",
     "compatibility_date": "2026-10-01",
     "routes": [
       { "pattern": "github.ezil.work", "custom_domain": true },
       { "pattern": "git.ezil.work", "custom_domain": true }
     ],
     "vars": { "API_ORIGIN": "https://<works-api-host>" },
     "observability": { "enabled": true },
     "unsafe": { "bindings": [{ "name": "RL", "type": "ratelimit", "namespace_id": "<id>", "simple": { "limit": 120, "period": 60 } }] },
     "env": {
       "staging": {
         "routes": [{ "pattern": "git-staging.ezil.work", "custom_domain": true }],
         "vars": { "API_ORIGIN": "https://<staging-api-host>" }
       }
     }
   }
   ```
3. **Secrets.** `wrangler secret put GIT_GATEWAY_SECRET` on both staging and production. Put the same value in the API's Vercel environment, marked sensitive. The gateway holds **no** Cloudflare API token.
4. **DNS.** A Custom Domain creates the proxied DNS record and edge certificate itself, so no manual record is needed. Remove any old record for that name first, because a conflicting A or CNAME record blocks the Custom Domain. Earlier notes say the existing `ezil.work` A records stay unproxied; leave them alone.
5. **Order.**
   1. Deploy the API changes behind `cli_git_gateway_enabled = false`.
   2. Deploy the gateway to staging.
   3. Run Phases 4–6 on staging.
   4. Deploy the gateway to production.
   5. Turn the flag on for `e2e-git-gateway`.
   6. Run the production E2E.
   7. Roll out to projects one at a time.
6. **Rollback.**
   - Turn off `cli_git_gateway_enabled`; the UI shows raw remotes and the manual token path again.
   - `wrangler deployments rollback` for a bad gateway build.
   - Removing the Custom Domain takes the hostname offline.
   - Rotating `GIT_GATEWAY_SECRET` invalidates the gateway at once.

## Observability

- **Gateway metrics:** requests by service and status, authorize latency (p50/p95), upstream latency, bytes, 401/403/429/413/5xx rates.
- **Artifacts GraphQL:** `artifactsEventsAdaptiveGroups` for cross-checking.
- **API:** the rate of `git_operation.denied` by reason, and refresh-reuse alerts.
- **Dashboards and alerts:** alert on authorize-call errors above 1% and on any `refresh_reuse_detected` event.
- **Audit chain:** `verify_audit_chain()` in a nightly job (it exists; schedule it).

## False assumptions and unnecessary components (callouts)

- **A custom domain can't point straight at Artifacts;** there's no documented support, so a proxy Worker is required.
- **Renaming Artifacts repos isn't possible** (no API); the fix is a route alias.
- **The Supabase JWT isn't a safe Git credential,** because its audience isn't bound.
- **Credential helpers can't see read vs write;** the gateway decides per Git service.
- **Leaving the Artifacts token scope out means write.** Always pass it.
- **Push is protocol v1 only, partial clone `filter` is unsupported, and there's no LFS.** Document these for builders.
- **Artifacts is still closed beta:** no SLA, and the API could change. Keep the adapter as the one place that touches it.
- **Pushes over the zone's body limit can't go through a Worker.**
- **Not needed:** an OAuth server, Durable Objects, KV, a new audit table, a GitHub App, Workers Artifacts bindings, or per-repo Queue subscriptions beyond the existing `provision()` push binding.

## Decisions needed (with defaults)

- **D0: this conflicts with existing product guidance. Resolve it before Phase 0.**
  - `/data/openclaw/projects/ezil/.firecrawl/ezil-survival-architecture.md:126-127` (from the root PDF "EZiL Survival Architecture") says: *"Do not create github.ezil.work as another user-facing product right now."* It wants builders to go EZiL.Work → project → EZiL OS, with the repository already there and the Git host as an internal detail.
  - This plan is consistent with that only if `github.ezil.work` is a **thin Git endpoint**, not a product surface. That means no browsing UI, no repo pages and no separate signup: the apex just links to docs, and EZiL OS sandboxes stay pre-provisioned through the existing token route.
  - *Default:* build the gateway and CLI as that thin endpoint, for builders working on local machines. Make no change to the EZiL OS flow. The founder confirms that this reading is acceptable.

- **D1 namespace in the URL:** project slug. *Default:* add `projects.route_namespace` from the project name slug; fall back to `p-<publicId>`.
- **D2 hostname:** *Default:* `github.ezil.work` canonical, as the requested UX says, with `git.ezil.work` as an alias Custom Domain on the same Worker. Note the trademark and confusion risk of "github" in the name for the founder to weigh.
- **D3 CLI session lifetime:** *Default:* 30-day absolute and 7-day idle; operations can set it shorter per account.
- **D4 act-as over the CLI:** *Default:* not allowed in v1.

## Blockers

- **B1:** check token-mint rate and quota limits on the account. Artifacts itself is already live here: `apps/valuator-events/README.md` records a live push check on 2026-09-26. It's still closed beta upstream, so there's no SLA.
- **B2:** the `ezil.work` zone must be on Cloudflare, in the same account, for a Worker Custom Domain.
- **B3:** the zone plan's request-body limit, which caps push size.
- **B4:** code-signing and notarisation for the compiled CLI on macOS and Windows; otherwise unsigned-binary warnings appear.
- **B5:** a test builder account and test project with two repos and a task (Phase 6).

## Verification summary
- **Unit and integration tests:** run in `packages/db`, `apps/api` and `packages/cli` with `bun test`, for each phase's acceptance list.
- **Gateway tests:** Workers Vitest pool, plus real-Git tests against `wrangler dev` and staging.
- **E2E:** the positive and negative suites in Phase 6 against staging, then one production run, with the audit chain checked by `verify_audit_chain()`.
- **Security checks:**
  - grep every log sink for `art_v1_`, grant prefixes, `Bearer` and `Basic` (expect zero);
  - confirm `CLOUDFLARE_API_TOKEN` and the account ID never appear in CLI-visible responses.
