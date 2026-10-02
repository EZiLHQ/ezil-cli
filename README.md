# EZiL CLI

`ezil`, the EZiL command line, and the edge it talks to.

## Install

```
curl -fsSL https://github.ezil.work/install.sh | sh          # macOS, Linux
irm https://github.ezil.work/install.ps1 | iex                # Windows (PowerShell)
npm install -g @ezil/cli                                       # anywhere with Node 18+
npx @ezil/cli auth login                                       # or without installing
```

The installer picks the binary for your OS and CPU, checks its SHA-256, and installs it for your user only
(`~/.local/bin/ezil`, or `%LOCALAPPDATA%\Programs\ezil\ezil.exe`). `EZIL_VERSION=0.1.0` pins a version,
`EZIL_INSTALL_DIR` picks the directory. The binaries are unsigned for now.

```
ezil auth login          # sign this device in (a code you approve in the browser)
ezil whoami              # who you are, and the repositories you can clone
git clone https://github.ezil.work/<namespace>/<repo>.git   # then plain git add / commit / push
ezil auth logout         # revoke this device; the next git operation is refused
ezil connect | hook | flush   # session evidence for EZiL Works (see packages/cli/README.md)
```

## Layout

| Path | What |
|---|---|
| `packages/cli` | the `ezil` binary (`@ezil/cli`). `src/core`: device session, keychain/0600 store, API client, redaction. `src/modules/git`: credential helper + git setup. `src/modules/sessions`: connect / hook / flush |
| `apps/git-gateway` | the `github.ezil.work` Worker: Git smart HTTP in front of Cloudflare Artifacts, authorized per operation by EZiL Works |
| `packages/contract` | the wire contract with EZiL Works (`git-gateway`, `session-evidence`, `cli-api`), digest-pinned on both sides |
| `tests/e2e` | stock git → real CLI → real gateway handler → contract-faithful API → `git http-backend` |
| `tests/live` | the deployed gateway + EZiL Works API + Artifacts, as the QA builder |
| `docs/` | the design (`PLAN.md`), the build record, and the operator steps |

## The boundary with EZiL Works

EZiL Works owns identity and authority: the `/cli/*` and `/internal/git/*` routes, the CLI-session and git-grant
tables, and the `/cli/approve` page. This repository owns everything on the builder's machine and at the edge.
The two share no code. They share three contract files, kept identical in both repositories (here
`packages/contract/src`, in Works `packages/contracts/src/surface`), and `packages/contract/src/digest.test.ts`
pins their digests with the same constants Works pins. Changing the wire format is one change in each repository.

## Develop

Bun 1.3.14.

```
bun install
bun run check            # typecheck + unit + gateway + e2e
bun tests/live/live.ts   # against git-staging.ezil.work; needs EZIL_E2E_QA_PASSWORD
```

## CI/CD

`.github/workflows/ci.yml`, on GitHub-hosted runners (public repository):
check on every PR; on `main`, deploy the gateway to staging, then the live E2E, then production, then the live smoke,
which rolls back on failure. On a `v*` tag: unsigned binaries for macOS, Linux and Windows plus `SHA256SUMS`, and `@ezil/cli` published to npm.

## License

Not yet licensed for redistribution (`UNLICENSED`). Whether to open-source it is an open decision.
