import { describe, expect, it } from "bun:test";

import { SessionEventSchema } from "@ezil/cli-contract/session-evidence";

import {
	digestOf,
	eventFor,
	exitCodeIn,
	locate,
	outputTextIn,
	promptEvent,
	summaryOf,
	toolCommandIn,
	toolPathIn,
	type EventContext,
	type RepositoryBinding,
} from "./events";

/**
 * The hook's event building, checked against the PINNED contract.
 *
 * Every event this file builds is parsed through `SessionEventSchema` itself
 * rather than compared to a literal written here. That is the whole point: the
 * schema is strict, so an event with a field the contract did not agree to
 * receive fails HERE, on the worker's machine, rather than as a 400 at the end
 * of somebody's day -- and a contract change that this producer has not
 * followed turns this file red rather than production.
 */

const AT = "2026-08-19T09:00:00Z";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const binding: RepositoryBinding = Object.freeze({
	repository: "ezil/works",
	root: "/work/ezil-works",
	headSha: HEAD,
	branch: "main",
});

const context: EventContext = Object.freeze({ at: AT, binding });

/** Parse through the contract, and fail naming the issue rather than "it was null". */
function pinned(event: unknown): Record<string, unknown> {
	const parsed = SessionEventSchema.safeParse(event);
	if (!parsed.success) {
		throw new Error(`the built event is not on the contract: ${JSON.stringify(parsed.error.issues)}`);
	}
	return parsed.data as unknown as Record<string, unknown>;
}

describe("locate", () => {
	it("puts a path inside the repository, relative to its root", () => {
		expect(locate(binding, "/work/ezil-works/apps/api", "src/server.ts")).toEqual({
			outsideRepository: false,
			path: "apps/api/src/server.ts",
		});
	});

	it("accepts an absolute path inside the tree", () => {
		expect(locate(binding, "/work/ezil-works", "/work/ezil-works/docs/TASKS.csv")).toEqual({
			outsideRepository: false,
			path: "docs/TASKS.csv",
		});
	});

	it("marks a cwd outside the tree as outside, and carries no path", () => {
		expect(locate(binding, "/home/someone/personal", "notes.md")).toEqual({ outsideRepository: true });
	});

	/**
	 * The case the field's own wording decides: "the tool acted outside the
	 * repository", not "the shell was elsewhere". Without this, editing
	 * `~/.ssh/config` from inside the tree would be recorded as ordinary
	 * in-repository work with its path dropped for a reason nobody could see.
	 */
	it("marks a path outside the tree as outside, even from a cwd inside it", () => {
		expect(locate(binding, "/work/ezil-works", "/home/someone/.ssh/config")).toEqual({ outsideRepository: true });
	});

	it("is not fooled by a sibling directory whose name is a prefix", () => {
		expect(locate(binding, "/work/ezil-works-notes", "a.md")).toEqual({ outsideRepository: true });
	});

	it("treats everything as outside when no repository was bound", () => {
		expect(locate(null, "/work/ezil-works", "src/a.ts")).toEqual({ outsideRepository: true });
	});
});

describe("eventFor", () => {
	it("builds session_start from the binding, not from the payload", () => {
		const event = pinned(
			eventFor("session-start", { session_id: "s1", cwd: "/work/ezil-works", model: { id: "claude-opus-5" } }, {
				...context,
				modelId: "claude-opus-5",
			}),
		);

		expect(event["kind"]).toBe("session_start");
		expect(event["repository"]).toBe("ezil/works");
		expect(event["headSha"]).toBe(HEAD);
		expect(event["branch"]).toBe("main");
		expect(event["modelId"]).toBe("claude-opus-5");
	});

	it("builds nothing for a session start with no repository", () => {
		expect(eventFor("session-start", { session_id: "s1" }, { at: AT, binding: null })).toBeNull();
	});

	it("builds pre_tool with the tool, a redacted command and a repository-relative path", () => {
		const event = pinned(
			eventFor(
				"pre-tool",
				{
					session_id: "s1",
					cwd: "/work/ezil-works",
					tool_name: "Bash",
					tool_input: { command: "OPENAI_API_KEY=sk-proj-A1b2C3d4E5f6G7h8I9j0 ./tools/test.sh", file_path: "tools/test.sh" },
				},
				context,
			),
		);

		expect(event["tool"]).toBe("Bash");
		expect(event["command"]).toBe("OPENAI_API_KEY=[redacted] ./tools/test.sh");
		expect(event["path"]).toBe("tools/test.sh");
		expect(event["outsideRepository"]).toBe(false);
	});

	it("drops the command AND the path when the tool acted outside the repository", () => {
		const event = pinned(
			eventFor(
				"pre-tool",
				{
					session_id: "s1",
					cwd: "/home/someone/taxes",
					tool_name: "Bash",
					tool_input: { command: "open 2025-return.pdf", file_path: "2025-return.pdf" },
				},
				context,
			),
		);

		expect(event["outsideRepository"]).toBe(true);
		expect(event["command"]).toBeUndefined();
		expect(event["path"]).toBeUndefined();
	});

	it("builds post_tool with a status, a byte count and a redacted excerpt", () => {
		const event = pinned(
			eventFor(
				"post-tool",
				{
					session_id: "s1",
					cwd: "/work/ezil-works",
					tool_name: "Bash",
					tool_input: { command: "./tools/test.sh" },
					tool_response: { exitCode: 1, stdout: "3 fail", stderr: "ghp_16C7e42F292c6912E7710c838347Ae178B4a" },
				},
				context,
			),
		);

		expect(event["exitCode"]).toBe(1);
		expect(event["bytesOut"]).toBe("3 fail\nghp_16C7e42F292c6912E7710c838347Ae178B4a".length);
		expect(String(event["excerpt"])).toContain("3 fail");
		expect(String(event["excerpt"])).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
	});

	it("counts BYTES out, not characters", () => {
		const event = pinned(
			eventFor(
				"post-tool",
				{ session_id: "s1", cwd: "/work/ezil-works", tool_name: "Read", tool_response: { stdout: "café" } },
				context,
			),
		);

		// Five bytes for four characters. A count that said four would be a
		// character count wearing a byte count's name.
		expect(event["bytesOut"]).toBe(5);
	});

	it("builds stop with nothing on it but the instant", () => {
		const event = pinned(eventFor("stop", { session_id: "s1" }, context));
		expect(event["kind"]).toBe("stop");
		expect(Object.keys(event).sort()).toEqual(["at", "kind", "outsideRepository"]);
	});

	it("builds session_end with the head, the dirty flag and the elapsed time", () => {
		const event = pinned(
			eventFor("session-end", { session_id: "s1", cwd: "/work/ezil-works" }, {
				...context,
				headSha: HEAD,
				dirty: true,
				elapsedMs: 1_800_000,
			}),
		);

		expect(event["headSha"]).toBe(HEAD);
		expect(event["dirty"]).toBe(true);
		expect(event["elapsedMs"]).toBe(1_800_000);
	});

	it("builds no event at all when a tool call carries no tool name", () => {
		expect(eventFor("pre-tool", { session_id: "s1" }, context)).toBeNull();
		expect(eventFor("post-tool", { session_id: "s1" }, context)).toBeNull();
	});
});

