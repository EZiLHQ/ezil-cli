import { isAbsolute, relative, resolve } from "node:path";

import type { SessionEvent } from "@ezil/cli-contract/session-evidence";

import { excerptOf, redact } from "../../core/redact";

/**
 * Hook JSON in, one {@link SessionEvent} out.
 *
 * Pure, and deliberately so: everything that touches git, the clock or the disk
 * is `hook.ts`'s and arrives here as {@link EventContext}. A decision that needs
 * a working tree to test is a decision whose interesting cases nobody builds a
 * tree for -- the argument `packages/orchestration/src/factpack.ts` makes, and
 * the reason the hard cases below (a tool acting outside the repository, a
 * missing exit code, an 8 KB excerpt) are unit-testable at all.
 *
 * ## What is built, and what is refused to be built
 *
 * `docs/ARCHITECTURE.md` §3.3 lists `full prompts` and `raw source by default`
 * as never collected, and §3.3a's amendment moves the browser trail and
 * explicitly does not move those. So:
 *
 *   - a prompt becomes a **digest** and a redacted opening of at most 512
 *     characters. There is no `verbatim` field on the contract and none is
 *     invented here;
 *   - a tool call becomes a **name, a redacted command and a repository-relative
 *     path**. Never the file, never the diff, never the patch;
 *   - a tool result becomes a **status, a byte count and a bounded redacted
 *     excerpt**. The excerpt exists so a failure has a readable symptom.
 *
 * ## Outside the repository
 *
 * `eventCommon.outsideRepository` on the contract: an event marked so is
 * recorded WITHOUT a path and without a command, "because outside the
 * repository is the worker's own machine and the worker's own life". Two things
 * put an event outside, and the second is the one worth stating:
 *
 *   1. the hook's `cwd` is not under the repository bound at session start;
 *   2. the path the tool named resolves outside that root.
 *
 * The field says "the tool acted outside the repository", not "the shell was
 * elsewhere", so (2) counts. Without it, `Edit ~/.ssh/config` from inside the
 * repository would be recorded as ordinary in-repository work with its path
 * dropped for a reason nobody could see.
 */

/** The hook payload, as it arrives on stdin. Nothing about its shape is assumed. */
export type HookInput = Readonly<Record<string, unknown>>;

export const HOOK_KINDS = ["session-start", "prompt", "pre-tool", "post-tool", "stop", "session-end"] as const;

export type HookKind = (typeof HOOK_KINDS)[number];

/** What `session-start` resolved out of the repository, kept for later hooks. */
export interface RepositoryBinding {
	/** `owner/name`, matched against the contract's own `repository`. */
	readonly repository: string;
	/** Absolute path of the working tree's root. */
	readonly root: string;
	readonly headSha: string;
	readonly branch: string;
}

export interface EventContext {
	/** A UTC instant with its `Z`. `InstantSchema` refuses anything else. */
	readonly at: string;
	/** Null until `session-start` has run, or when the tree is not a repository. */
	readonly binding: RepositoryBinding | null;
	/** `session-start` only: the model the session runs on. */
	readonly modelId?: string;
	/** `session-end` only. */
	readonly headSha?: string;
	readonly dirty?: boolean;
	readonly elapsedMs?: number;
}

/* ------------------------------------------------------------------------- *
 * Reading a payload without trusting it
 * ------------------------------------------------------------------------- */

function stringAt(input: HookInput, ...names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = input[name];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

function recordAt(input: HookInput, name: string): HookInput | undefined {
	const value = input[name];
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as HookInput) : undefined;
}

/* ------------------------------------------------------------------------- *
 * Where the tool acted
 * ------------------------------------------------------------------------- */

/** The path a tool named, whatever the tool calls the field. */
export function toolPathIn(toolInput: HookInput | undefined): string | undefined {
	if (toolInput === undefined) return undefined;
	return stringAt(toolInput, "file_path", "filePath", "notebook_path", "notebookPath", "path");
}

/** The command a tool ran, if it runs one at all. */
export function toolCommandIn(toolInput: HookInput | undefined): string | undefined {
	if (toolInput === undefined) return undefined;
	return stringAt(toolInput, "command");
}

export interface Location {
	readonly outsideRepository: boolean;
	/** Repository-relative, and absent when the tool named nothing inside the tree. */
	readonly path?: string;
}

