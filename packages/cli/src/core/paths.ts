import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where everything on disk lives, in one file.
 *
 * Two roots, and the split is the point:
 *
 *   - **`~/.ezil`** is the worker's, and holds the credential. It is per
 *     person, not per repository, so connecting once covers every project.
 *   - **`<project>/.ezil`** is the repository's, and holds the spool, the log
 *     and the quarantine. A session belongs to the tree it ran in, and a spool
 *     in the home directory would mix two clients' work into one file.
 *
 * `.ezil/` therefore has to be git-ignored by whoever installs this, and the
 * README says so. It is not written into a client's `.gitignore` by `connect`:
 * editing a repository's ignore rules is a change to their tree, and a tool
 * that does that on connect is a tool that gets uninstalled.
 */

/** `~/.ezil`. Overridable for tests via `EZIL_HOME`. */
export function ezilHome(environment: NodeJS.ProcessEnv = process.env): string {
	const override = environment["EZIL_HOME"];
	return override !== undefined && override !== "" ? override : join(homedir(), ".ezil");
}

export function credentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
	return join(ezilHome(environment), "credentials");
}

/** `<project>/.ezil`. The project root is the current working directory. */
export function projectStateDirectory(projectRoot: string): string {
	return join(projectRoot, ".ezil");
}

export function spoolPath(projectRoot: string, sessionId: string): string {
	return join(projectStateDirectory(projectRoot), "spool", `${sessionId}.jsonl`);
}

/**
 * Where the flush cursor for a session lives.
 *
 * A file beside the spool rather than a line inside it: the spool is
 * append-only and written by six different hook invocations, and a cursor
 * rewritten in place inside it would be a truncation racing an append.
 */
export function cursorPath(projectRoot: string, sessionId: string): string {
	return join(projectStateDirectory(projectRoot), "cursor", `${sessionId}.json`);
}

/** What `session-start` bound: the repository, its root, the head and the branch. */
export function bindingPath(projectRoot: string, sessionId: string): string {
	return join(projectStateDirectory(projectRoot), "session", `${sessionId}.json`);
}

export function hookLogPath(projectRoot: string): string {
	return join(projectStateDirectory(projectRoot), "hook.log");
}

export function quarantineDirectory(projectRoot: string): string {
	return join(projectStateDirectory(projectRoot), "quarantine");
}

/** The project's Claude Code settings -- the file `connect` merges into. */
export function claudeSettingsPath(projectRoot: string): string {
	return join(projectRoot, ".claude", "settings.json");
}
