import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { GitGrantResponseSchema, WhoamiResponseSchema } from "@ezil/cli-contract/cli-api";
import { parseGitRoutePath } from "@ezil/cli-contract/git-gateway";
import { accessToken, api, ApiError, apiOriginOf, type Io } from "../../core/session";

import { cloneWithGrant, type CloneTransport, type CloneGrant } from "./clone-transport";

export interface CloneOptions { directory?: string; json?: boolean; signal?: AbortSignal }
class CloneError extends Error {
	readonly code: string;
	readonly exit: number;
	constructor(code: string, message: string, exit = 1) { super(message); this.code = code; this.exit = exit; }
}
function fail(code: string, message: string, exit = 1): never { throw new CloneError(code, message, exit); }

/** Validate the raw string, before URL parsing can normalize traversal or escapes away. */
export function canonicalRepository(value: string): string | null {
	const prefix = "https://github.ezil.work";
	if (!value.startsWith(`${prefix}/`)) return null;
	const route = parseGitRoutePath(value.slice(prefix.length));
	return route && route.rest === "" ? value : null;
}

function exists(path: string): boolean {
	try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
function stillOwned(path: string, owner: { dev: number; ino: number }): boolean {
	if (!exists(path)) return false;
	const stat = lstatSync(path);
	return !stat.isSymbolicLink() && stat.dev === owner.dev && stat.ino === owner.ino;
}
/** Reject symlinks in every existing component; require a pre-created destination parent. */
function safeFolder(folder: string): void {
	let current = parse(folder).root;
	for (const part of folder.slice(current.length).split("/").filter(Boolean)) {
		current = join(current, part);
		if (exists(current) && (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())) {
			fail("destination-conflict", "Destination must contain only real directories.");
		}
	}
	if (!exists(dirname(folder)) || realpathSync(dirname(folder)) !== dirname(folder)) {
		fail("invalid-directory", "Create the absolute destination parent directory first.", 2);
	}
}

async function openRepository(io: Io, canonicalUrl: string, folder: string, authorize: () => Promise<CloneGrant>, transport: CloneTransport, signal?: AbortSignal): Promise<"cloned" | "reused"> {
	safeFolder(folder);
	const lock = join(dirname(folder), `.${basename(folder)}.ezil-clone-lock`);
	const deadline = Date.now() + 30_000;
	while (true) {
		signal?.throwIfAborted();
		try { mkdirSync(lock, { mode: 0o700 }); break; }
		catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			if (Date.now() >= deadline) fail("destination-busy", "Destination is busy. After a forced stop, recovery is required; no existing state was removed.");
			await delay(100, undefined, { signal });
		}
	}
	const ownedLock = lstatSync(lock);
	let temporary: string | undefined;
	let ownedTemporary: { dev: number; ino: number } | undefined;
	let reservation: { dev: number; ino: number } | undefined;
	try {
		signal?.throwIfAborted();
		safeFolder(folder);
		if (exists(folder)) {
			// Require an ordinary checkout rooted here, never a parent checkout or linked worktree.
			const gitDir = join(folder, ".git");
			if (!exists(gitDir) || lstatSync(gitDir).isSymbolicLink() || !lstatSync(gitDir).isDirectory()) {
				fail("destination-conflict", "Destination is not a matching checkout.");
			}
			const top = io.run(["git", "-C", folder, "rev-parse", "--show-toplevel"]);
			const origin = io.run(["git", "-C", folder, "config", "--local", "--get-all", "remote.origin.url"]);
			if (top.code !== 0 || top.stdout.trim() !== folder || origin.code !== 0 || origin.stdout.trim() !== canonicalUrl) {
				fail("destination-conflict", "Destination is not a matching checkout.");
			}
			await authorize();
			signal?.throwIfAborted();
			return "reused";
		}
		temporary = mkdtempSync(join(dirname(folder), ".ezil-clone-"));
		ownedTemporary = lstatSync(temporary);
		const checkout = join(temporary, "checkout");
		const grant = await authorize();
		const code = await transport(canonicalUrl, checkout, grant, signal);
		signal?.throwIfAborted();
		if (code !== 0) fail("clone-failed", "Could not clone the repository. Check Git and your repository access, then try again.");
		safeFolder(folder);
		// Exclusive reservation prevents replacing a destination created during the clone.
		try { mkdirSync(folder, { mode: 0o700 }); } catch { fail("destination-conflict", "Destination appeared during clone; nothing was replaced."); }
		reservation = lstatSync(folder);
		renameSync(checkout, folder);
		reservation = undefined;
		return "cloned";
	} finally {
		if (reservation && exists(folder)) {
			const stat = lstatSync(folder);
			if (stat.dev === reservation.dev && stat.ino === reservation.ino) {
				// Only our empty reservation, never somebody else's files.
				try { rmdirSync(folder); } catch { /* preserve a changed destination */ }
			}
		}
		if (temporary && ownedTemporary && stillOwned(temporary, ownedTemporary)) rmSync(temporary, { recursive: true, force: true });
		if (stillOwned(lock, ownedLock)) rmdirSync(lock);
	}
}

