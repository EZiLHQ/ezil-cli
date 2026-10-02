/**
 * The six hooks, merged into a project's `.claude/settings.json`.
 *
 * ==========================================================================
 * MERGE. NEVER CLOBBER.
 * ==========================================================================
 *
 * `.claude/settings.json` is the client's file. It may already carry
 * permissions, an MCP server list, environment variables, and hooks somebody
 * else's tooling installed. A `connect` that wrote its own document over it
 * would break whatever was there, and it would break it silently, in a file
 * people forget they have.
 *
 * So this module is a pure function from the existing document to the next one.
 * It is pure for the same reason `events.ts` is: the interesting cases -- an
 * unrelated `PreToolUse` matcher, a hook already installed, a file that is not
 * an object at all -- are cases nobody wants to build a directory for.
 *
 * ## What Claude Code's shape is, and what is assumed about it
 *
 * ```json
 * { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "…" } ] } ] } }
 * ```
 *
 * An event maps to an array of GROUPS; a group has an optional `matcher` and an
 * array of hook entries. Unrecognised keys at every level are preserved
 * untouched, which is what makes this safe against a version of Claude Code
 * that has fields this file has never heard of.
 *
 * ## Idempotent, because `connect` is run twice
 *
 * A worker reconnects after changing machines, after a token expires, after
 * following the README again. Installing a second copy of the same command
 * would run every hook twice and double every event in the spool. A group whose
 * matcher matches and whose entries already contain the same command is left
 * exactly as it is.
 */

/** The tools a session's file-and-shell activity comes through. */
export const TOOL_MATCHER = "Bash|Edit|Write|MultiEdit";

export interface HookCommand {
	readonly type: "command";
	readonly command: string;
}

export interface HookGroup {
	readonly matcher?: string;
	readonly hooks: readonly HookCommand[];
}

/** The six moments, and the command each one runs. */
export interface DesiredHook {
	readonly event: string;
	readonly matcher?: string;
	readonly command: string;
}

/**
 * What `connect` installs.
 *
 * `PreToolUse` and `PostToolUse` carry a matcher and the other four do not:
 * those four fire once per session or per turn, and a matcher on them would be
 * matched against nothing.
 */
export function desiredHooks(binary = "ezil"): readonly DesiredHook[] {
	return Object.freeze([
		{ event: "SessionStart", command: `${binary} hook session-start` },
		{ event: "UserPromptSubmit", command: `${binary} hook prompt` },
		{ event: "PreToolUse", matcher: TOOL_MATCHER, command: `${binary} hook pre-tool` },
		{ event: "PostToolUse", matcher: TOOL_MATCHER, command: `${binary} hook post-tool` },
		{ event: "Stop", command: `${binary} hook stop` },
		{ event: "SessionEnd", command: `${binary} hook session-end` },
	]);
}

export interface MergeResult {
	/** The whole settings document, ready to be written. */
	readonly settings: Record<string, unknown>;
	/** Which hooks this merge added, by command. */
	readonly added: readonly string[];
	/** Which were already there and were left alone. */
	readonly alreadyPresent: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? [...(value as unknown[])] : [];
}

/** Whether a group already runs this exact command. */
function groupRuns(group: unknown, command: string): boolean {
	const entries = asArray(asRecord(group)["hooks"]);
	return entries.some((entry) => asRecord(entry)["command"] === command);
}

/** Whether a group is the one this hook belongs in: same matcher, or both absent. */
function matcherMatches(group: unknown, matcher: string | undefined): boolean {
	const declared = asRecord(group)["matcher"];
	if (matcher === undefined) return declared === undefined || declared === "";
	return declared === matcher;
}

/**
 * Merge the hooks into an existing settings document.
 *
 * The input is `unknown` on purpose: this is handed whatever `JSON.parse` of
 * somebody else's file produced, including `null`, an array, or a number. A
 * document that is not an object is replaced -- there is nothing to preserve in
 * a settings file that is the number 4 -- and every other shape is kept.
 */
export function mergeHooks(existing: unknown, hooks: readonly DesiredHook[] = desiredHooks()): MergeResult {
	const settings = asRecord(existing);
	const allHooks = asRecord(settings["hooks"]);

	const added: string[] = [];
	const alreadyPresent: string[] = [];

	for (const hook of hooks) {
		const groups = asArray(allHooks[hook.event]);

		const target = groups.findIndex((group) => matcherMatches(group, hook.matcher));

		if (target >= 0) {
			const group = asRecord(groups[target]);
			if (groupRuns(group, hook.command)) {
				alreadyPresent.push(hook.command);
				continue;
			}

			// Appended, never prepended and never replacing: whatever else the
			// client runs on this event runs first and keeps running.
			group["hooks"] = [...asArray(group["hooks"]), { type: "command", command: hook.command }];
			groups[target] = group;
			added.push(hook.command);
		} else {
			const group: Record<string, unknown> = { hooks: [{ type: "command", command: hook.command }] };
			if (hook.matcher !== undefined) group["matcher"] = hook.matcher;
			groups.push(group);
			added.push(hook.command);
		}

		allHooks[hook.event] = groups;
	}

	settings["hooks"] = allHooks;

	return { settings, added, alreadyPresent };
}

/**
 * The command a hook group would run, for a reader that wants to check.
 *
 * Exported so `connect` can print what it installed out of the merged document
 * rather than out of its own intention -- the difference between telling
 * somebody what is in their file and telling them what you meant to put there.
 */
export function installedCommands(settings: unknown): readonly string[] {
	const allHooks = asRecord(asRecord(settings)["hooks"]);
	const found: string[] = [];

	for (const groups of Object.values(allHooks)) {
		for (const group of asArray(groups)) {
			for (const entry of asArray(asRecord(group)["hooks"])) {
				const command = asRecord(entry)["command"];
				if (typeof command === "string") found.push(command);
			}
		}
	}

	return found;
}
