import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { SessionEvent } from "@ezil/cli-contract/session-evidence";

import {
	eventFor,
	promptEvent,
	type EventContext,
	type HookInput,
	type HookKind,
	type RepositoryBinding,
} from "./events";
import { readBinding, writeBinding, type StoredBinding } from "./binding";
import { hookLogPath } from "../../core/paths";
import { appendEvent } from "./spool";

/**
 * `ezil hook <kind>` -- the one command that runs inside somebody's editor.
 *
 * ==========================================================================
 * NOTHING ON STDOUT. NEVER A NON-ZERO EXIT. NEVER A BLOCKING CALL.
 * ==========================================================================
 *
 * Three constraints, each from a different failure, and all three are the same
 * hard rule underneath: **a hook that can break Claude Code is a hook every
 * freelancer deletes on day two**, and a deleted hook produces no evidence at
 * all. A pipeline whose adoption cost is not zero has no data to be careful
 * with.
 *
 *   1. **stdout is the model's context.** A `UserPromptSubmit` hook's standard
 *      output is INJECTED INTO THE PROMPT. Anything printed here -- a progress
 *      line, a stray `console.log`, a warning from a dependency -- becomes text
 *      the model reads as though the worker had typed it. So this file writes
 *      nothing to stdout, ever, and `hook.test.ts` asserts that against the
 *      real path rather than trusting the rule.
 *   2. **A non-zero exit is a signal.** Claude Code reads exit codes from hooks
 *      as instructions -- a `PreToolUse` hook exiting 2 BLOCKS the tool call.
 *      An evidence hook must never be able to stop somebody's work because a
 *      disk was full, so every path here ends in exit 0 and failures go to
 *      `.ezil/hook.log`.
 *   3. **No network.** The hook appends a line and returns; `ezil flush` sends.
 *      See `spool.ts`.
 *
 * `stop` and `session-end` additionally spawn a DETACHED flush -- spawned and
 * unreferenced, with its stdio thrown away, so the hook does not wait for it
 * and the child's output cannot reach the model either.
 */

/** Never throws, never prints. The log is the only place a failure is recorded. */
export function logFailure(projectRoot: string, kind: string, error: unknown): void {
	try {
		const file = hookLogPath(projectRoot);
		mkdirSync(dirname(file), { recursive: true });
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		appendFileSync(file, `${new Date().toISOString()} ${kind} ${message}\n`, { encoding: "utf8" });
	} catch {
		// The log itself failed. There is nowhere left to say so that is not
		// stdout, and stdout is the one place this must not write.
	}
}

/* ------------------------------------------------------------------------- *
 * Git, asked briefly and never trusted to answer
 * ------------------------------------------------------------------------- */

