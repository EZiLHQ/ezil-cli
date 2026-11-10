import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { CloneRecoveryRequired, cloneWithGrant, type CloneTransport, type CloneGrant } from "./clone-transport";
import { canonicalRepository, readPrivateGrant, validatePrivateGrant } from "./private-grant-v2";

export interface StandaloneIo { out(line: string): void; run(command: string[]): { code: number; stdout: string } }
export interface StandaloneCloneOptions { grantFd: number; directory: string; json: true; signal?: AbortSignal }
class CloneError extends Error {
 readonly code: string;
 readonly exit: number;
 constructor(code: string, message: string, exit = 1) { super(message); this.code = code; this.exit = exit; }
}
function fail(code: string, message: string, exit = 1): never { throw new CloneError(code, message, exit); }

/** Inspection never inherits Git environment selectors or replacement config. */
function inspectGit(command: string[]): {code: number; stdout: string} {
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
 try {
  const result = spawnSync(command[0]!, ["-c", "core.hooksPath=/dev/null", ...command.slice(1)], {env: {...env, GIT_CONFIG_NOSYSTEM:"1", GIT_CONFIG_GLOBAL:"/dev/null", GIT_CONFIG_COUNT:"0"}, encoding:"utf8", stdio:["ignore","pipe","ignore"]});
  return {code:result.status ?? 1, stdout:result.stdout ?? ""};
 } catch { return {code:127, stdout:""}; }
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

/** A ref mismatch never changes a checkout, including dirty files or local commits. */
function verifyCheckoutRef(io: StandaloneIo, folder: string, ref: string, fresh: boolean): void {
    const head = io.run(["git", "-C", folder, "symbolic-ref", "--quiet", "HEAD"]);
    if (head.code !== 0 || head.stdout.trim() !== ref) fail("repository-ref-mismatch", "Checkout does not match the authorized branch. Existing files were preserved.", 2);
    if (fresh) {
        const local = io.run(["git", "-C", folder, "rev-parse", "--verify", `${ref}^{commit}`]);
        const remote = io.run(["git", "-C", folder, "rev-parse", "--verify", `refs/remotes/origin/${ref.slice("refs/heads/".length)}^{commit}`]);
        if (local.code !== 0 || remote.code !== 0 || !local.stdout.trim() || local.stdout.trim() !== remote.stdout.trim()) {
            fail("repository-ref-mismatch", "Clone does not match the authorized branch.", 2);
        }
    }
}

async function openRepository(io: StandaloneIo, canonicalUrl: string, folder: string, authorize: () => Promise<CloneGrant>, transport: CloneTransport, signal?: AbortSignal, authoritativeRef?: string): Promise<"cloned" | "reused"> {
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
	let recoveryRequired = false;
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
            if (authoritativeRef) verifyCheckoutRef(io, folder, authoritativeRef, false);
			signal?.throwIfAborted();
			return "reused";
		}
		temporary = mkdtempSync(join(dirname(folder), ".ezil-clone-"));
		ownedTemporary = lstatSync(temporary);
		const checkout = join(temporary, "checkout");
		const grant = await authorize();
		const code = await transport(canonicalUrl, checkout, grant, signal, authoritativeRef);
		signal?.throwIfAborted();
		if (code !== 0) fail("clone-failed", "Could not clone the repository. Check Git and your repository access, then try again.");
		if (authoritativeRef) verifyCheckoutRef(io, checkout, authoritativeRef, true);
		safeFolder(folder);
		// Exclusive reservation prevents replacing a destination created during the clone.
		try { mkdirSync(folder, { mode: 0o700 }); } catch { fail("destination-conflict", "Destination appeared during clone; nothing was replaced."); }
		reservation = lstatSync(folder);
		renameSync(checkout, folder);
		reservation = undefined;
		return "cloned";
	} catch (error) {
		recoveryRequired = error instanceof CloneRecoveryRequired;
		throw error;
	} finally {
		if (!recoveryRequired) {
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
}

/** Standalone Git capability path. It does not read auth state or call any application API. */
export async function standaloneClone(repository: string, options: StandaloneCloneOptions, out: (line: string) => void, transport: CloneTransport = cloneWithGrant): Promise<number> {
 const signal = options.signal;
 const io: StandaloneIo = {out, run:inspectGit};
 try {
  signal?.throwIfAborted();
  if (!canonicalRepository(repository)) fail("invalid-repository", "Use the exact canonical HTTPS repository URL.", 2);
  if (!options.json || options.grantFd !== 3) fail("invalid-arguments", "Private grants require JSON output and inherited descriptor 3.", 2);
  if (!isAbsolute(options.directory) || options.directory.includes("\0") || options.directory.includes("\\") || options.directory.split("/").includes("..") || resolve(options.directory) === parse(options.directory).root) {
   fail("invalid-directory", "Directory must be an absolute destination without traversal.", 2);
  }
  let packet: unknown;
  try { packet = await readPrivateGrant(options.grantFd, signal); validatePrivateGrant(packet, repository); }
  catch { fail("repository-not-authorized", "Invalid or expired repository grant.", 2); }
  const authorize = async (): Promise<CloneGrant> => {
   signal?.throwIfAborted();
   try { return validatePrivateGrant(packet, repository).grant; }
   catch { fail("repository-not-authorized", "Invalid or expired repository grant.", 2); }
  };
  const folder = resolve(options.directory);
  const approved = validatePrivateGrant(packet, repository);
  const status = await openRepository(io, repository, folder, authorize, transport, signal, approved.repository.ref);
  signal?.throwIfAborted();
  io.out(JSON.stringify({canonicalUrl: repository, folder, repository: approved.repository, identity: approved.identity, status}));
  return 0;
 } catch (error) {
  const failure = error instanceof CloneRecoveryRequired ? new CloneError("clone-failed", error.message) : signal?.aborted ? new CloneError("clone-failed", "Repository open cancelled.") : error instanceof CloneError ? error : new CloneError("clone-failed", "Could not open the repository.");
  out(JSON.stringify({error:{code:failure.code,message:failure.message}}));
  return failure.exit;
 }
}
