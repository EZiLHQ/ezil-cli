import { accessToken, api, apiOriginOf, type Io } from "../../core/session";
import type { SetupStep } from "../../core/auth";

/**
 * The built-in git module: stock Git against github.ezil.work, with `ezil git-credential` as the
 * credential helper. Git asks the helper for a credential per repository, and the helper hands back a
 * ≤15-minute EZiL grant for exactly that repository. The server half is `apps/git-gateway`.
 */

export const GIT_HOSTS = ["github.ezil.work", "git.ezil.work"] as const;

/** The git config `ezil auth login` writes, shown to the user before it's applied. */
export function gitConfigCommands(): string[][] {
	return GIT_HOSTS.flatMap(host => [
		// An empty value first resets any helpers inherited for this host (osxkeychain, GCM), so no grant is ever stored.
		["git", "config", "--global", "--replace-all", `credential.https://${host}.helper`, ""],
		["git", "config", "--global", "--add", `credential.https://${host}.helper`, "!ezil git-credential"],
		["git", "config", "--global", `credential.https://${host}.useHttpPath`, "true"],
	]);
}

/** What `ezil auth login` configures for git once the device is signed in. */
export function gitSetup(): SetupStep {
	return { title: "Configuring git for github.ezil.work:", commands: gitConfigCommands(),
		done: "Done. Clone with: git clone https://github.ezil.work/<namespace>/<repo>.git (see `ezil whoami`)." };
}

/**
 * The git credential-helper protocol (gitcredentials(7)). Reads `key=value` lines on stdin.
 * `get` prints a grant for github.ezil.work and nothing for any other host. It always exits 0,
 * because a non-zero exit makes git abort instead of falling back. Errors go to stderr only.
 */
export async function gitCredential(io: Io, operation: string, stdin: string): Promise<number> {
	if (operation !== "get") return 0; // store/erase: nothing is ever kept, so there is nothing to do
	const fields = Object.fromEntries(stdin.split("\n").map(l => l.split(/=(.*)/s)).filter(p => p.length >= 2).map(p => [p[0]!, p[1]!]));
	let host = (fields["host"] ?? "").toLowerCase();
	// Test hook only: a local gateway on plain HTTP stands in for github.ezil.work in the end-to-end suite.
	// Loopback only, so a mistyped or hostile setting can never hand a grant to a plain-http host on the network.
	const testHost = io.env["EZIL_GIT_TEST_HOST"];
	if (testHost && /^(127\.0\.0\.1|localhost):\d{1,5}$/.test(testHost) && fields["protocol"] === "http" && host === testHost.toLowerCase()) {
		fields["protocol"] = "https"; host = GIT_HOSTS[0];
	}
	if (fields["protocol"] !== "https" || !(GIT_HOSTS as readonly string[]).includes(host)) return 0;
	if (!fields["path"]) { io.err("ezil: set `git config --global credential.https://github.ezil.work.useHttpPath true` (ezil auth login does this)."); return 0; }
	try {
		const live = await accessToken(io);
		if (!live) { io.err("ezil: not signed in. Run `ezil auth login`."); return 0; }
		const grant = await api<{ username: string; password: string; password_expiry_utc: number }>(io, apiOriginOf(io.env), "/cli/git-grant",
			{ token: live.token, body: { protocol: "https", host, path: fields["path"] } });
		io.out(`username=${grant.username}`);
		io.out(`password=${grant.password}`);
		io.out(`password_expiry_utc=${grant.password_expiry_utc}`);
	} catch (error) {
		io.err(`ezil: ${error instanceof Error ? error.message : "could not get a Git credential."}`);
	}
	return 0;
}
