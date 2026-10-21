import { hostname, platform } from "node:os";
import { CliConfigResponseSchema, EZIL_ID_ISSUER, ID_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT, TokenRequestSchema, TokenResponseSchema } from "@ezil/cli-contract/cli-api";

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

const EZIL_ID_DEFAULT = { issuer: EZIL_ID_ISSUER, clientId: "Mzvm4piCMAKy3ofhywuQDYstJLcYE3mx", scope: "openid email profile" } as const;

export async function login(io: Io, setup: readonly SetupStep[] = [], options: { legacy?: boolean } = {}): Promise<number> {
	const origin = apiOriginOf(io.env);
	let identity: ReturnType<typeof CliConfigResponseSchema.parse>["identity"] = options.legacy ? null : EZIL_ID_DEFAULT;
	if (!options.legacy) {
		try {
			const config = CliConfigResponseSchema.safeParse(await api(io, origin, "/cli/config"));
			if (!config.success) { io.err("EZiL returned an invalid sign-in configuration."); return 1; }
			identity = config.data.identity;
		} catch (error) {
			if (!(error instanceof ApiError && (error.status === 404 || (error.status === 0 && error.code === "network")))) throw error;
		}
	}
	const os = (["darwin", "linux", "win32", "freebsd"] as const).find(p => p === platform()) ?? "other";
	const device = { deviceLabel: (io.env["EZIL_DEVICE_LABEL"] ?? hostname()).slice(0, 80) || "device", os, cliVersion: io.env["EZIL_CLI_VERSION"] ?? pkg.version };
	if (identity) {
		try {
			const subject = await identityToken(io, identity);
			if (subject === null) return 1;
			const body = TokenRequestSchema.safeParse({ grant_type: TOKEN_EXCHANGE_GRANT, subject_token: subject,
				subject_token_type: ID_TOKEN_TYPE, ...device });
			if (!body.success) { io.err("EZiL ID returned an invalid sign-in token or device details."); return 1; }
			const result = TokenResponseSchema.safeParse(await api(io, origin, "/cli/token", { body: body.data }));
			if (!result.success) { io.err("EZiL returned an invalid device session."); return 1; }
			return completeLogin(io, origin, result.data, setup);
		} catch (error) {
			// Never echo provider payloads, error descriptions, or an exchange response that could contain a token.
			if (error instanceof ApiError && (error.status === 404 || (error.status === 400 && error.code === "invalid_request"))) {
				io.out("This EZiL server does not accept EZiL ID sign-in yet; falling back to the EZiL device code.");
			} else {
				const messages: Record<string, string> = {
					identity_disabled: "EZiL ID is not enabled. Run `ezil auth login --legacy`.",
					identity_token_invalid: "EZiL ID could not verify this sign-in. Run `ezil auth login` again.",
					identity_unverified: "Verify your EZiL ID email before signing in.",
					no_account: "Sign up at app.ezil.work first.",
					account_suspended: "This EZiL account is suspended.",
					identity_unavailable: "EZiL ID is unavailable. Try again shortly.",
				};
				const message = error instanceof ApiError && Object.hasOwn(messages, error.code) ? messages[error.code] : undefined;
				io.err(message ?? (error instanceof ApiError && error.status === 429 ? "Too many sign-in attempts. Try again shortly." : "EZiL ID sign-in failed. Run `ezil auth login` again."));
				return 1;
			}
		}
	}
	const started = await api<{ deviceCode: string; userCode: string; verificationUriComplete: string; verificationUri: string; expiresAt: string; interval: number }>(
		io, origin, "/cli/login/device", { body: device });
	io.out(`To sign in, open ${started.verificationUri} and enter the code:  ${started.userCode}`);
	io.openBrowser(started.verificationUriComplete);
	const until = Date.parse(started.expiresAt);
	while (io.now() < until) {
		await io.sleep(started.interval * 1000);
		try {
			const t = await api<TokenResponse>(io, origin, "/cli/token", { body: { grant_type: "device_code", device_code: started.deviceCode } });
			return completeLogin(io, origin, t, setup);
		} catch (error) {
			if (error instanceof ApiError && error.code === "authorization_pending") continue;
			io.err(error instanceof Error ? error.message : "Sign-in failed.");
			return 1;
		}
	}
	io.err("The code expired before it was approved. Run `ezil auth login` again.");
	return 1;
}

/** Only the EZiL session reaches the store or a module's setup commands. */
function completeLogin(io: Io, origin: string, token: TokenResponse, setup: readonly SetupStep[]): number {
	const store = storeFor(io);
	store.write(sessionFrom(origin, token));
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
}

/** Provider responses stay in memory; only explicitly selected public fields are displayed. */
async function oauth(io: Io, issuer: string, path: string, fields: Record<string, string>) {
	const response = await io.fetch(`${issuer}${path}`, { method: "POST", redirect: "error",
		headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
	const body: unknown = await response.json();
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid EZiL ID response.");
	return { ok: response.ok, body: body as Record<string, unknown> };
}

async function identityToken(io: Io, identity: NonNullable<ReturnType<typeof CliConfigResponseSchema.parse>["identity"]>): Promise<string | null> {
	const startedAt = io.now();
	const started = await oauth(io, identity.issuer, "oauth/device/code", { client_id: identity.clientId, scope: identity.scope });
	const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval = 5 } = started.body;
	if (!started.ok || typeof device_code !== "string" || !device_code || typeof user_code !== "string" || !user_code ||
		typeof verification_uri !== "string" || new URL(verification_uri).protocol !== "https:" ||
		typeof verification_uri_complete !== "string" || new URL(verification_uri_complete).protocol !== "https:" ||
		typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0 ||
		typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) throw new Error("Invalid EZiL ID device code.");
	io.out(`To sign in, open ${verification_uri} and enter the code:  ${user_code}`);
	io.openBrowser(verification_uri_complete);
	const until = startedAt + expires_in * 1000;
	let seconds = interval;
	let waiting = false;
	while (io.now() < until) {
		await io.sleep(Math.min(seconds * 1000, until - io.now()));
		if (io.now() >= until) break;
		const result = await oauth(io, identity.issuer, "oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id: identity.clientId });
		if (result.ok) {
			if (typeof result.body["id_token"] !== "string" || !result.body["id_token"]) {
				io.err("EZiL ID did not return an identity token.");
				return null;
			}
			return result.body["id_token"];
		}
		switch (result.body["error"]) {
			case "authorization_pending":
				if (!waiting) io.out("Waiting for sign-in approval.");
				waiting = true;
				continue;
			case "slow_down":
				seconds += 5;
				io.out(`Sign-in is still pending; checking again in ${seconds} seconds.`);
				continue;
			case "access_denied":
				io.err("Sign-in was declined. Run `ezil auth login` again.");
				return null;
			case "expired_token":
			case "invalid_grant":
				io.err("The code expired before it was approved. Run `ezil auth login` again.");
				return null;
			default: throw new Error("EZiL ID sign-in failed.");
		}
	}
	io.err("The code expired before it was approved. Run `ezil auth login` again.");
	return null;
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
