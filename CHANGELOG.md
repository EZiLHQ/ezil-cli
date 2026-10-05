# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- `github.ezil.work` is documented and pinned as the one canonical production Git host; `git.ezil.work` stays served by the
  same Worker as a compatibility alias, and `git-staging.ezil.work` stays staging only. CI now probes the alias on release.

### Fixed
- The gateway no longer forwards an upstream `Location` header that points at the Cloudflare Artifacts host: a redirect inside
  the repository is rewritten to the gateway path, and any other redirect is refused (502).

## [0.1.0] - 2026-10-02

First public release.

### Added
- `ezil auth login | logout | status | sessions` and `ezil whoami`: device-code sign-in approved in the browser, with
  the session stored in the OS keychain where one exists.
- `ezil git-credential`: a Git credential helper for `github.ezil.work` and `git.ezil.work` that hands git a
  per-repository grant (≤ 15 min) for each operation; `ezil auth login` configures it.
- `ezil connect | hook | flush`: session evidence for EZiL Works.
- The `github.ezil.work` gateway: Git smart HTTP, authorized per operation, push ref updates recorded.
- Installers (`/install.sh`, `/install.ps1`) that verify SHA-256 before installing; standalone binaries for macOS,
  Linux and Windows; the `@ezilhq/cli` npm package (Node 22+).
