import { hostname, platform } from "node:os";

import pkg from "../../package.json" with { type: "json" };
import { accessToken, api, ApiError, apiOriginOf, sessionFrom, storeFor, type Io, type TokenResponse } from "./session";

/**
 * `ezil auth login|logout|status|sessions` and `ezil whoami`: signing this device in to EZiL.
 *
 * Login is a device code the builder approves in the browser. After sign-in, each built-in module
 * may contribute a setup step (the git module registers its credential helper); the commands are
 * shown before they run, so nothing is configured behind the user's back.
 */

/** A module's post-sign-in configuration: shown, then run in order. */
export interface SetupStep {
	readonly title: string;
	readonly commands: readonly (readonly string[])[];
	readonly done: string;
}

export async function login(io: Io, setup: readonly SetupStep[] = []): Promise<number> {
	const origin = apiOriginOf(io.env);
	const os = (["darwin", "linux", "win32", "freebsd"] as const).find(p => p === platform()) ?? "other";
	const device = { deviceLabel: (io.env["EZIL_DEVICE_LABEL"] ?? hostname()).slice(0, 80) || "device", os, cliVersion: io.env["EZIL_CLI_VERSION"] ?? pkg.version };
	const started = await api<{ deviceCode: string; userCode: string; verificationUriComplete: string; verificationUri: string; expiresAt: string; interval: number }>(
		io, origin, "/cli/login/device", { body: device });
	io.out(`To sign in, open ${started.verificationUri} and enter the code:  ${started.userCode}`);
	io.openBrowser(started.verificationUriComplete);
	const until = Date.parse(started.expiresAt);
	while (io.now() < until) {
		await io.sleep(started.interval * 1000);
		try {
			const t = await api<TokenResponse>(io, origin, "/cli/token", { body: { grant_type: "device_code", device_code: started.deviceCode } });
			const session = sessionFrom(origin, t);
			const store = storeFor(io);
			store.write(session);
			if (store.kind.startsWith("file")) io.err(`Note: no OS keychain found; the sign-in is stored in ${store.kind}, readable by your user only.`);
			io.out("Signed in.");
			for (const step of setup) {
				io.out(step.title);
				for (const cmd of step.commands) {
					io.out(`  ${cmd.map(a => a === "" ? '""' : a.includes(" ") ? `"${a}"` : a).join(" ")}`);
					const result = io.run([...cmd]);
					if (result.code !== 0) { io.err("Could not apply the commands above; run them yourself."); return 1; }
				}
				io.out(step.done);
			}
			return 0;
		} catch (error) {
			if (error instanceof ApiError && error.code === "authorization_pending") continue;
			io.err(error instanceof Error ? error.message : "Sign-in failed.");
			return 1;
		}
	}
	io.err("The code expired before it was approved. Run `ezil auth login` again.");
	return 1;
}

export async function logout(io: Io): Promise<number> {
	const origin = apiOriginOf(io.env);
	const store = storeFor(io);
	const present = store.read(origin) !== null;
	const live = await accessToken(io).catch(() => null);
	// Revoke on the server first; the local copy is removed either way, and the person is told which happened.
	const revoked = live ? await api(io, origin, "/cli/logout", { method: "POST", token: live.token, body: {} }).then(() => true, () => false) : false;
	store.remove(origin);
	if (!present) { io.out("Not signed in on this device."); return 0; }
	if (revoked) { io.out("Signed out: this device's session is revoked."); return 0; }
	io.err("Removed the sign-in from this device, but EZiL could not be reached to revoke the session.");
	io.err("Revoke it from another signed-in device with `ezil auth sessions revoke <id>`, or it expires on its own.");
	return 1;
}

interface Whoami { account: { email: string; role: string }; session: { id: string; device: string; expiresAt: string };
	repositories: Array<{ project: string; repository: string; access: string; cloneUrl: string }> }

export async function whoami(io: Io): Promise<number> {
	const live = await accessToken(io);
	if (!live) { io.err("Not signed in. Run `ezil auth login`."); return 1; }
	const me = await api<Whoami>(io, apiOriginOf(io.env), "/cli/whoami", { token: live.token });
	io.out(`${me.account.email} (${me.account.role}) on ${me.session.device}`);
	if (me.repositories.length === 0) { io.out("No repositories yet."); return 0; }
	io.out("Repositories:");
	for (const r of me.repositories) io.out(`  ${r.access === "write" ? "rw" : "r "}  ${r.cloneUrl}   (${r.project})`);
	return 0;
}

export async function sessions(io: Io, revoke?: string): Promise<number> {
	const live = await accessToken(io);
	if (!live) { io.err("Not signed in. Run `ezil auth login`."); return 1; }
	const origin = apiOriginOf(io.env);
	if (revoke) { await api(io, origin, `/cli/sessions/${encodeURIComponent(revoke)}`, { method: "DELETE", token: live.token }); io.out("Revoked."); return 0; }
	const list = await api<{ sessions: Array<{ publicId: string; deviceLabel: string; os: string; lastUsedAt: string; revokedAt: string | null; current: boolean }> }>(
		io, origin, "/cli/sessions", { token: live.token });
	for (const s of list.sessions) io.out(`${s.current ? "*" : " "} ${s.publicId}  ${s.deviceLabel} (${s.os})  last used ${s.lastUsedAt}${s.revokedAt ? "  [revoked]" : ""}`);
	return 0;
}
