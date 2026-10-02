import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { credentialsPath, ezilHome } from "./paths";

/**
 * The token on disk, and the two rules about it.
 *
 * ==========================================================================
 * 1. NEVER PRINTED.  2. NEVER IN THE REPOSITORY.
 * ==========================================================================
 *
 * A bearer is a credential for everything the worker can do. It is written to
 * `~/.ezil/credentials` with mode 0600 and it is never echoed by any command in
 * this package: `connect` prints the API origin and the contract, and nothing
 * that could be pasted into a chat window.
 *
 * `~/.ezil` and not `<project>/.ezil`, and that is not a preference. The
 * project directory is a git working tree belonging to a client, and a
 * credential written there is one `git add -A` away from being in somebody
 * else's repository forever. The two roots are why `paths.ts` has two roots.
 *
 * ## File storage protection
 *
 * Mode 0600 restricts access to the current user, but any process running as
 * that user can read the file. These session-hook credentials use file storage;
 * `connect` reports that limitation when it writes them.
 */

export interface StoredCredentials {
	readonly accessToken: string;
	/**
	 * Supplied by the Works sign-in route POST /auth/signin; null after `--token`.
	 * A pasted bearer includes no refresh token, so expiration requires running
	 * `ezil connect` again.
	 *
	 * The EZiL Works API supports POST /auth/refresh, but the session flush flow
	 * stores this token without automatically exchanging it.
	 */
	readonly refreshToken: string | null;
	readonly apiOrigin: string;
	/** The contract these hooks are evidence about, as `connect` resolved it. */
	readonly contractPublicId?: string;
	readonly repository?: string;
}

export const CREDENTIALS_MODE = 0o600;

export function writeCredentials(credentials: StoredCredentials, environment: NodeJS.ProcessEnv = process.env): string {
	const home = ezilHome(environment);
	mkdirSync(home, { recursive: true, mode: 0o700 });

	const file = credentialsPath(environment);
	writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: CREDENTIALS_MODE });
	// Written AND chmod'ed: `writeFileSync`'s mode applies only when the file is
	// created, so a file that already existed with looser permissions would keep
	// them and the write would look like it had tightened something.
	chmodSync(file, CREDENTIALS_MODE);

	return file;
}

export function readCredentials(environment: NodeJS.ProcessEnv = process.env): StoredCredentials | null {
	const file = credentialsPath(environment);
	if (!existsSync(file)) return null;

	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;

		const record = parsed as Record<string, unknown>;
		const accessToken = record["accessToken"];
		const apiOrigin = record["apiOrigin"];
		if (typeof accessToken !== "string" || typeof apiOrigin !== "string") return null;

		const refreshToken = record["refreshToken"];
		const contractPublicId = record["contractPublicId"];
		const repository = record["repository"];

		return {
			accessToken,
			refreshToken: typeof refreshToken === "string" ? refreshToken : null,
			apiOrigin,
			...(typeof contractPublicId === "string" ? { contractPublicId } : {}),
			...(typeof repository === "string" ? { repository } : {}),
		};
	} catch {
		return null;
	}
}

/** The file's permission bits, for the test that proves 0600 is real. */
export function credentialsMode(environment: NodeJS.ProcessEnv = process.env): number | null {
	const file = credentialsPath(environment);
	if (!existsSync(file)) return null;
	return statSync(file).mode & 0o777;
}