/** Capture one identity for membership and grant; use that immutable grant for Git. */
export async function clone(io: Io, repository?: string, options: CloneOptions = {}, transport: CloneTransport = cloneWithGrant): Promise<number> {
	const signal = options.signal;
	// Applies to whoami, grants and refresh without changing shared auth behavior.
	const original = io;
	if (signal) io = { ...io,
		fetch: ((input, init) => original.fetch(input, { ...init, signal })) as typeof fetch,
		sleep: async ms => { await delay(ms, undefined, { signal }); },
	};
	try {
		signal?.throwIfAborted();
		const url = repository === undefined ? null : canonicalRepository(repository);
		if (repository !== undefined && !url && /[:/\\?#\x00-\x1f]|^-/u.test(repository)) fail("invalid-repository", "Use a canonical HTTPS repository URL or a repository name.", 2);
		if (options.directory !== undefined && (!isAbsolute(options.directory) || options.directory.includes("\0") || options.directory.split(/[\\/]/).includes("..") || resolve(options.directory) === parse(options.directory).root)) {
			fail("invalid-directory", "Directory must be an absolute destination without traversal.", 2);
		}
		const live = await accessToken(io);
		if (!live) fail("auth-required", "Not signed in. Run `ezil auth login`.");
		signal?.throwIfAborted();
		const parsed = WhoamiResponseSchema.safeParse(await api(io, apiOriginOf(io.env), "/cli/whoami", { token: live.token }));
		if (!parsed.success || parsed.data.repositories.some(r => !canonicalRepository(r.cloneUrl))) fail("invalid-response", "EZiL returned an invalid repository list.");
		const repositories = parsed.data.repositories;
		const routeName = (value: string) => new URL(value).pathname.split("/")[2]!.slice(0, -4);
		const name = repository?.toLowerCase();
		const matches = name === undefined ? repositories : repositories.filter(r => url ? r.cloneUrl === url : routeName(r.cloneUrl).toLowerCase() === name || r.project.toLowerCase() === name);
		if (matches.length !== 1) {
			if (!options.json) {
				if (repositories.length === 0) io.out("No repositories yet.");
				for (const r of repositories) io.out(`  ${routeName(r.cloneUrl)}  (${r.project})  ${r.cloneUrl}`);
			}
			fail(matches.length ? "ambiguous-repository" : "repository-not-authorized", matches.length ? "Choose one repository with `ezil clone <repository>`." : "No matching authorized repository.", 2);
		}
		const selected = matches[0]!;
		const folder = resolve(options.directory ?? routeName(selected.cloneUrl));
		const authorize = async (): Promise<CloneGrant> => {
			signal?.throwIfAborted();
			const route = new URL(selected.cloneUrl);
			const grant = GitGrantResponseSchema.safeParse(await api(io, apiOriginOf(io.env), "/cli/git-grant", {
				token: live.token, body: { protocol: "https", host: route.host, path: route.pathname.slice(1) },
			}));
			if (!grant.success || grant.data.password_expiry_utc * 1000 <= Date.now()) fail("invalid-response", "EZiL returned an invalid repository grant.");
			return grant.data;
		};
		const status = await openRepository(io, selected.cloneUrl, folder, authorize, transport, signal);
		if (options.json) io.out(JSON.stringify({ canonicalUrl: selected.cloneUrl, folder, accountId: parsed.data.account.id, status }));
		else { io.out(`${status === "cloned" ? "Cloned into" : "Reusing"} ${folder}.`); io.out(`Next: cd ${folder} && git push`); }
		return 0;
	} catch (error) {
		const failure = signal?.aborted ? new CloneError("clone-failed", "Repository open cancelled.") : error instanceof CloneError ? error : error instanceof ApiError && error.status === 401 ? new CloneError("auth-required", "Not signed in. Run `ezil auth login`.") : error instanceof ApiError && (error.status === 403 || error.status === 404) ? new CloneError("repository-not-authorized", "Repository access was refused.", 2) : new CloneError("clone-failed", "Could not open the repository.");
		if (options.json) io.out(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
		else io.err(failure.message);
		return failure.exit;
	}
}
