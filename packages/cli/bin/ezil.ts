#!/usr/bin/env bun
/**
 * `ezil` -- command dispatch with a hook branch that must never interrupt work.
 *
 * `connect` and `flush` are ordinary programs: they print to stdout, they may
 * fail, and a person is watching. `hook` is not. It runs inside Claude Code,
 * its stdout is injected into the model's context on at least one event, and a
 * non-zero exit is read as an instruction. So the `hook` branch below is
 * wrapped whole: nothing it can throw escapes, and it always ends in exit 0.
 *
 * See `docs/ARCHITECTURE.md` for the hook's constraints and their rationale.
 */

import { spawn, spawnSync } from "node:child_process";

import {
	connect,
	connectNotice,
	flush,
	HOOK_KINDS,
	hookOutcome,
	logFailure,
	promptOutcome,
	readCredentials,
	spawnFlush,
	type HookInput,
	type HookKind,
} from "../src/index";
import pkg from "../package.json" with { type: "json" };
import { login, logout, sessions, whoami } from "../src/core/auth";
import type { Io } from "../src/core/session";
import { gitCredential, gitSetup } from "../src/modules/git/credential";

/** Read the whole of stdin. Returns `{}` when there is nothing on it. */
async function readStdin(): Promise<HookInput> {
	const chunks: Uint8Array[] = [];

	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
	}

	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}

	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return typeof parsed === "object" && parsed !== null ? (parsed as HookInput) : {};
	} catch {
		return {};
	}
}

function optionOf(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	if (index >= 0 && index + 1 < argv.length) return argv[index + 1];

	const inline = argv.find((argument) => argument.startsWith(`--${name}=`));
	return inline === undefined ? undefined : inline.slice(name.length + 3);
}

const USAGE = `ezil -- the EZiL command line (modules: git, sessions)

  ezil connect [--api <origin>] [--token <bearer>]
      Sign in, store the credential, record the mcp.ezil.work connection,
      resolve today's contract, and merge the six hooks into this project's
      .claude/settings.json.

      You are asked for your email and password, and the password is not
      echoed. For a runner with no terminal to type into, set EZIL_EMAIL and
      EZIL_PASSWORD instead.

      --token (or EZIL_ACCESS_TOKEN) is an escape hatch for a session you
      already have, not the usual path. Nothing you supply or receive here is
      ever printed.

  ezil hook <${HOOK_KINDS.join("|")}>
      Read one hook payload on stdin, append one event to the spool, exit 0.
      Writes nothing to stdout.

  ezil flush
      Send the spool. Runs detached from stop and session-end.

  ezil auth login | logout | status | sessions [revoke <id>]
      Sign this device in to EZiL (a code you approve in the browser) and set
      git up for github.ezil.work. After that, plain \`git clone\` / \`git push\`.

  ezil whoami
      Who you are signed in as, and the repositories you can clone.

  ezil --version
      The installed version.

  ezil git-credential <get|store|erase>
      The git credential helper. Git runs this; you don't need to.
`;

