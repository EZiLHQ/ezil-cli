import { describe, expect, it } from "bun:test";

import { desiredHooks, installedCommands, mergeHooks, TOOL_MATCHER } from "./settings-merge";

/**
 * The merge into somebody else's settings file.
 *
 * The property that matters is not "our hooks are there" -- it is "everything
 * that was there is still there, and still runs". A connect that silently broke
 * a client's existing tooling would be found out weeks later, in a file people
 * forget they have.
 */

describe("mergeHooks", () => {
	it("installs the six hooks on an empty file", () => {
		const merged = mergeHooks(null);

		expect(merged.added).toHaveLength(6);
		expect([...installedCommands(merged.settings)].sort()).toEqual([...desiredHooks().map((hook) => hook.command)].sort());
	});

	it("matches Bash|Edit|Write|MultiEdit on the two tool events and nothing else", () => {
		const hooks = (mergeHooks(null).settings as { hooks: Record<string, { matcher?: string }[]> }).hooks;

		expect(hooks["PreToolUse"]?.[0]?.matcher).toBe(TOOL_MATCHER);
		expect(hooks["PostToolUse"]?.[0]?.matcher).toBe(TOOL_MATCHER);
		expect(hooks["SessionStart"]?.[0]?.matcher).toBeUndefined();
		expect(hooks["Stop"]?.[0]?.matcher).toBeUndefined();
	});

	/**
	 * The case this whole module exists for.
	 */
	it("preserves an unrelated existing hook, its matcher and its position", () => {
		const existing = {
			permissions: { allow: ["Bash(git status)"] },
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
				PostToolUse: [{ matcher: TOOL_MATCHER, hooks: [{ type: "command", command: "prettier --write" }] }],
			},
		};

		const merged = mergeHooks(existing);
		const settings = merged.settings as {
			permissions: unknown;
			hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
		};

		// The unrelated top-level key is untouched.
		expect(settings.permissions).toEqual({ allow: ["Bash(git status)"] });

		// The unrelated `Bash` matcher group is left exactly as it was, and ours
		// went into a group of its own rather than joining it.
		const pre = settings.hooks["PreToolUse"] ?? [];
		expect(pre[0]?.matcher).toBe("Bash");
		expect(pre[0]?.hooks.map((entry) => entry.command)).toEqual(["my-linter"]);
		expect(pre.some((group) => group.hooks.some((entry) => entry.command === "ezil hook pre-tool"))).toBe(true);

		// The group whose matcher DOES match keeps its own hook, and ours is
		// appended after it -- so whatever the client already ran still runs
		// first.
		const post = settings.hooks["PostToolUse"] ?? [];
		expect(post).toHaveLength(1);
		expect(post[0]?.hooks.map((entry) => entry.command)).toEqual(["prettier --write", "ezil hook post-tool"]);
	});

	it("is idempotent: connecting twice installs nothing a second time", () => {
		const once = mergeHooks(null);
		const twice = mergeHooks(once.settings);

		expect(twice.added).toEqual([]);
		expect(twice.alreadyPresent).toHaveLength(6);
		expect(installedCommands(twice.settings)).toHaveLength(6);
	});

	it("replaces a settings document that is not an object, and keeps one that is", () => {
		expect(installedCommands(mergeHooks(4).settings)).toHaveLength(6);
		expect(installedCommands(mergeHooks([1, 2]).settings)).toHaveLength(6);
		expect(installedCommands(mergeHooks({ env: { A: "1" } }).settings)).toHaveLength(6);
		expect((mergeHooks({ env: { A: "1" } }).settings as { env: unknown }).env).toEqual({ A: "1" });
	});

	it("survives a hooks block whose shapes are wrong", () => {
		const merged = mergeHooks({ hooks: { PreToolUse: "not an array", Stop: [null, 7] } });
		expect(installedCommands(merged.settings)).toContain("ezil hook pre-tool");
		expect(installedCommands(merged.settings)).toContain("ezil hook stop");
	});

	it("uses the binary name it is given, so a bunx invocation installs itself", () => {
		const merged = mergeHooks(null, desiredHooks("bunx @ezil/cli"));
		expect(installedCommands(merged.settings)).toContain("bunx @ezil/cli hook prompt");
	});
});
