import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

import { ezilHome } from "./paths";

/**
 * The EZiL CLI session: where it is stored, how the API is called, and how the access token is refreshed.
 * Every module (git, sessions, ...) authenticates through this one session. Nothing here ever prints a credential.
 */

export const DEFAULT_API_ORIGIN = "https://api.ezil.work";
const SERVICE = "ezil-cli";

export interface CliSession {
	readonly apiOrigin: string;
	readonly sessionId: string;
	readonly refreshToken: string;
	readonly accessToken: string;
	/** ISO time the access token stops working. */
	readonly accessExpiresAt: string;
}

export interface Io {
	readonly env: NodeJS.ProcessEnv;
	readonly fetch: typeof fetch;
	readonly now: () => number;
	readonly out: (line: string) => void;
	readonly err: (line: string) => void;
	readonly sleep: (ms: number) => Promise<void>;
	readonly openBrowser: (url: string) => void;
	readonly run: (cmd: string[], stdin?: string) => { code: number; stdout: string };
	/** Where the session is stored. Default: the OS keychain when available, else ~/.ezil/cli-session.json (0600). */
	readonly store?: SessionStore;
}

export interface SessionStore {
	readonly kind: string;
	read(apiOrigin: string): CliSession | null;
	write(session: CliSession): void;
	remove(apiOrigin: string): void;
}

export function apiOriginOf(env: NodeJS.ProcessEnv): string {
	return (env["EZIL_API_ORIGIN"] ?? DEFAULT_API_ORIGIN).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** ~/.ezil/cli-session.json at 0600, the fallback when no usable keychain exists. */
export function fileStore(env: NodeJS.ProcessEnv): SessionStore {
	const file = join(ezilHome(env), "cli-session.json");
	const all = (): Record<string, CliSession> => {
		if (!existsSync(file)) return {};
		try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, CliSession>; } catch { return {}; }
	};
	const save = (value: Record<string, CliSession>) => {
		mkdirSync(ezilHome(env), { recursive: true, mode: 0o700 });
		writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
	};
	return {
		kind: `file (${file})`,
		read: origin => all()[origin] ?? null,
		write: session => save({ ...all(), [session.apiOrigin]: session }),
		remove: origin => { const value = all(); delete value[origin]; if (Object.keys(value).length) save(value); else if (existsSync(file)) rmSync(file); },
	};
}

/**
 * Linux Secret Service (libsecret `secret-tool`), which reads the secret on stdin so it never sits in argv.
 * macOS Keychain via `security`. That takes the value as an argument, so it's visible briefly to
 * `ps` for this user only, which is the same exposure the file store has to this user anyway.
 */
export function keychainStore(io: Pick<Io, "run" | "env">): SessionStore | null {
	const os = platform();
	if (io.env["EZIL_CLI_STORE"] === "file") return null;
	if (os === "linux" && io.run(["sh", "-c", "command -v secret-tool"]).code === 0) {
		return {
			kind: "Secret Service (secret-tool)",
			read: origin => { const r = io.run(["secret-tool", "lookup", "service", SERVICE, "origin", origin]); return r.code === 0 && r.stdout ? parse(r.stdout) : null; },
			write: session => { io.run(["secret-tool", "store", "--label=EZiL CLI", "service", SERVICE, "origin", session.apiOrigin], JSON.stringify(session)); },
			remove: origin => { io.run(["secret-tool", "clear", "service", SERVICE, "origin", origin]); },
		};
	}
	if (os === "darwin") {
		return {
			kind: "macOS Keychain",
			read: origin => { const r = io.run(["security", "find-generic-password", "-s", SERVICE, "-a", origin, "-w"]); return r.code === 0 ? parse(r.stdout.trim()) : null; },
			write: session => { io.run(["security", "add-generic-password", "-U", "-s", SERVICE, "-a", session.apiOrigin, "-w", JSON.stringify(session)]); },
			remove: origin => { io.run(["security", "delete-generic-password", "-s", SERVICE, "-a", origin]); },
		};
	}
	return null;
}
function parse(text: string): CliSession | null { try { return JSON.parse(text) as CliSession; } catch { return null; } }
export function storeFor(io: Io): SessionStore { return io.store ?? keychainStore(io) ?? fileStore(io.env); }

/**
 * One refresh at a time per machine. An editor's background fetch and a terminal push can run the
 * helper together, and two refreshes with the same token look like theft, so the server would
 * revoke the session.
 */
async function withLock<T>(io: Io, run: () => Promise<T>): Promise<T> {
	const dir = join(ezilHome(io.env), "cli-refresh.lock");
	mkdirSync(ezilHome(io.env), { recursive: true, mode: 0o700 });
	const deadline = io.now() + 15_000;
	for (;;) {
		try { mkdirSync(dir); break; } catch {
			try { if (io.now() - statSync(dir).mtimeMs > 30_000) { rmdirSync(dir); continue; } } catch { continue; }
			if (io.now() > deadline) throw new Error("Another ezil process is refreshing the sign-in; try again.");
			await io.sleep(100);
		}
	}
	try { return await run(); } finally { try { rmdirSync(dir); } catch { /* already gone */ } }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export async function api<T>(io: Io, origin: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
	let response: Response;
	try {
		response = await io.fetch(`${origin}${path}`, { method: init.method ?? (init.body ? "POST" : "GET"),
			headers: { "content-type": "application/json", "user-agent": "ezil-cli", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
			...(init.body ? { body: JSON.stringify(init.body) } : {}) });
	} catch { throw new ApiError(0, "network", `Could not reach ${origin}.`); }
	const text = await response.text();
	let json: Record<string, unknown> = {};
	try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
	if (!response.ok) throw new ApiError(response.status, String(json["error"] ?? "error"), String(json["message"] ?? `Request failed (${response.status}).`));
	return json as T;
}

export interface TokenResponse { access_token: string; refresh_token: string; expires_at: string; session_id: string }
export const sessionFrom = (origin: string, t: TokenResponse): CliSession =>
	({ apiOrigin: origin, sessionId: t.session_id, refreshToken: t.refresh_token, accessToken: t.access_token, accessExpiresAt: t.expires_at });

/** A live access token, refreshing (once, under the lock) when it's within a minute of expiry. */
export async function accessToken(io: Io): Promise<{ token: string; session: CliSession } | null> {
	const origin = apiOriginOf(io.env);
	const store = storeFor(io);
	const fresh = (s: CliSession | null) => s && Date.parse(s.accessExpiresAt) - io.now() > 60_000;
	const current = store.read(origin);
	if (!current) return null;
	if (fresh(current)) return { token: current.accessToken, session: current };
	return withLock(io, async () => {
		const again = store.read(origin); // another process may have refreshed while we waited
		if (!again) return null;
		if (fresh(again)) return { token: again.accessToken, session: again };
		try {
			const t = await api<TokenResponse>(io, origin, "/cli/token", { body: { grant_type: "refresh_token", refresh_token: again.refreshToken } });
			const next = sessionFrom(origin, t);
			store.write(next);
			return { token: next.accessToken, session: next };
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) { store.remove(origin); return null; }
			throw error;
		}
	});
}

