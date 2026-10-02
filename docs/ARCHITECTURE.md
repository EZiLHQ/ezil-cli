# Architecture

```
git (stock) ──► github.ezil.work  (apps/git-gateway, a Cloudflare Worker)
   ▲               1. Basic auth password = an EZiL Git grant (egg_…, ≤ 15 min, one repository)
   │               2. POST /internal/git/authorize (HMAC-signed) ──► EZiL Works API
   │                    grant valid · session live · live access to this repository
   │                    git-upload-pack ⇒ read · git-receive-pack ⇒ write
   │                    mints a repository-storage token with exactly that scope (≤ 10 min)
   │               3. streams the request to repository storage with that token
   │               4. for a push: posts the ref updates (ref, old, new) to /internal/git/annotate
ezil git-credential ◄── ezil (device session in the OS keychain) ──► EZiL Works API /cli/*
```

## Components

- **`ezil` CLI (`packages/cli`).** `core` holds the device session (rotating refresh token, short access token,
  single-flight refresh so concurrent git processes never look like token theft), the API client and redaction.
  Built-in modules add commands: `git` (credential helper and the git configuration `ezil auth login` writes) and
  `sessions` (`connect`, `hook`, `flush`: session evidence for EZiL Works). Modules contribute post-sign-in setup steps;
  core never imports a module.
- **Gateway (`apps/git-gateway`).** Serves only the three smart-HTTP endpoints
  (`GET …/info/refs?service=…`, `POST …/git-upload-pack`, `POST …/git-receive-pack`); everything else is 404. It holds
  no repository credential of its own: every operation is authorized by the API, it fails closed (503) when the API is
  unreachable, strips client credentials and cookies, and streams bodies without buffering (a push is read only up to
  its ref commands). It also serves the installers, answers `/cli/latest`, and redirects `/cli/<version>/<file>` to the GitHub release.
- **Contract (`packages/contract`).** Zod schemas for the gateway ⇄ API messages, the `/cli/*` API and session
  evidence. The EZiL Works repository keeps identical copies; both repositories pin the same digests. The pin checks
  each copy against its own constant; compatibility across the two is proven at runtime (the gateway parses every
  authorize answer strictly, and the live E2E parses real `/cli` answers).

## Trust boundaries

| Boundary | Authenticated by | What crosses it |
|---|---|---|
| builder ⇄ API `/cli/*` | device-session access token (Bearer) | sign-in, grant requests, session list/revoke |
| git ⇄ gateway | Git grant (HTTP Basic password) | Git smart-HTTP traffic for one repository |
| gateway ⇄ API `/internal/git/*` | HMAC-SHA256 over `timestamp.body`, 5-minute window | grant + route + service → allow/deny; ref updates |
| gateway ⇄ repository storage | short-lived, exactly-scoped token from the API | the proxied Git request |
| browser ⇄ API `/cli/login/describe|approve` | the EZiL web session | showing, then approving, a device code |

Every decision is made by the API per operation, so revocation, a closed task or lost access applies to the very
next fetch or push, and every operation is audited by the API (who, which device, which repository, which service,
and for pushes the exact refs and SHAs).

## Sign-in

`ezil auth login` starts a device login and prints a code. The person opens `app.ezil.work/cli/approve`, which shows
the device name, OS and how long ago the request started before offering approval. The CLI polls until approved and
stores the session. Login starts are rate-limited per client.

## Session evidence

`ezil connect` installs Claude Code hooks that append one redacted event per prompt, tool call and result to a local
spool (`.ezil/spool/`); `ezil flush` sends batches to EZiL Works. The hooks never write to stdout, always exit 0 and
never touch the network, so they cannot interrupt the work. Prompts are sent as a digest plus a short redacted opening,
never verbatim; tool output only as short redacted excerpts; file paths but never file contents. The schemas are
strict, so a producer that adds a field (for example a verbatim prompt) is refused rather than stored, and the server
refuses any batch that still looks like it carries a credential.

This evidence comes from the worker's own machine, so it can only ever count as *worker runtime evidence*: a test pass
recorded here is the worker's claim that their run went green, never an independent test pass, which only EZiL's
sandbox produces.

## Releases and installs

A `v*` tag builds standalone binaries (`bun build --compile`) for macOS, Linux and Windows plus `SHA256SUMS`, attaches
them to the GitHub release, installs from `https://github.ezil.work/install.sh` and runs the live E2E with the
installed binary, then publishes `@ezilhq/cli` to npm with provenance (a single Node ES-module bundle).
