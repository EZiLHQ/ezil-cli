# Private CLI handoff to OS

Contract: `ezil clone <canonicalURL> --directory <absoluteDestination> --json`.
Success exit 0, exactly one stdout JSON document with `canonicalUrl`, `folder`,
`accountId`, and `status` (`cloned` or `reused`). Errors are one stdout JSON document
`{"error":{"code":"auth-required","message":"..."}}` (example), nonzero exit.
No credentials or raw API/Git errors are printed. Missing/revoked authentication
returns `auth-required`, exit 1. Invalid arguments/URL/path or ambiguous/unauthorized
selection return exit 2. Filesystem/clone failure returns exit 1. Other stable codes:
`invalid-arguments`, `invalid-repository`, `invalid-directory`, `invalid-response`,
`ambiguous-repository`, `repository-not-authorized`, `destination-conflict`,
`destination-busy`, `clone-failed`.

Only exact lowercase `https://github.ezil.work/<namespace>/<repo>.git` routes
matching the existing gateway grammar are accepted. Names/project labels remain
case-insensitive and must select one authorized repository. Every invocation checks
`/cli/whoami` using the existing CLI session. Both clone and reuse request a fresh `/cli/git-grant` using the exact access token
captured for whoami. Clone invokes stock Git with an operation-scoped credential
helper connected to a private Unix socket. The same token's validated grant remains
in memory; no second session lookup occurs. No credentials are placed in argv,
environment, files, diagnostics, or result JSON. Normal `ezil git-credential` behavior
for other Git operations is unchanged. Expired grants fail closed without refresh;
retry the operation. Redirects and inherited generic/host credential helpers are
disabled for this clone. Clone runs outside any checkout with global/system/injected
Git configuration disabled, preventing inherited URL rewrites or auth headers from
substituting another identity. Custom global Git configuration is not applied to
this scoped clone. The helper serves only the exact HTTPS repository path.
Reuse requires an ordinary checkout with the exact origin and root; no fetch,
pull, reset, checkout, or working tree writes occur. Linked worktrees are rejected.

OS must create the account-owned absolute destination parent first, pass arguments
as an argv array, and treat returned accountId as Works identity, not OS identity. OS owns destination
mapping using OS account identity plus the full repository. Any relationship between
Works and OS identity requires explicit verification, never an equality assumption.
Do not infer cross-project login compatibility. Keep parent directories inaccessible
to other users; symlink components are rejected, but pathname checks are not a
sandbox against a hostile process that can rename the same user's parent directories.
A sibling mkdir lock serializes cooperating CLI processes (30-second wait, then
retryable destination-busy). Process death leaves a fail-closed lock; a supervisor
must verify no operation remains before removing that lock and abandoned temp data.
No automatic stale-lock stealing. A clone is built in an operation-owned sibling
and renamed over an exclusively created empty reservation. Existing destinations,
including empty directories, are never adopted/overwritten. Default destination
when omitted is the absolute path of the repository basename in the current cwd.

## Build and install without publishing

Use this commit's private worktree; never copy private sources into a public OS
repository. Tooling: Bun **1.3.14**, Node **22 or newer**, npm, Git, and bash.
`bun install --frozen-lockfile` installs pinned workspace development/build dependencies
and needs npm registry access or a populated cache. No credentials are needed for
the dependency install; do not run credential setup scripts. The tarball contains a
bundled Node CLI with no runtime npm dependencies. The installed CLI requires Git;
its existing login/session must be available in the OS. This private clone transport
requires a POSIX Unix socket and Node on PATH when invoked from Bun/native builds;
the Node npm bundle uses its own Node executable. The build is for Linux OS staging,
not a claim of Windows transport support.

```sh
bun install --frozen-lockfile
bun run check
bash ops/build-private-cli.sh /absolute/new/private-artifact-directory
cd /absolute/new/private-artifact-directory
sha256sum -c SHA256SUMS
npm install --ignore-scripts --no-audit --no-fund --prefix /private/os-cli-prefix ./ezilhq-cli-0.2.1-repo-url-open.20261026.2.tgz
/private/os-cli-prefix/node_modules/.bin/ezil --version
```

The package is marked `private: true` with no publishConfig. Build metadata records
commit, prerelease version and tool versions. Hashes identify the actual tarball and
bundle; tarball hashes can vary with npm versions. Pin both source commit and artifact
checksum for staging. No gateway deployment, public publication, push or CLI release
is performed by this lane. Coordinator-owned independent exact-commit review and
OS staging authorization/login/editor/restoration acceptance are still required.

## Local validation

229 tests passed, including local synthetic Git gateway/install end-to-end tests;
all four workspace typechecks passed under pinned Bun 1.3.14. New tests cover exact
namespace selection, retained name selection, invalid URL/argv rejection, missing
and revoked auth, dirty/detached/local-commit reuse, revoked membership, wrong origin,
non-checkout/symlink/path rejection, failed clone cleanup/retry, destination races,
and concurrent opens. No live account identity, staging service or deployment was
used by these tests. Independent review is pending; local results are not staging
acceptance. Detailed Notion evidence is omitted under the current tracking boundary.

## Review corrections for v2

All three review findings were accepted. Reuse now requires a live grant after
acquiring the destination lock. Whoami and grant share one captured access token;
a separately logged-in account cannot silently supply the Git credential. Tests
switch the stored session from A to B (both authorized) and verify the transport
receives A's grant, and separately verify refusal when A is revoked despite B access.
The two-process regression blocks the first real Git child at a controlled barrier,
starts another CLI process, and checks that only one clone reaches the barrier.
It uses real Git credential fill against the memory-only socket helper and rejects
an unrelated repository path. Deliberately replacing the shared lock with per-process
locks makes the contention assertion fail; original source was restored before
final validation. The earlier Promise.all test is retained only as a basic regression.

The v1 artifact is preserved. v2 needs independent exact-commit rereview before
staging adoption. No credential permissions, persistent configuration, production
release, or other repository changes were made.
