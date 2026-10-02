# EZiL CLI

`ezil` signs your machine in to [EZiL](https://ezil.work) once. After that, the EZiL repositories you work on behave like any other Git remote: plain `git clone`, `git commit`, `git push`, with no tokens to paste. This repository also contains `github.ezil.work`, the gateway that `git` talks to.

## Install

```sh
npm install -g @ezilhq/cli                      # any OS with Node.js 22+
curl -fsSL https://github.ezil.work/install.sh | sh     # macOS, Linux (standalone binary)
irm https://github.ezil.work/install.ps1 | iex           # Windows PowerShell (standalone binary)
```

The standalone installers choose the binary for your OS and CPU, check its SHA-256 against the release's `SHA256SUMS`, and install it for your user only. The defaults are `~/.local/bin/ezil` and `%LOCALAPPDATA%\Programs\ezil\ezil.exe`. Set `EZIL_VERSION` to pin a version and `EZIL_INSTALL_DIR` to choose the directory. The binaries are not code-signed yet. Every release is also on the [Releases page](https://github.com/EZiLHQ/ezil-cli/releases).

`npx @ezilhq/cli …` works for one-off commands. But the Git credential helper and the session hooks run `ezil` by name, so install it to keep `ezil` on your `PATH`.

## Quick start

```sh
ezil auth login          # shows a code; approve it at app.ezil.work/cli/approve
ezil whoami              # who you are, and the repositories you can clone
git clone https://github.ezil.work/<namespace>/<repo>.git
cd <repo> && git commit -am "…" && git push
ezil auth logout         # revokes this device; the next git operation is refused
```

Other commands:
- `ezil auth status`: same as `ezil whoami`.
- `ezil auth sessions [revoke <id>]`: list your signed-in devices, or revoke one.
- `ezil connect | hook | flush`: session evidence for EZiL Works. See [packages/cli/README.md](packages/cli/README.md).

## How Git authentication works

1. `ezil auth login` runs a device-code sign-in that you approve in the browser. It stores a device session in your OS keychain: macOS Keychain, or Linux Secret Service. Where there is no keychain, including Windows for now, it uses `~/.ezil/cli-session.json` with mode 0600. It also points git's credential helper for `github.ezil.work` and `git.ezil.work` at `ezil git-credential`, with `useHttpPath` on.
2. For each git operation, the helper asks EZiL for a **grant**: one repository, at most 15 minutes, read or write as your access allows. Grants are never stored. An empty helper entry for this host keeps other credential managers from saving them.
3. `github.ezil.work` checks the grant with EZiL on every operation, then forwards to the repository's storage with a short-lived token that never leaves the server. A closed task, a revoked device or a logout takes effect on the next fetch or push.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the components and trust boundaries, and [SECURITY.md](SECURITY.md) for the credential model and how to report a problem.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `git` asks for a username or password | Run `ezil auth login`. Check `git config --global --get-all credential.https://github.ezil.work.helper` shows `!ezil git-credential`, and that `ezil` is on your `PATH`. |
| `EZiL: your Git credential is not valid` / `this device was signed out` | Your session ended or was revoked: run `ezil auth login`. |
| `you have read-only access to this repository` | You can clone and fetch but not push. Push access comes with an open task that selects this repository. |
| `repository not found, or you do not have access to it` | Check the URL against `ezil whoami`. |
| `429` | Too many requests from your network; wait a minute. |
| `503 … unavailable` | EZiL's authorization service is unreachable; retry shortly. |
| `413` on push | The push is larger than one request body allows; push in smaller pieces. |

To uninstall, run `ezil auth logout`. Then remove the binary (or `npm rm -g @ezilhq/cli`), `~/.ezil/`, and the `credential.https://github.ezil.work.*` and `credential.https://git.ezil.work.*` entries in `~/.gitconfig`.

## Repository layout

| Path | What |
|---|---|
| `packages/cli` | The `ezil` CLI. It has three parts: `src/core` (device session, credential store, API client, redaction), `src/modules/git` (credential helper, git setup) and `src/modules/sessions` (connect, hook, flush). |
| `apps/git-gateway` | The `github.ezil.work` Cloudflare Worker: Git smart HTTP, authorized per operation, plus the installers and download redirects. |
| `packages/contract` | The wire contract with the EZiL Works API, digest-pinned in both repositories. |
| `tests/e2e` | Local end-to-end tests: stock git → real CLI → real gateway → a contract-faithful API stand-in → a real Git server. Also the installer. |
| `tests/live` | The deployed stack, run by CI after every deploy. |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). In short, with Bun 1.3.14: `bun install --frozen-lockfile && bun run check`.

## License

[Apache-2.0](LICENSE). Copyright 2026 EZiL.
