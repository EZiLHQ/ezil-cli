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
`/cli/whoami` using the existing CLI session. Git clone still invokes stock Git and
the configured credential helper, preserving live server repository grant checks.
Reuse requires an ordinary checkout with the exact origin and root; no fetch,
pull, reset, checkout, or working tree writes occur. Linked worktrees are rejected.

OS must create the account-owned absolute destination parent first, pass arguments
as an argv array, and verify returned accountId against its authenticated context.
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
its existing login/session and helper setup must already be available in the OS.

```sh
bun install --frozen-lockfile
bun run check
bash ops/build-private-cli.sh /absolute/new/private-artifact-directory
cd /absolute/new/private-artifact-directory
sha256sum -c SHA256SUMS
npm install --ignore-scripts --no-audit --no-fund --prefix /private/os-cli-prefix ./ezilhq-cli-0.2.1-repo-url-open.20261026.1.tgz
/private/os-cli-prefix/node_modules/.bin/ezil --version
```

The package is marked `private: true` with no publishConfig. Build metadata records
commit, prerelease version and tool versions. Hashes identify the actual tarball and
bundle; tarball hashes can vary with npm versions. Pin both source commit and artifact
checksum for staging. No gateway deployment, public publication, push or CLI release
is performed by this lane. Coordinator-owned independent exact-commit review and
OS staging authorization/login/editor/restoration acceptance are still required.

## Local validation

225 tests passed, including local synthetic Git gateway/install end-to-end tests;
all four workspace typechecks passed under pinned Bun 1.3.14. New tests cover exact
namespace selection, retained name selection, invalid URL/argv rejection, missing
and revoked auth, dirty/detached/local-commit reuse, revoked membership, wrong origin,
non-checkout/symlink/path rejection, failed clone cleanup/retry, destination races,
and concurrent opens. No live account identity, staging service or deployment was
used by these tests. Independent review is pending; local results are not staging
acceptance. Detailed Notion evidence is omitted under the current tracking boundary.
