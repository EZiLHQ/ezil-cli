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
 * ## The keychain is a follow-up, and this says so
 *
 * A 0600 file is the same protection `~/.aws/credentials`, `~/.npmrc` and
 * `gh`'s own hosts file give, and it is worth less than the operating system's
 * keychain: any process running as this user can read it. Storing it in the
 * macOS Keychain / libsecret / Credential Manager is the right end state and is
 * not this task's. `connect` says so out loud when it writes the file, because
 * a limitation the user is not told about is one they cannot decide about.
 */

export interface StoredCredentials {
	readonly accessToken: string;
	/**
	 * Real after a sign-in, and `null` after `--token`.
	 *
	 * This comment used to say the field was "absent, and the field exists so
	 * that it is visibly absent", because `apps/api/src/routes/identity.ts`
	 * served no sign-in or refresh route at all and there was nothing to
	 * exchange a refresh token with. **`docs/TASKS.csv` T8 landed
	 * `POST /auth/refresh`**, and W6's `connect` signs in through
	 * `POST /auth/signin`, which answers a refresh token -- so the field now
	 * holds one whenever the session was obtained that way.
	 *
	 * `null` is still a real and ordinary value: the `--token` escape hatch
	 * takes a bearer somebody pasted, and a pasted bearer arrives with nothing
	 * attached to refresh it with. Recovery from an expired token on that path
	 * is `ezil connect` again; `flush.ts` says so where it hits a 401.
	 *
	 * Nothing in this package spends the refresh token yet -- storing it is
	 * what makes an automatic re-auth possible later, and doing that re-auth is
	 * a change to `flush.ts`, which W6 does not own.
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
