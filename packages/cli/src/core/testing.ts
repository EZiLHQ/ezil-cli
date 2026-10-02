import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliSession, Io, SessionStore } from "./session";

/** Test doubles shared by the core and module tests: a memory session store and a scripted API. */
let home = "";
/** Call from each test file: a fresh EZIL_HOME per test. */
export function useTempHome(): void {
	beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ezil-cli-")); });
	afterEach(() => { rmSync(home, { recursive: true, force: true }); });
}

export const ORIGIN = "https://api.test";
export const GRANT = `egg_${"a".repeat(64)}`;
export function memoryStore(initial?: CliSession): SessionStore & { value: CliSession | null } {
	const store = { kind: "memory", value: initial ?? null as CliSession | null,
		read: () => store.value, write: (s: CliSession) => { store.value = s; }, remove: () => { store.value = null; } };
	return store;
}
export const session = (over: Partial<CliSession> = {}): CliSession => ({ apiOrigin: ORIGIN, sessionId: "s-1", refreshToken: "ecr_r1", accessToken: "eca_a1",
	accessExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), ...over });

export function io(handler: (path: string, body: Record<string, unknown> | null, auth: string | null) => Response | Promise<Response>, store = memoryStore()) {
	const calls: Array<{ path: string; body: Record<string, unknown> | null; auth: string | null }> = [];
	const out: string[] = []; const err: string[] = []; const ran: string[][] = []; const opened: string[] = [];
	const value: Io = {
		env: { HOME: home, EZIL_HOME: join(home, ".ezil"), EZIL_API_ORIGIN: ORIGIN }, now: Date.now,
		fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
			const path = String(input).slice(ORIGIN.length);
			const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
			const auth = new Headers(init.headers).get("authorization");
			calls.push({ path, body, auth });
			return handler(path, body, auth);
		}) as typeof fetch,
		out: l => out.push(l), err: l => err.push(l), sleep: async () => {}, openBrowser: u => opened.push(u),
		run: cmd => { ran.push(cmd); return { code: 0, stdout: "" }; }, store,
	};
	return { io: value, calls, out, err, ran, opened, store };
}
export const tokens = (n: number) => Response.json({ access_token: `eca_a${n}`, refresh_token: `ecr_r${n}`, session_id: "s-1",
	expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
