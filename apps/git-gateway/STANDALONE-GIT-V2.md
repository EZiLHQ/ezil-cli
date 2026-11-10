# Standalone EZiL Git v2

`/v2/repos`, `/v2/git/grant`, and registered `/default/*.git` routes use EZiL ID and Cloudflare Artifacts directly. Other Git routes keep their existing handler. This source owns no OS release.

## Wire contract

`POST /v2/git/grant` takes `Authorization: Bearer <EZiL ID token>` and JSON `{ "repoURL": "https://github.ezil.work/default/<repo>.git", "scope": "read" | "write" }`.

Its successful response is:

```json
{
  "version": 2,
  "repository": { "id": "<Cloudflare Artifacts provider ID>", "canonicalURL": "https://github.ezil.work/default/<repo>.git", "ref": "refs/heads/main" },
  "identity": { "issuer": "https://id.ezil.work/", "subject": "<verified OAuth subject>" },
  "git": { "username": "ezil", "token": "<opaque repository grant>", "expiresAt": "<ISO 8601 UTC>", "scope": "read" }
}
```

The server verifies RS256 against the fixed EZiL ID JWKS, exact issuer, configured audience, subject, issue time, and expiry. JWKS keys are cached per Worker isolate for five minutes. A write grant requires the repository's registered owner subject. Authenticated users can receive read grants for repositories marked `publicRead`. After checking KV ownership and the actual provider ID, remote, default branch, and writable state, the gateway mints a native Artifacts token for that repository and requested scope. Its TTL is the shorter of 290 seconds and the remaining ID token lifetime minus a ten-second safety margin; a resulting lifetime below Cloudflare's 60-second minimum is refused. A fresh clock is read before minting and after the provider returns. The returned scope must exactly match the request, and its strict ISO UTC expiry must be in the future, within five minutes of validation, and no later than the verified ID expiry. The client keeps the token private in its v2 FD packet. No grant is written to KV and no signing secret is needed.

Native credentials are opaque because the deployed provider format differs from its documented prefix. The gateway does not require a token prefix or embedded expiry. On Git requests it accepts only username `ezil` and 16–8192 ASCII characters from the bounded HTTP Basic-safe token alphabet, limits by hashed IP and token, and forwards the token unchanged to the exact registered Artifacts Git remote over HTTPS without following redirects. Cloudflare enforces its repository, scope, and expiry. Malformed credentials receive a 401 Basic challenge locally. An optional trailing `?expires=<positive safe integer seconds>` is a renewal hint only: an elapsed hint receives the same challenge against a fresh clock. Missing, unknown, or future hints remain opaque and are forwarded unchanged. Changing a hint cannot grant access, extend provider lifetime, or change scope; Cloudflare still validates the entire native credential. Upstream 401 is translated to a renewal challenge, while upstream 403 remains denied, including a valid read credential used to push. A plausible random token can reach the Git upstream under the rate limits, but the gateway never mints a new token or calls the Artifacts binding on a Git request. A native token is a bearer credential, so it is transferable until expiry or revocation and must remain private.

`POST /v2/repos` takes the same bearer and JSON `{ "name": "<repo-name>", "visibility": "private" | "public" }`; omitted visibility means private. It creates `default/u-<first-16-hex-of-SHA256-subject>-<repo-name>` and returns `{ "repoURL", "ref": "refs/heads/main", "providerId" }`. The owner can write; for public repositories, other signed in users can read. A failed registry write after provider creation is reported as unavailable and requires operator reconciliation; it does not claim the repository for another user.

## Existing fixture and deployment preparation

The direct Artifacts fixture is `default/os-code-url-20261110-a`, provider ID `fg1wtcrexaf7acl0`. Its remote is `https://2104e6f103f83b34f363985b093edc7c.artifacts.cloudflare.net/git/default/os-code-url-20261110-a.git`. Direct seed, clone, push, and fresh clone were verified with SHA pair `db0072aa94dd6c4fd99a4fd258094f954075f443` and `e7ee8459719a8050e4ee7e5c5672a38c5f1ffab6`.

Two Cloudflare KV namespaces were created for isolation: staging `9acf3a7f7772446baebbbfd5ddfc3f36` and production `26c715893bab478ca4a1bd5a62f57107`. Staging contains the registered fixture owner; production is empty. The Wrangler config binds each to `STANDALONE_REPOS`, which holds repository ownership only. Both environments' `EZIL_ID_AUDIENCES` contain the verified OS OIDC client ID `2tVk0vvzQvm964BtGuXzQxpjlo2JCoCl` and the public CLI client ID `Mzvm4piCMAKy3ofhywuQDYstJLcYE3mx`. Existing `API_ORIGIN`, `GIT_GATEWAY_SECRET`, `IP_HASH_SALT`, and `RL` bindings and Git/installer routes stay as configured. The existing limiter hashes the Cloudflare client IP with `IP_HASH_SALT` before JWKS, signed grant, or Artifacts work. `CREATE_RL` is a new five repository creations per minute limiter.

The native `ARTIFACTS` binding targets only the `default` namespace in both Wrangler environments. Source uses `create()`, `get()`, `info()`, and `createToken()` and needs no Artifacts account API credential. The binding itself is a namespace capability; the gateway limits its public create path to owner-prefixed names and checks KV ownership and provider identity before token issuance. `create()` returns an initial token, which the gateway discards. Its scope and expiry are set by Cloudflare's binding. The gateway checks the returned native token's scope and expiry before including it in the no-store packet.

Runtime requires the existing `IP_HASH_SALT` secret, `STANDALONE_REPOS` KV, `RL`, and `CREATE_RL` bindings and the explicit `EZIL_ID_AUDIENCES` list. No new account API credential or HMAC signing secret is required or provisioned. The user authorized staging and canonical deployment after review and transport checks. New broad account credentials remain unauthorized; the proposed broad credential and signing secret provisioning was rejected and none were created.

Deploy reviewed commits with the approved wrapper and verify staging transport before canonical rollout. Staging fixture ownership is already registered from the privately verified subject; the registration script refuses overwrites. Obtain a grant at `https://git-staging.ezil.work/v2/git/grant` for the canonical `github.ezil.work` URL; test Git transport directly against `git-staging.ezil.work` with a private temporary credential config. The bundled private clone transport deliberately pins `github.ezil.work`, so its full OS clone test runs only after canonical deployment. Check another signed in user gets read only. Promote only after these checks and a public CLI client review, then register the fixture in production if it is intended to be reachable there. Never enroll it by guessing a subject or using a legacy account identifier. The native binding repository lookup, metadata, disposal, normal OAuth read and write grants, clone, push, and a fresh direct clone have been verified on staging. Commit `61bb9027ffddd95a75cdeef3f2992bbc08f78668` was deployed to staging and the canonical endpoint after those checks.

Repository ownership remains in Cloudflare KV. The native grant needs no KV propagation, so a newly minted grant can be used in another location immediately. New repository creation can still await KV propagation before the first grant; callers should retry that initial lookup if the repository was just created.
