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

The server verifies RS256 against the fixed EZiL ID JWKS, exact issuer, configured audience, subject, issue time, and expiry. JWKS keys are cached per Worker isolate for five minutes. A write grant requires the repository's registered owner subject. Authenticated users can receive read grants for repositories marked `publicRead`. HMAC-signed `eg2_` grants carry repository name, provider ID, subject, scope, issue time, and expiry. They expire within five minutes and no later than the presenting ID token; the client treats them as opaque. No grant is written to KV. An unknown or expired credential gets a 401 Basic challenge so Git can renew it. The gateway verifies the signature before any Artifacts API request, checks the provider ID and remote for valid grants, then issues a separate, short lived Artifacts token that stays server side.

`POST /v2/repos` takes the same bearer and JSON `{ "name": "<repo-name>", "visibility": "private" | "public" }`; omitted visibility means private. It creates `default/u-<first-16-hex-of-SHA256-subject>-<repo-name>` and returns `{ "repoURL", "ref": "refs/heads/main", "providerId" }`. The owner can write; for public repositories, other signed in users can read. A failed registry write after provider creation is reported as unavailable and requires operator reconciliation; it does not claim the repository for another user.

## Existing fixture and deployment preparation

The direct Artifacts fixture is `default/os-code-url-20261110-a`, provider ID `fg1wtcrexaf7acl0`. Its remote is `https://2104e6f103f83b34f363985b093edc7c.artifacts.cloudflare.net/git/default/os-code-url-20261110-a.git`. Direct seed, clone, push, and fresh clone were verified with SHA pair `db0072aa94dd6c4fd99a4fd258094f954075f443` and `e7ee8459719a8050e4ee7e5c5672a38c5f1ffab6`.

Two Cloudflare KV namespaces were created for isolation: staging `9acf3a7f7772446baebbbfd5ddfc3f36` and production `26c715893bab478ca4a1bd5a62f57107`. Staging contains the registered fixture owner; production is empty. The Wrangler config binds each to `STANDALONE_REPOS`, which holds repository ownership only. Both environments' `EZIL_ID_AUDIENCES` contain the verified OS OIDC client ID `2tVk0vvzQvm964BtGuXzQxpjlo2JCoCl` and the public CLI client ID `Mzvm4piCMAKy3ofhywuQDYstJLcYE3mx`. Existing `API_ORIGIN`, `GIT_GATEWAY_SECRET`, `IP_HASH_SALT`, and `RL` bindings and Git/installer routes stay as configured. The existing limiter hashes the Cloudflare client IP with `IP_HASH_SALT` before JWKS, signed grant, or Artifacts work. `CREATE_RL` is a new five repository creations per minute limiter.

Before deploying, provision a Cloudflare account API token scoped to Artifacts repository read, create, and token issuance for account `2104e6f103f83b34f363985b093edc7c`; bind it as Worker secret `ARTIFACTS_ACCOUNT_TOKEN` separately in staging and production. The required API operations are `GET /artifacts/namespaces/default/repos/<repo>`, `POST /artifacts/namespaces/default/repos`, and `POST /artifacts/namespaces/default/tokens`. No delete permission is needed. Bind a separate random 32-byte, lowercase hex HMAC key as `STANDALONE_GRANT_SECRET` in each environment. Do not print either secret or copy the founder's broad wrapper token into a Worker secret. Rotating an HMAC key invalidates at most five minutes of outstanding grants.

After source review, deploy with the approved wrapper from the workspace root: `./.ci-support/cloudflare-cli.sh deploy --config 'EZiL CLI.worktrees/standalone-git-v2-20261110/apps/git-gateway/wrangler.jsonc' --env staging --var EZIL_COMMIT:<reviewed-sha>`. Staging fixture ownership is already registered from the privately verified subject; the registration script refuses overwrites. Obtain a grant at `https://git-staging.ezil.work/v2/git/grant` for the canonical `github.ezil.work` URL; test Git transport directly against `git-staging.ezil.work` with a private temporary credential config. The bundled private clone transport deliberately pins `github.ezil.work`, so its full OS clone test runs only after canonical deployment. Check another signed in user gets read only. Promote only after these checks and a public CLI client review, then register the fixture in production if it is intended to be reachable there. Never enroll it by guessing a subject or using a legacy account identifier.

Repository ownership remains in Cloudflare KV. The signed grant needs no KV propagation, so a newly minted grant can be used in another location immediately. New repository creation can still await KV propagation before the first grant; callers should retry that initial lookup if the repository was just created.
