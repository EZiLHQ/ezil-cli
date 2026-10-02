import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SessionEventSchema } from "@ezil/cli-contract/session-evidence";

import { HOOK_KINDS, type RepositoryBinding } from "./events";
import { hookOutcome, promptOutcome, readBinding, repositoryFromRemote, sessionIdOf, writeBinding } from "./hook";
import { hookLogPath, spoolPath } from "../../core/paths";
import { readSpool } from "./spool";

/**
 * The hook, as a decision and as a process.
 *
 * The second half is the one that matters most and is the easiest to skip: the
 * three constraints in `hook.ts`'s header -- nothing on stdout, always exit 0,
 * no blocking call -- are properties of a PROCESS, and a unit test that called
 * `hookOutcome` directly would prove none of them. So the bin is actually
 * spawned, with real JSON on its stdin, and its stdout and status are read.
 *
 * `UserPromptSubmit` is why: that hook's stdout is injected into the model's
 * context, so one stray `console.log` anywhere in the import graph arrives in
 * somebody's conversation as though they had typed it.
 */

const BIN = join(import.meta.dir, "..", "..", "..", "bin", "ezil.ts");
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ezil-hook-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function binding(): RepositoryBinding {
	return { repository: "ezil/works", root, headSha: HEAD, branch: "main" };
}

/* ------------------------------------------------------------------------- *
 * The decision
 * ------------------------------------------------------------------------- */

describe("hookOutcome", () => {
	it("binds the repository at session start and spools a session_start", () => {
		const outcome = hookOutcome({
			kind: "session-start",
			input: { session_id: "s1", cwd: root, model: { id: "claude-opus-5" } },
			projectRoot: root,
			binder: () => binding(),
			nowMs: 1_000_000,
		});

		expect(outcome.appended?.kind).toBe("session_start");
		expect(readBinding(root, "s1")?.repository).toBe("ezil/works");
		expect(readSpool(root, "s1")).toHaveLength(1);
	});

	it("spools nothing at all when the tree is not a repository", () => {
		const outcome = hookOutcome({
			kind: "session-start",
			input: { session_id: "s1", cwd: root },
			projectRoot: root,
			binder: () => null,
		});

		expect(outcome.appended).toBeNull();
		expect(existsSync(spoolPath(root, "s1"))).toBe(false);
	});

	it("uses the binding a previous hook wrote, so a tool call knows where it is", () => {
		writeBinding(root, "s1", { ...binding(), startedAtMs: 0 });

		const outcome = hookOutcome({
			kind: "pre-tool",
			input: { session_id: "s1", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src/a.ts") } },
			projectRoot: root,
		});

		expect(outcome.appended).not.toBeNull();
		expect(SessionEventSchema.safeParse(outcome.appended).success).toBe(true);
		expect((outcome.appended as unknown as Record<string, unknown>)["path"]).toBe("src/a.ts");
	});

	it("measures elapsed time from the binding, not from the payload", () => {
		writeBinding(root, "s1", { ...binding(), startedAtMs: 1_000_000 });

		const outcome = hookOutcome({
			kind: "session-end",
			input: { session_id: "s1", cwd: root },
			projectRoot: root,
			head: () => HEAD,
			dirty: () => true,
			nowMs: 1_060_000,
		});

		const event = outcome.appended as unknown as Record<string, unknown>;
		expect(event["elapsedMs"]).toBe(60_000);
		expect(event["dirty"]).toBe(true);
		expect(outcome.flushAfter).toBe(true);
	});

	it("asks for a flush after stop and session-end, and after nothing else", () => {
		const kinds = HOOK_KINDS.map((kind) => ({
			kind,
			flushAfter: hookOutcome({ kind, input: { session_id: "s1" }, projectRoot: root, binder: () => null }).flushAfter,
		}));

		expect(kinds.filter((entry) => entry.flushAfter).map((entry) => entry.kind)).toEqual(["stop", "session-end"]);
	});

	it("spools nothing when the payload carries no session id", () => {
		const outcome = hookOutcome({ kind: "stop", input: {}, projectRoot: root });
		expect(outcome.sessionId).toBeNull();
		expect(outcome.appended).toBeNull();
	});

	it("spools a prompt as a digest and a summary", async () => {
		writeBinding(root, "s1", { ...binding(), startedAtMs: 0 });

		const outcome = await promptOutcome({
			kind: "prompt",
			input: { session_id: "s1", cwd: root, prompt: "finish AC-01" },
			projectRoot: root,
		});

		expect(outcome.appended?.kind).toBe("prompt");
		expect(readSpool(root, "s1")).toHaveLength(1);
	});
});

describe("sessionIdOf", () => {
	it("takes a path-safe id as it is", () => {
		expect(sessionIdOf({ session_id: "01J8Z9-abc_def.1" })).toBe("01J8Z9-abc_def.1");
	});

	it("replaces what SessionIdSchema would refuse, rather than sending it and being refused", () => {
		expect(sessionIdOf({ session_id: "a/b c" })).toBe("a-b-c");
		expect(sessionIdOf({ session_id: "/leading" })).toBeNull();
		expect(sessionIdOf({})).toBeNull();
	});
});

describe("repositoryFromRemote", () => {
	it("reads owner/name from both remote spellings", () => {
		expect(repositoryFromRemote("git@github.com:ezil/works.git")).toBe("ezil/works");
		expect(repositoryFromRemote("https://github.com/ezil/works.git")).toBe("ezil/works");
		expect(repositoryFromRemote("https://github.com/ezil/works")).toBe("ezil/works");
	});

	it("answers null rather than guessing", () => {
		expect(repositoryFromRemote("not-a-remote")).toBeNull();
	});
});

/* ------------------------------------------------------------------------- *
 * The process
 * ------------------------------------------------------------------------- */

interface Ran {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly elapsedMs: number;
}

function runHook(kind: string, payload: unknown): Ran {
	const started = Date.now();
	const result = spawnSync(process.execPath, [BIN, "hook", kind], {
		cwd: root,
		input: typeof payload === "string" ? payload : JSON.stringify(payload),
		encoding: "utf8",
		env: { ...process.env, EZIL_HOME: join(root, "home") },
		timeout: 30_000,
	});

	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		elapsedMs: Date.now() - started,
	};
}

