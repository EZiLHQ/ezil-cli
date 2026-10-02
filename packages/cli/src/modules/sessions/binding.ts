import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RepositoryBinding } from "./events";
import { bindingPath } from "../../core/paths";

/**
 * What a session bound at its start, on disk.
 *
 * Its own module rather than a corner of `hook.ts`, because `flush.ts` reads it
 * too -- to refuse to send a session that ran in a different repository than the
 * one today's contract names -- and `hook.ts` imports `node:child_process`,
 * which the flush path has no business pulling in.
 */
export interface StoredBinding extends RepositoryBinding {
	readonly startedAtMs: number;
}

export function writeBinding(projectRoot: string, sessionId: string, binding: StoredBinding): void {
	const file = bindingPath(projectRoot, sessionId);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(binding)}\n`, { encoding: "utf8" });
}

export function readBinding(projectRoot: string, sessionId: string): StoredBinding | null {
	const file = bindingPath(projectRoot, sessionId);
	if (!existsSync(file)) return null;

	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;

		const record = parsed as Record<string, unknown>;
		const repository = record["repository"];
		const root = record["root"];
		const headSha = record["headSha"];
		const branch = record["branch"];
		const startedAtMs = record["startedAtMs"];

		if (typeof repository !== "string" || typeof root !== "string") return null;
		if (typeof headSha !== "string" || typeof branch !== "string") return null;

		return { repository, root, headSha, branch, startedAtMs: typeof startedAtMs === "number" ? startedAtMs : 0 };
	} catch {
		return null;
	}
}
