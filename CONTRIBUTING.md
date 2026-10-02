# Contributing

Thanks for helping. Bug reports, fixes and documentation improvements are welcome; for a larger change, open an issue
first so we can agree the shape.

## Setup

- [Bun](https://bun.sh) **1.3.14** exactly (CI pins it; other versions can resolve a different dependency graph).
- `git` 2.30+ (2.41+ recommended: it honours the credential expiry the helper returns).

```sh
bun install --frozen-lockfile
bun run check          # typecheck every workspace + unit, gateway, full-chain e2e and installer tests
```

`tests/live` drives the deployed stack with a dedicated test account; it runs in CI on `main` only and needs
maintainer secrets. You never need it for a pull request.

## Rules that keep the system honest

- **No credential is ever printed.** Tests assert this; keep them passing and add one when you add output.
- **Every new guard gets a test that fails without it.** Mutation-test it: weaken the guard, watch the test fail.
- **The wire contract is shared with the EZiL Works API.** `packages/contract/src/{git-gateway,session-evidence,cli-api}.ts`
  are kept identical in that repository, and `packages/contract/src/digest.test.ts` pins their digests (zod is pinned
  to an exact version for the same reason). A change there needs the matching server change; say so in your pull
  request and a maintainer will coordinate it. Do not just update the pinned constant.
- Keep the CLI runnable under both Bun (from source) and Node 22+ (the npm package): use `node:*` APIs, not `Bun.*`,
  in `packages/cli`.

## Pull requests

Fill in the template. CI runs the `check` job for every pull request, including from forks (GitHub-hosted runner,
read-only token, no secrets); a maintainer approves the run for outside contributors. Deploys happen only from `main`.

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