function git(cwd: string, args: readonly string[]): string | null {
	try {
		return execFileSync("git", [...args], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/**
 * `owner/name` out of a remote URL, or null.
 *
 * The contract's `repository` is what this is compared against by the server,
 * and the server refuses a mismatch rather than resolving it -- so a guess here
 * is a refused batch rather than a wrong record, which is the safe direction.
 */
export function repositoryFromRemote(url: string): string | null {
	const trimmed = url.trim().replace(/\.git$/, "");
	const match = /(?:[:/])([^/:]+)\/([^/]+)$/.exec(trimmed);
	if (match === null) return null;

	const owner = match[1];
	const name = match[2];
	if (owner === undefined || name === undefined) return null;

	return `${owner}/${name}`;
}

/** What a session binds at its start. Null when the tree is not a repository. */
export function bindRepository(cwd: string): RepositoryBinding | null {
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	const headSha = git(cwd, ["rev-parse", "HEAD"]);
	const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const remote = git(cwd, ["remote", "get-url", "origin"]);

	if (root === null || headSha === null || branch === null) return null;
	if (!/^[0-9a-f]{40}$/.test(headSha)) return null;

	const repository = remote === null ? null : repositoryFromRemote(remote);
	if (repository === null) return null;

	return { repository, root, headSha, branch };
}

export function isDirty(cwd: string): boolean {
	const status = git(cwd, ["status", "--porcelain"]);
	return status !== null && status !== "";
}

export function headOf(cwd: string): string | undefined {
	const head = git(cwd, ["rev-parse", "HEAD"]);
	return head !== null && /^[0-9a-f]{40}$/.test(head) ? head : undefined;
}

export { readBinding, writeBinding, type StoredBinding };

/* ------------------------------------------------------------------------- *
 * The session id
 * ------------------------------------------------------------------------- */

/**
 * The session id, as `SessionIdSchema` will accept it.
 *
 * The id is minted by the harness and appears in a URL path segment and in a
 * storage key, so a value that is not a path-safe token cannot be either of the
 * things it is used as. Sanitised here rather than sent and refused: a session
 * whose id had a slash in it would spool events that could never be filed, and
 * the worker would find out at the end of the day.
 */
export function sessionIdOf(input: HookInput): string | null {
	const raw = input["session_id"] ?? input["sessionId"];
	if (typeof raw !== "string") return null;

	const cleaned = raw.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 128);
	return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : null;
}

/* ------------------------------------------------------------------------- *
 * The hook itself
 * ------------------------------------------------------------------------- */

export interface HookRunOptions {
	readonly kind: HookKind;
	readonly input: HookInput;
	readonly projectRoot: string;
	readonly at?: string;
	/** Injectable so the hook path is testable with no git and no editor. */
	readonly binder?: (cwd: string) => RepositoryBinding | null;
	readonly dirty?: (cwd: string) => boolean;
	readonly head?: (cwd: string) => string | undefined;
	readonly nowMs?: number;
}

export interface HookOutcome {
	readonly appended: SessionEvent | null;
	readonly sessionId: string | null;
	/** Whether this kind asks for a flush afterwards. */
	readonly flushAfter: boolean;
}

/**
 * Build the event and append it. Returns what happened; prints nothing.
 *
 * Separated from `runHook` so a test drives the whole decision -- binding,
 * location, redaction, spool -- without a process, and `runHook` is left as the
 * thin, unbreakable shell that reads stdin and swallows everything.
 */
export function hookOutcome(options: HookRunOptions): HookOutcome {
	const { kind, input, projectRoot } = options;
	const at = options.at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	const sessionId = sessionIdOf(input);
	const flushAfter = kind === "stop" || kind === "session-end";

	if (sessionId === null) return { appended: null, sessionId: null, flushAfter };

	const cwd = typeof input["cwd"] === "string" ? (input["cwd"] as string) : projectRoot;
	const nowMs = options.nowMs ?? Date.now();

	let binding = readBinding(projectRoot, sessionId);

	if (kind === "session-start") {
		const bind = (options.binder ?? bindRepository)(cwd);
		if (bind === null) return { appended: null, sessionId, flushAfter };

		binding = { ...bind, startedAtMs: nowMs };
		writeBinding(projectRoot, sessionId, binding);
	}

	const endHead = kind === "session-end" ? (options.head ?? headOf)(cwd) : undefined;

	const context: EventContext = {
		at,
		binding,
		...(kind === "session-start" ? { modelId: modelIdOf(input) } : {}),
		...(kind === "session-end"
			? {
					// Omitted rather than passed as `undefined`: with
					// `exactOptionalPropertyTypes` those are different things, and
					// `eventFor` falls back to the bound head only when the key is
					// genuinely absent.
					...(endHead === undefined ? {} : { headSha: endHead }),
					dirty: (options.dirty ?? isDirty)(cwd),
					elapsedMs: binding === null ? 0 : Math.max(0, nowMs - binding.startedAtMs),
				}
			: {}),
	};

	const event = kind === "prompt" ? null : eventFor(kind, input, context);
	if (event === null) return { appended: null, sessionId, flushAfter };

	appendEvent(projectRoot, sessionId, event);
	return { appended: event, sessionId, flushAfter };
}

/** The prompt path, which needs a digest and therefore a promise. */
export async function promptOutcome(options: HookRunOptions): Promise<HookOutcome> {
	const sessionId = sessionIdOf(options.input);
	if (sessionId === null) return { appended: null, sessionId: null, flushAfter: false };

	const at = options.at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	const binding = readBinding(options.projectRoot, sessionId);
	const event = await promptEvent(options.input, { at, binding });
	if (event === null) return { appended: null, sessionId, flushAfter: false };

	appendEvent(options.projectRoot, sessionId, event);
	return { appended: event, sessionId, flushAfter: false };
}

function modelIdOf(input: HookInput): string {
	const direct = input["model_id"] ?? input["modelId"];
	if (typeof direct === "string" && direct !== "") return direct;

	const model = input["model"];
	if (typeof model === "string" && model !== "") return model;
	if (typeof model === "object" && model !== null) {
		const id = (model as Record<string, unknown>)["id"];
		if (typeof id === "string" && id !== "") return id;
	}

	return "unknown";
}

/**
 * Spawn `ezil flush`, detached, and forget about it.
 *
 * `detached` plus `unref` plus `stdio: "ignore"`: detached so it survives the
 * hook exiting, unref'd so the hook does not wait for it, and stdio thrown away
 * so nothing the child writes can reach the model's context through the
 * parent's inherited handles -- which is the same rule as #1 at the top of this
 * file, one process removed.
 */
export function spawnFlush(projectRoot: string, argv: readonly string[] = process.argv): void {
	try {
		const runtime = argv[0];
		const script = argv[1];
		if (runtime === undefined || script === undefined) return;

		const child = spawn(runtime, [script, "flush"], {
			cwd: projectRoot,
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// A flush that could not be spawned is a flush that happens next time.
	}
}
