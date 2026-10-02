# `ezil` sessions module — session evidence, from the machine the work happens on

This is the session-evidence half of the [`@ezilhq/cli`](https://www.npmjs.com/package/@ezilhq/cli) package (`ezil connect | hook | flush`). Git sign-in (`ezil auth login`) is described in the [repository README](https://github.com/EZiLHQ/ezil-cli#readme).

```bash
claude mcp add --transport http ezil https://mcp.ezil.work/mcp
ezil connect
```

Two commands (after `npm install -g @ezilhq/cli`), the same two the Connect screen at
`/profile/connect` shows you. The first adds `mcp.ezil.work` to your MCP
client; the second signs you in, stores your credential, records the
connection against your account, resolves today's contract, and merges six
hooks into this repository's `.claude/settings.json`.

## Signing in

`ezil connect` asks for your **EZiL email and password** — the same ones you
use on the web — and exchanges them for a session through the API's
`POST /auth/signin`. The password is not echoed as you type it and is never
written anywhere: it is spent on that one request and then gone.

For a runner with no terminal to type into, set `EZIL_EMAIL` and
`EZIL_PASSWORD` in the environment instead and `connect` will not prompt.

```bash
ezil connect                       # asks you
EZIL_EMAIL=… EZIL_PASSWORD=… ezil connect   # does not
ezil connect --api https://api.ezil.work    # a different deployment
```

### `--token` is the escape hatch, not the path

`--token <bearer>` (or `EZIL_ACCESS_TOKEN`) uses a session you already have and
skips the sign-in. It exists for the case where typing a password into a
terminal is the wrong thing to do; it is not the documented way to connect, and
a pasted bearer comes with no refresh token, so it expires and stays expired
until you run `connect` again.

### What is stored about the connection

Your session tokens go into `~/.ezil/credentials` at mode `0600` and nowhere
else. What EZiL is told is the provider (`mcp.ezil.work`) and a **reference** to
your identity — your Supabase account id, which is not a credential and cannot
be signed in with. No token is ever sent as that reference; the column it lands
in says so in the schema (`"A reference the secret store resolves — never the
OAuth token itself."`).

## The hard constraint this package is built around

**A hook that can break Claude Code is a hook every freelancer deletes on day
two.** A deleted hook produces no evidence at all, so every design decision
here is subordinate to the hook being unable to interrupt the work:

- **Nothing is written to stdout.** A `UserPromptSubmit` hook's standard output
  is injected into the model's context — a progress line would arrive in the
  conversation as though you had typed it.
- **The exit status is always 0.** Claude Code reads a hook's exit code as an
  instruction; a `PreToolUse` hook exiting 2 blocks the tool call. An evidence
  hook must never be able to stop your work because a disk was full. Failures go
  to `.ezil/hook.log`.
- **No network call happens inside a hook.** The hook appends one line to
  `.ezil/spool/<session>.jsonl` and returns. Sending is `ezil flush`, which
  `stop` and `session-end` spawn detached.

## What is sent

- **session start** — repository, branch, head commit, model id
- **each prompt** — a SHA-256 digest, and a redacted opening of at most 512
  characters (that opening is sent: do not put secrets in prompts)
- **each tool call** — the tool's name, a redacted command, and the file **path
  only**
- **each tool result** — the exit status *if one was reported*, the byte count,
  and a redacted excerpt of at most the first and last 4 KB (output can contain
  sensitive data; redaction removes known credential shapes, not everything)
- **session end** — head commit, whether the tree was dirty, elapsed time

## What is not sent

- **Your full prompts.** Only the digest and the redacted opening above. The
  wire contract (`packages/contract/src/session-evidence.ts`) has no `verbatim`
  field and is strict, so a producer that added one would be refused by name
  rather than quietly stored.
- **File contents, diffs or patches.** No field carries them. The repositories
  you work in belong to clients.
- **Anything outside this repository.** A tool that acts elsewhere is recorded
  as having done so — with no path and no command. The contract *refuses* an
  event that is marked outside and carries either.
- **Recognisable credentials.** Anything shaped like an API key, a GitHub token,
  an AWS key id, a JWT or a PEM private key is replaced before it reaches the
  spool. If one gets past that, the server **refuses the whole batch** rather than
  scrubbing it and storing the rest. Pattern-based redaction cannot catch every
  secret, which is why prompts and excerpts are short.

## The rung this can reach

`WORKER_RUNTIME_EVIDENCE`, and that is a ceiling rather than a default. The
hooks run on your machine, so whatever they show, they show about a run you
controlled. `INDEPENDENT_TEST_PASS` is *"a test that the worker did not write,
or a run they did not perform"* and only the sandbox produces it. A session
transcript showing a green suite is your claim that your machine went green, and
the system is explicit about the difference.

What the hooks *do* buy is that they fire whether or not you want them to: a
session that ran a command and got exit 1 records exit 1, and you cannot choose
event by event what the transcript says.

## Files this creates

| path | what | note |
|---|---|---|
| `~/.ezil/credentials` | the bearer, mode 0600 | per person, never in a repository |
| `<project>/.ezil/spool/<session>.jsonl` | events waiting to be sent | **add `.ezil/` to `.gitignore`** |
| `<project>/.ezil/cursor/<session>.json` | how far the spool has been filed, and the size of the run in flight | |
| `<project>/.ezil/session/<session>.json` | the repository, root, head and branch bound at session start | |
| `<project>/.ezil/quarantine/` | a batch the server refused as carrying a credential | stays on your disk |
| `<project>/.ezil/hook.log` | anything a hook could not do | the only place a hook complains |
| `<project>/.claude/settings.json` | **merged**, never replaced | your other hooks are kept and run first |

`connect` does not edit your `.gitignore`. Changing a client's ignore rules on
connect is a change to their tree, and this tool does not make one.

## Known limits, stated rather than discovered

- **The `connect` credential is a 0600 file, not a keychain entry.** Any process
  running as you can read it. The device session from `ezil auth login` (the git
  module) already uses the OS keychain where one exists; moving `connect` onto
  that session is a follow-up.
- **The contract is resolved on every flush, never read from the credential.**
  Contracts are daily. A worker who connects on Monday and works on Tuesday
  would otherwise file Tuesday's transcript against Monday's contract, and every
  check the server makes would pass. When today's contract cannot be resolved,
  nothing is sent and nothing is lost.
- **One flush runs at a time per project.** `stop` spawns a flush on every turn,
  so two overlap the moment one is slow. A second flush takes no lock, sends
  nothing and returns; a lock older than two minutes is assumed to belong to a
  dead process and is taken over.
- **A session bound to the wrong repository is not sent at all.** The server can
  only check a batch that carries a `session_start`, and after the first run most
  do not.
- **An unreported exit status is sent as `null`, not as 0.** Claude Code does
  not always report a process's status. A `0` invented for "the tool call did
  not error" would manufacture a green test claim out of a suite that went red,
  which is the exact failure this product exists to catch. `null` produces no
  claim at all.

## Development

```bash
bun test --no-env-file packages/cli   # from the repository root
```