/**
 * Where a tool call happened, relative to the repository under contract.
 *
 * With no binding, everything is outside: a session whose `session-start` never
 * bound a repository has nothing to be relative to, and guessing that the cwd
 * is the tree would put a stranger's paths on a contract.
 */
export function locate(binding: RepositoryBinding | null, cwd: string | undefined, named: string | undefined): Location {
	if (binding === null) return { outsideRepository: true };

	const root = resolve(binding.root);
	const inside = (candidate: string): boolean => {
		const step = relative(root, resolve(candidate));
		return step === "" || (!step.startsWith("..") && !isAbsolute(step));
	};

	if (cwd !== undefined && !inside(cwd)) return { outsideRepository: true };
	if (named === undefined) return { outsideRepository: false };

	const absolute = isAbsolute(named) ? named : resolve(cwd ?? root, named);
	if (!inside(absolute)) return { outsideRepository: true };

	const step = relative(root, absolute);
	return { outsideRepository: false, path: step === "" ? "." : step };
}

/* ------------------------------------------------------------------------- *
 * The prompt
 * ------------------------------------------------------------------------- */

/** SHA-256 of the text, as 64 lowercase hex characters. */
export async function digestOf(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The summary: the prompt's redacted opening, whitespace collapsed, bounded.
 *
 * Not a model's summary -- a hook has no model and calling one would put an
 * inference on the critical path of somebody's keystroke. The bound is what
 * makes it a summary rather than the prompt: 512 characters is a sentence about
 * the work and is far too little for a pasted file, which is the distinction
 * `SummarySchema` says it is drawing.
 *
 * Redaction runs BEFORE the cut, so a credential in the first 512 characters is
 * replaced rather than truncated into something shorter that still leaks.
 */
export function summaryOf(prompt: string, limit = 512): string {
	const flattened = redact(prompt).replace(/\s+/gu, " ").trim();
	return flattened.length <= limit ? flattened : `${flattened.slice(0, limit - 1)}…`;
}

/* ------------------------------------------------------------------------- *
 * The tool result
 * ------------------------------------------------------------------------- */

/**
 * The process's exit status, or `null` when none was reported.
 *
 * ==========================================================================
 * NULL WHEN UNKNOWN. NEVER A STAND-IN ZERO.
 * ==========================================================================
 *
 * `PostToolSchema` glosses `null` as "killed before it produced one", and a
 * harness that simply does not report a status is a third case the contract has
 * no spelling for. `null` is used for it anyway, and the direction that choice
 * fails in is what makes it the right one:
 * `packages/orchestration/src/session.ts` reads a green test claim as a
 * `pre_tool` whose command looks like a test runner followed by a `post_tool`
 * with `exitCode === 0`. A `0` invented for "the tool call did not error" would
 * MANUFACTURE a green claim out of a suite that went red -- FD-03's QA collapse,
 * produced by the evidence pipeline itself. `null` produces no claim at all,
 * which under-counts, and an under-count is the direction this whole pipeline
 * is designed to fail in.
 *
 * A hand-off is owed to whoever owns the contract: "not reported" and "killed"
 * deserve different spellings, and today they do not have them.
 */
export function exitCodeIn(toolResponse: HookInput | undefined): number | null {
	if (toolResponse === undefined) return null;

	for (const name of ["exitCode", "exit_code", "returnCode", "return_code", "status", "code"]) {
		const value = toolResponse[name];
		if (typeof value === "number" && Number.isInteger(value)) return value;
	}

	return null;
}

/** Everything textual a tool answered with, concatenated. Never parsed for meaning. */
export function outputTextIn(toolResponse: unknown): string {
	if (typeof toolResponse === "string") return toolResponse;
	if (toolResponse === undefined || toolResponse === null) return "";

	if (typeof toolResponse === "object" && !Array.isArray(toolResponse)) {
		const record = toolResponse as Record<string, unknown>;
		const parts: string[] = [];
		for (const name of ["stdout", "stderr", "output", "content", "text", "message", "error"]) {
			const value = record[name];
			if (typeof value === "string" && value !== "") parts.push(value);
		}
		if (parts.length > 0) return parts.join("\n");
	}

	try {
		return JSON.stringify(toolResponse) ?? "";
	} catch {
		return "";
	}
}

/* ------------------------------------------------------------------------- *
 * The events
 * ------------------------------------------------------------------------- */

/**
 * One event, or `null` when the payload cannot produce one.
 *
 * `null` rather than a throw for a payload this does not recognise: a hook that
 * failed on an unexpected field would fail inside somebody's editor, and the
 * whole design rests on the hook being unable to interrupt the work.
 */
export function eventFor(kind: HookKind, input: HookInput, context: EventContext): SessionEvent | null {
	const cwd = stringAt(input, "cwd");

	switch (kind) {
		case "session-start": {
			const binding = context.binding;
			if (binding === null) return null;

			return {
				kind: "session_start",
				at: context.at,
				outsideRepository: false,
				repository: binding.repository,
				headSha: binding.headSha,
				branch: binding.branch,
				// The model is on the contract because it is "part of what makes a
				// transcript replayable". When the harness does not say, the fact
				// recorded is that it did not say.
				modelId: context.modelId ?? "unknown",
			};
		}

		case "prompt": {
			// Built by `promptEvent` because the digest is async and this function
			// is not. Reaching it through the wrong door returns nothing rather
			// than an event with a made-up digest.
			return null;
		}

		case "pre-tool": {
			const tool = stringAt(input, "tool_name", "toolName");
			if (tool === undefined) return null;

			const toolInput = recordAt(input, "tool_input") ?? recordAt(input, "toolInput");
			const where = locate(context.binding, cwd, toolPathIn(toolInput));
			const command = toolCommandIn(toolInput);

			return {
				kind: "pre_tool",
				at: context.at,
				outsideRepository: where.outsideRepository,
				tool,
				// Both dropped when outside. The contract refuses them there, and
				// refusing them there is the whole of LB-7's second half.
				...(where.outsideRepository || command === undefined
					? {}
					: { command: redact(command).slice(0, 2048) }),
				...(where.path === undefined ? {} : { path: where.path.slice(0, 1024) }),
			};
		}

		case "post-tool": {
			const tool = stringAt(input, "tool_name", "toolName");
			if (tool === undefined) return null;

			const toolInput = recordAt(input, "tool_input") ?? recordAt(input, "toolInput");
			const response = input["tool_response"] ?? input["toolResponse"];
			const where = locate(context.binding, cwd, toolPathIn(toolInput));
			const text = outputTextIn(response);

			return {
				kind: "post_tool",
				at: context.at,
				outsideRepository: where.outsideRepository,
				tool,
				exitCode: exitCodeIn(recordAt(input, "tool_response") ?? recordAt(input, "toolResponse")),
				// Bytes, not characters: the count is about what came back, and a
				// multi-byte character is more bytes than it is characters.
				bytesOut: new TextEncoder().encode(text).length,
				...(where.path === undefined ? {} : { path: where.path.slice(0, 1024) }),
				...(text === "" ? {} : { excerpt: excerptOf(text).slice(0, 8192) }),
			};
		}

		case "stop":
			return { kind: "stop", at: context.at, outsideRepository: false };

		case "session-end": {
			const headSha = context.headSha ?? context.binding?.headSha;
			// No head means no repository, and `SessionEndSchema` requires one. An
			// event that cannot be built honestly is not built.
			if (headSha === undefined) return null;

			return {
				kind: "session_end",
				at: context.at,
				outsideRepository: false,
				headSha,
				dirty: context.dirty ?? false,
				elapsedMs: Math.max(0, Math.trunc(context.elapsedMs ?? 0)),
			};
		}
	}
}

/** The prompt event, which needs a digest and therefore a promise. */
export async function promptEvent(input: HookInput, context: EventContext): Promise<SessionEvent | null> {
	const prompt = stringAt(input, "prompt", "user_prompt", "userPrompt");
	if (prompt === undefined) return null;

	return {
		kind: "prompt",
		at: context.at,
		outsideRepository: false,
		// The digest is over the prompt AS TYPED, before redaction: it answers
		// "was this the same prompt as that one", and a digest of a redacted
		// string would answer it for a string nobody typed.
		digestSha256: await digestOf(prompt),
		summary: summaryOf(prompt),
	};
}