describe("exitCodeIn", () => {
	it("reads a status the harness reported, under any of its spellings", () => {
		expect(exitCodeIn({ exitCode: 0 })).toBe(0);
		expect(exitCodeIn({ exit_code: 127 })).toBe(127);
		expect(exitCodeIn({ status: 2 })).toBe(2);
	});

	/**
	 * The decision this whole file is most exposed on, asserted directly.
	 *
	 * A `0` invented for "the tool call did not error" would turn a red suite
	 * into a green claim in `crossCheckSession` -- FD-03's QA collapse
	 * manufactured by the evidence pipeline itself. `null` produces no claim.
	 */
	it("answers null when no status was reported, and never zero", () => {
		expect(exitCodeIn({ stdout: "ok", stderr: "" })).toBeNull();
		expect(exitCodeIn(undefined)).toBeNull();
		expect(exitCodeIn({ is_error: false })).toBeNull();
		expect(exitCodeIn({ exitCode: "0" })).toBeNull();
	});
});

describe("outputTextIn", () => {
	it("joins the textual fields a tool answered with", () => {
		expect(outputTextIn({ stdout: "out", stderr: "err" })).toBe("out\nerr");
		expect(outputTextIn("plain")).toBe("plain");
		expect(outputTextIn(undefined)).toBe("");
	});

	it("falls back to the serialised response rather than losing it", () => {
		expect(outputTextIn({ shape: "unknown" })).toBe('{"shape":"unknown"}');
	});
});

describe("toolPathIn / toolCommandIn", () => {
	it("finds the path whatever the tool calls the field", () => {
		expect(toolPathIn({ file_path: "a.ts" })).toBe("a.ts");
		expect(toolPathIn({ notebook_path: "b.ipynb" })).toBe("b.ipynb");
		expect(toolPathIn({ path: "c.md" })).toBe("c.md");
		expect(toolPathIn({})).toBeUndefined();
	});

	it("finds a command only where there is one", () => {
		expect(toolCommandIn({ command: "ls" })).toBe("ls");
		expect(toolCommandIn({ file_path: "a.ts" })).toBeUndefined();
	});
});

describe("the prompt", () => {
	it("carries a digest and a redacted opening, and no verbatim field", async () => {
		const text = "Please finish AC-01. My key is sk-proj-A1b2C3d4E5f6G7h8I9j0, do not use it.";
		const event = pinned(await promptEvent({ session_id: "s1", prompt: text }, context));

		expect(event["digestSha256"]).toBe(await digestOf(text));
		expect(String(event["summary"])).toContain("[redacted]");
		expect(String(event["summary"])).not.toContain("sk-proj-");
		expect(event["verbatim"]).toBeUndefined();
	});

	it("digests the prompt AS TYPED, so the same prompt twice is recognisable", async () => {
		const text = "run the suite";
		const once = pinned(await promptEvent({ session_id: "s1", prompt: text }, context));
		const again = pinned(await promptEvent({ session_id: "s1", prompt: text }, context));

		expect(again["digestSha256"]).toBe(once["digestSha256"]);
		expect(once["digestSha256"]).not.toBe(await digestOf("run the suite "));
	});

	it("bounds the summary at 512 characters, which is what stops a pasted file", () => {
		const pasted = "x".repeat(5000);
		expect(summaryOf(pasted)).toHaveLength(512);
		expect(summaryOf("short one")).toBe("short one");
		expect(summaryOf("  spread \n over \t lines ")).toBe("spread over lines");
	});

	it("builds nothing when the payload carries no prompt", async () => {
		expect(await promptEvent({ session_id: "s1" }, context)).toBeNull();
	});
});
