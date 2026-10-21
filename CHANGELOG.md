# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-21

### Added
- `ezil auth login` signs in with EZiL ID (https://id.ezil.work, device code) when the API offers it (`GET /cli/config`), then exchanges the identity for the usual EZiL session. Git keeps using short-lived EZiL grants; Auth0 tokens are never stored or printed. `--legacy` keeps the EZiL device code.
- `ezil clone [repository]`: clone your task repository through github.ezil.work.
- `curl -fsSL https://github.ezil.work/start.sh | sh -s -- [repository]`: install, sign in and clone in one line.

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
