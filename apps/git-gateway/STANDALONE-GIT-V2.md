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

The server verifies RS256 against the fixed EZiL ID JWKS, exact issuer, configured audience, subject, issue time, and expiry. A write grant requires the repository's registered owner subject. Authenticated users can receive read grants for repositories marked `publicRead`. Grants live for at most five minutes and bind to one repository and scope. The gateway checks the Artifacts provider ID and remote on every request, then issues a separate, short lived Artifacts token that stays server side.

`POST /v2/repos` takes the same bearer and JSON `{ "name": "<repo-name>", "visibility": "private" | "public" }`; omitted visibility means private. It creates `default/u-<first-16-hex-of-SHA256-subject>-<repo-name>` and returns `{ "repoURL", "ref": "refs/heads/main", "providerId" }`. The owner can write; for public repositories, other signed in users can read. A failed registry write after provider creation is reported as unavailable and requires operator reconciliation; it does not claim the repository for another user.

## Existing fixture and deployment preparation

The direct Artifacts fixture is `default/os-code-url-20261110-a`, provider ID `fg1wtcrexaf7acl0`. Its remote is `https://2104e6f103f83b34f363985b093edc7c.artifacts.cloudflare.net/git/default/os-code-url-20261110-a.git`. Direct seed, clone, push, and fresh clone were verified with SHA pair `db0072aa94dd6c4fd99a4fd258094f954075f443` and `e7ee8459719a8050e4ee7e5c5672a38c5f1ffab6`.

Two empty Cloudflare KV namespaces were created for isolation: staging `9acf3a7f7772446baebbbfd5ddfc3f36` and production `26c715893bab478ca4a1bd5a62f57107`. The Wrangler config binds each to `STANDALONE_REPOS`. The staging `EZIL_ID_AUDIENCES` contains the verified OS staging client ID `2tVk0vvzQvm964BtGuXzQxpjlo2JCoCl` and the public CLI client ID `Mzvm4piCMAKy3ofhywuQDYstJLcYE3mx`. Production currently contains only the CLI client ID; verify and add the production OS client ID before canonical OS deployment. Existing `API_ORIGIN`, `GIT_GATEWAY_SECRET`, `IP_HASH_SALT`, and `RL` bindings and Git/installer routes stay as configured. `CREATE_RL` is a new five repository creations per minute limiter.

Before deploying, provision a Cloudflare account API token scoped to Artifacts repository read, create, and token issuance for account `2104e6f103f83b34f363985b093edc7c`; bind it as Worker secret `ARTIFACTS_ACCOUNT_TOKEN` separately in staging and production. The required API operations are `GET /artifacts/namespaces/default/repos/<repo>`, `POST /artifacts/namespaces/default/repos`, and `POST /artifacts/namespaces/default/tokens`. No delete permission is needed. Do not copy the founder's broad wrapper token into a Worker secret.

After source review, deploy with the approved wrapper from the workspace root: `./.ci-support/cloudflare-cli.sh deploy --config 'EZiL CLI.worktrees/standalone-git-v2-20261110/apps/git-gateway/wrangler.jsonc' --env staging --var EZIL_COMMIT:<reviewed-sha>`. Use a normally signed in fixture user's verified EZiL ID subject on stdin to `bash ops/register-standalone-fixture.sh staging`. The script checks the provider ID, remote, branch, and writable status before recording ownership. Obtain a grant at `https://git-staging.ezil.work/v2/git/grant` for the canonical `github.ezil.work` URL; test Git transport directly against `git-staging.ezil.work` with a private temporary credential config. The bundled private clone transport deliberately pins `github.ezil.work`, so its full OS clone test runs only after canonical deployment. Check another signed in user gets read only. Promote only after these checks and a public CLI client review, then register the fixture in production if it is intended to be reachable there. Never enroll it by guessing a subject or using a legacy account identifier.

Cloudflare KV is eventually consistent across locations. A grant written in one location may briefly be unavailable when a Git request reaches another location; clients should retry a 503 or 403 once with a fresh grant. A stronger consistency store is required before this route serves geographically distributed production traffic at scale.
