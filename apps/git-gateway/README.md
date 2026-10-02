# git-gateway: github.ezil.work

A thin Git smart-HTTP gateway in front of Cloudflare Artifacts. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).
It has no UI or repository pages; it handles Git transport and authorization.

```
git ──Basic(ezil:egg_…)──► gateway ──HMAC──► Works API /internal/git/authorize
                              │   (grant valid? live task authority? exact scope? audit)
                              └──Bearer art_v1_… (exact scope)──► <acct>.artifacts.cloudflare.net
```

- **Routes.** Only `GET /<ns>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack`
  and `POST /<ns>/<repo>.git/git-upload-pack|git-receive-pack` are served. Everything else gets 404.
- **Credentials.** The client sends an EZiL git grant (`egg_…`, ≤15 min, one repository) from
  `ezil git-credential`. Bearer tokens are refused. A request without credentials gets
  401 + `WWW-Authenticate: Basic`, which is what makes Git call the helper.
- **Authorization.** Every operation is authorized by the EZiL Works API. The gateway fails closed (503) if the API is
  unreachable or answers anything unexpected. Read (fetch/clone) decisions are cached per isolate for at most 5 s. Pushes and denials are
  never cached, so revoking a session or closing a task stops the next push at once.
- **Artifacts tokens.** The token is minted per Git service: read for upload-pack, write for receive-pack.
  It only ever sits inside the upstream request, never in a response or a log.
- **Push correlation.** For a push, the gateway reads the leading `<old> <new> <ref>` commands
  without buffering the pack, and reports them to `/internal/git/annotate`, so the audit row names
  the exact ref and SHAs.
- **Size limit.** One push is one request body. On the `ezil.work` zone's **Free** plan that body is
  capped at **100 MB**. Larger imports go through the server-side Artifacts import path.

## Environment
| Name | Kind | Notes |
|---|---|---|
| `API_ORIGIN` | var | EZiL Works API origin |
| `GIT_GATEWAY_SECRET` | secret | Same value as the API's `GIT_GATEWAY_SECRET`; distinct from every other channel secret |
| `IP_HASH_SALT` | secret | The client IP leaves the edge only as `sha256(salt:ip)` |
| `RL` | rate-limit binding (in `wrangler.jsonc`) | 120/min per grant and per IP hash |

## Test
```
bun test apps/git-gateway                          # unit: routing, auth, fail-closed, cache, streaming, redaction
bun test tests/e2e                                 # stock git → ezil helper → gateway → contract-faithful API → real git server
bun tests/live/live.ts                             # the deployed pair, as the QA builder (needs EZIL_E2E_QA_PASSWORD)
```

## Deploy
CI deploys it (`.github/workflows/ci.yml`): every `main` commit goes to `git-staging.ezil.work`, must report its
commit on `/health` and pass `tests/live`, then goes to `github.ezil.work` + `git.ezil.work`, which must pass the same
smoke or are rolled back. Secrets are bound on the Worker once (`wrangler secret put GIT_GATEWAY_SECRET` and
`IP_HASH_SALT`, per environment) and survive deploys. The Custom Domain creates the DNS record and the certificate.