/** The real process: stdio, network, a browser, and short synchronous commands (git, keychain). */
function realIo(): Io {
	return {
		env: process.env, fetch, now: Date.now,
		out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`),
		sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
		openBrowser: url => {
			const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
			try { spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* the URL is printed anyway */ }
		},
		run: (cmd, stdin) => {
			try {
				// node:child_process, not Bun's: the same bin runs under Bun from source and under Node from npm.
				const result = spawnSync(cmd[0]!, cmd.slice(1), { ...(stdin === undefined ? {} : { input: stdin }), stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
				if (result.error) return { code: 127, stdout: "" };
				return { code: result.status ?? 1, stdout: result.stdout?.toString() ?? "" };
			} catch { return { code: 127, stdout: "" }; }
		},
	};
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const command = argv[0];
	if (command === "--version" || command === "-v" || command === "version") { process.stdout.write(`ezil ${pkg.version}\n`); return 0; }
	const projectRoot = process.cwd();

	if (command === "hook") {
		const kind = argv[1];

		try {
			if (kind === undefined || !(HOOK_KINDS as readonly string[]).includes(kind)) {
				logFailure(projectRoot, kind ?? "(none)", new Error("unknown hook kind"));
				return 0;
			}

			const input = await readStdin();
			const options = { kind: kind as HookKind, input, projectRoot };
			const outcome = kind === "prompt" ? await promptOutcome(options) : hookOutcome(options);

			if (outcome.flushAfter) spawnFlush(projectRoot);
		} catch (error: unknown) {
			logFailure(projectRoot, kind ?? "(none)", error);
		}

		// Always. See the header: an evidence hook that can stop somebody's work
		// is an evidence hook that gets deleted.
		return 0;
	}

	if (command === "connect") {
		const apiOrigin = optionOf(argv, "api") ?? process.env["EZIL_API_ORIGIN"] ?? "https://api.ezil.work";
		const accessToken = optionOf(argv, "token") ?? process.env["EZIL_ACCESS_TOKEN"];

		/*
		 * `connect()` resolves the grant: an explicit bearer, otherwise
		 * `EZIL_EMAIL`/`EZIL_PASSWORD`, otherwise an interactive prompt.
		 * This branch passes through the options so every sign-in path is reachable.
		 *
		 * With `exactOptionalPropertyTypes`, an absent `accessToken` differs from
		 * `accessToken: undefined`. The conditional spread omits both undefined and
		 * empty values so an empty environment variable means no supplied token.
		 */
		const result = await connect({
			apiOrigin,
			projectRoot,
			...(accessToken === undefined || accessToken === "" ? {} : { accessToken }),
		});
		process.stdout.write(`${connectNotice(result)}\n`);
		return 0;
	}

	if (command === "flush") {
		if (readCredentials() === null) {
			process.stderr.write("Not connected. Run `ezil connect` first.\n");
			return 2;
		}

		const result = await flush({ projectRoot });

		for (const outcome of result.outcomes) {
			if (outcome.kind === "quarantined") {
				process.stdout.write(
					`quarantined ${outcome.sessionId} batch ${outcome.spoolSequence}: the server refused it as ` +
						`carrying a credential (${outcome.patterns.join(", ") || "no local pattern matched"}). ` +
						`It is at ${outcome.file} and was not sent.\n`,
				);
			} else if (outcome.kind === "filed") {
				process.stdout.write(`${outcome.status} ${outcome.sessionId} batch ${outcome.spoolSequence}\n`);
			} else if (outcome.kind === "no-contract") {
				process.stderr.write(`${outcome.detail}. Nothing was sent; the spool is untouched.\n`);
			} else if (outcome.kind === "wrong-repository") {
				process.stderr.write(`skipped ${outcome.sessionId}: ${outcome.detail}\n`);
			} else if (outcome.kind === "already-running") {
				process.stderr.write(`${outcome.detail}.\n`);
			} else if (outcome.kind === "unauthorised") {
				process.stderr.write(`unauthorised${outcome.sessionId === null ? "" : ` ${outcome.sessionId}`}: ${outcome.detail}\n`);
			} else {
				process.stderr.write(`${outcome.kind} ${outcome.sessionId} batch ${outcome.spoolSequence}: ${outcome.detail}\n`);
			}
		}

		if (result.remaining > 0) process.stdout.write(`${result.remaining} event(s) still spooled.\n`);
		return result.outcomes.some((outcome) => outcome.kind !== "filed" && outcome.kind !== "quarantined") ? 1 : 0;
	}

	if (command === "git-credential") {
		const chunks: Uint8Array[] = [];
		for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
		return gitCredential(realIo(), argv[1] ?? "", new TextDecoder().decode(Buffer.concat(chunks)));
	}
	if (command === "auth" || command === "whoami") {
		const io = realIo();
		const sub = command === "whoami" ? "status" : argv[1];
		try {
			if (sub === "login") return await login(io, [gitSetup()]);
			if (sub === "logout") return await logout(io);
			if (sub === "status") return await whoami(io);
			if (sub === "sessions") return await sessions(io, argv[2] === "revoke" ? argv[3] : undefined);
		} catch (error: unknown) {
			process.stderr.write(`${error instanceof Error ? error.message : "ezil auth failed."}\n`);
			return 1;
		}
	}

	process.stderr.write(USAGE);
	return command === undefined ? 0 : 2;
}

process.exitCode = await main();