describe("`ezil hook` as a process", () => {
	/**
	 * The constraint the whole package is subordinate to.
	 *
	 * Asserted for every kind, including the two that spawn a flush, because a
	 * child that inherited stdio would write into the model's context from one
	 * process away.
	 */
	it("writes NOTHING to stdout, for any hook kind", () => {
		for (const kind of HOOK_KINDS) {
			const ran = runHook(kind, { session_id: "s1", cwd: root, tool_name: "Bash", prompt: "hello" });
			expect({ kind, stdout: ran.stdout }).toEqual({ kind, stdout: "" });
		}
	});

	it("exits 0 for every kind, so a PreToolUse hook can never block a tool call", () => {
		for (const kind of HOOK_KINDS) {
			expect({ kind, status: runHook(kind, { session_id: "s1", cwd: root }).status }).toEqual({ kind, status: 0 });
		}
	});

	/**
	 * The positive control for the two above: a run that DOES something still
	 * says nothing. Without it, "stdout was empty" would pass equally against a
	 * binary that fell over before doing any work.
	 */
	it("spools the event while saying nothing", () => {
		const ran = runHook("stop", { session_id: "s1", cwd: root });

		expect(ran.stdout).toBe("");
		expect(ran.status).toBe(0);
		expect(readSpool(root, "s1")).toHaveLength(1);
		expect(readSpool(root, "s1")[0]?.kind).toBe("stop");
	});

	it("exits 0 and says nothing on stdout for input that is not JSON at all", () => {
		const ran = runHook("prompt", "}{ not json");

		expect(ran.stdout).toBe("");
		expect(ran.status).toBe(0);
	});

	it("exits 0 for a hook kind it has never heard of, and records it in the log", () => {
		const ran = runHook("teleport", { session_id: "s1" });

		expect(ran.stdout).toBe("");
		expect(ran.status).toBe(0);
		expect(readFileSync(hookLogPath(root), "utf8")).toContain("unknown hook kind");
	});

	/**
	 * The budget, measured rather than asserted from the brief.
	 *
	 * The target in the brief is ~20 ms. That is the budget for the WORK, and it
	 * is not what a process costs: a cold `bun` start plus this module graph is
	 * the floor, and it is tens of times the work. The bound here is loose on
	 * purpose -- it is a tripwire against something genuinely blocking, such as
	 * a network call creeping into the hook path, not a claim about startup.
	 * The measured figure is reported rather than encoded.
	 */
	it("returns well inside a second, with no network on the path", () => {
		const runs = [1, 2, 3].map(() => runHook("stop", { session_id: "s1", cwd: root }).elapsedMs);
		const median = [...runs].sort((left, right) => left - right)[1] ?? 0;

		expect(median).toBeLessThan(1000);
	});
});
