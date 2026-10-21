import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { EZIL_ID_ISSUER, ID_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from "@ezil/cli-contract/cli-api";

import { gitConfigCommands, gitSetup } from "../modules/git/credential";
import { login, logout } from "./auth";
import { accessToken, type CliSession } from "./session";
import { io, memoryStore, ORIGIN, session, tokens, useTempHome } from "./testing";

useTempHome();

describe("ezil auth login", () => {
	it("shows a code, polls until approved, stores the session and configures git for github.ezil.work only", async () => {
		let polls = 0;
		const h = io((path) => {
			if (path === "/cli/config") return Response.json({ identity: null });
			if (path === "/cli/login/device") return Response.json({ deviceCode: `ecd_${"d".repeat(64)}`, userCode: "BCDF-GHJK",
				verificationUri: "https://app.test/cli/approve", verificationUriComplete: "https://app.test/cli/approve?code=BCDF-GHJK",
				expiresAt: new Date(Date.now() + 300_000).toISOString(), interval: 5 });
			if (path === "/cli/token") return ++polls < 3 ? Response.json({ error: "authorization_pending" }, { status: 428 }) : tokens(1);
			return new Response("{}", { status: 404 });
		});
		expect(await login(h.io, [gitSetup()])).toBe(0);
		expect(h.out.join("\n")).toContain("BCDF-GHJK");
		expect(h.opened).toEqual(["https://app.test/cli/approve?code=BCDF-GHJK"]);
		expect(h.store.value?.accessToken).toBe("eca_a1");
		expect(h.ran).toEqual(gitConfigCommands());
		expect(h.ran.every(cmd => cmd.some(a => a.startsWith("credential.https://github.ezil.work") || a.startsWith("credential.https://git.ezil.work")))).toBe(true);
		// Credentials are never printed.
		expect(h.out.join("\n")).not.toContain("eca_"); expect(h.out.join("\n")).not.toContain("ecr_"); expect(h.out.join("\n")).not.toContain("ecd_");
	});
	for (const config of ["null", "legacy"] as const) {
		it(`uses the original device flow when config is ${config}`, async () => {
			const h = io((path) => {
				if (path === "/cli/config") return Response.json({ identity: config === "null" ? null : IDENTITY });
				if (path === "/cli/login/device") return Response.json({ deviceCode: `ecd_${"d".repeat(64)}`, userCode: "BCDF-GHJK",
					verificationUri: "https://app.test/cli/approve", verificationUriComplete: "https://app.test/cli/approve?code=BCDF-GHJK",
					expiresAt: new Date(Date.now() + 300_000).toISOString(), interval: 5 });
				if (path === "/cli/token") return tokens(1);
				throw new Error("Unexpected request");
			});
			expect(await login(h.io, [gitSetup()], { legacy: config === "legacy" })).toBe(0);
			expect(h.calls.map(c => c.path)).toEqual([...(config === "legacy" ? [] : ["/cli/config"]), "/cli/login/device", "/cli/token"]);
			expect(h.calls.at(-1)?.body).toEqual({ grant_type: "device_code", device_code: `ecd_${"d".repeat(64)}` });
			expect(h.store.value?.accessToken).toBe("eca_a1");
			expect(h.ran).toEqual(gitConfigCommands());
		});
	}
	it("does not fall back on a configuration outage or a different issuer", async () => {
		const outage = io(() => Response.json({ error: "unavailable" }, { status: 503 }));
		await expect(login(outage.io)).rejects.toThrow("Request failed (503).");
		expect(outage.calls.map(c => c.path)).toEqual(["/cli/config"]);
		const invalid = io(() => Response.json({ identity: { ...IDENTITY, issuer: "https://other.test/" } }));
		expect(await login(invalid.io)).toBe(1);
		expect(invalid.calls.map(c => c.path)).toEqual(["/cli/config"]);
		expect(invalid.err).toEqual(["EZiL returned an invalid sign-in configuration."]);
	});
	it("wires --legacy through the real command without requesting config", async () => {
		const bin = join(import.meta.dir, "../../bin/ezil.ts");
		// Exercise main's argv dispatch with an injected network; stop before browser or storage.
		const script = `
			process.argv = ${JSON.stringify([process.execPath, bin, "auth", "login", "--legacy"])};
			globalThis.fetch = async input => {
				process.stdout.write(new URL(String(input)).pathname + "\\n");
				return Response.json({ error: "test_refusal", message: "Legacy device endpoint reached." }, { status: 400 });
			};
			await import(${JSON.stringify(bin)});
		`;
		const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect(code).toBe(1);
		expect(out).toBe("/cli/login/device\n");
		expect(err).toBe("Legacy device endpoint reached.\n");
	});
});

const IDENTITY = { issuer: EZIL_ID_ISSUER, clientId: "native-client", scope: "openid email" };
const AUTH0_ACCESS = "auth0-access-token-must-stay-private";
const AUTH0_REFRESH = "auth0-refresh-token-must-stay-private";
const AUTH0_ID = "auth0-id-token-must-stay-private";
const AUTH0_DEVICE = "auth0-device-code-must-stay-private";
const EZIL_SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const EZIL_TOKENS = { access_token: `eca_${EZIL_SESSION_ID}_${"a".repeat(64)}`, refresh_token: `ecr_${EZIL_SESSION_ID}_${"b".repeat(64)}`,
	token_type: "Bearer", expires_at: "2030-01-01T00:00:00.000Z", session_id: EZIL_SESSION_ID, session_expires_at: "2031-01-01T00:00:00.000Z" };

function identityHarness(poll: (attempt: number) => Response | Promise<Response>, options: {
	expiresIn?: number; interval?: number; exchange?: () => Response; config?: () => Response; identity?: typeof IDENTITY;
} = {}) {
	const order: string[] = [];
	const sleeps: number[] = [];
	const identity = options.identity ?? IDENTITY;
	let now = Date.now();
	let polls = 0;
	const h = io((path, body, auth) => {
		order.push(path);
		expect(auth).toBeNull();
		if (path === "/cli/config") return options.config ? options.config() : Response.json({ identity: IDENTITY });
		if (path === "/cli/login/device") {
			expect(writes).toEqual([]);
			return Response.json({ deviceCode: `ecd_${"d".repeat(64)}`, userCode: "JKLM-NPQR",
				verificationUri: "https://app.test/cli/approve", verificationUriComplete: "https://app.test/cli/approve?code=JKLM-NPQR",
				expiresAt: new Date(now + 300_000).toISOString(), interval: 5 });
		}
		if (path === "/cli/token") {
			if (body?.["grant_type"] === "device_code") {
				expect(body).toEqual({ grant_type: "device_code", device_code: `ecd_${"d".repeat(64)}` });
				return Response.json(EZIL_TOKENS);
			}
			expect(body).toEqual({ grant_type: TOKEN_EXCHANGE_GRANT, subject_token: AUTH0_ID, subject_token_type: ID_TOKEN_TYPE,
				deviceLabel: expect.any(String), os: expect.any(String), cliVersion: "0.1.0" });
			return options.exchange ? options.exchange() : Response.json({ ...EZIL_TOKENS, id_token: AUTH0_ID });
		}
		throw new Error("Unexpected API request");
	});
	const apiFetch = h.io.fetch;
	const writes: CliSession[] = [];
	const write = h.store.write;
	h.store.write = value => { writes.push(value); write(value); };
	h.io = { ...h.io, now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; },
		fetch: (async (input, init) => {
			const url = String(input);
			if (url.startsWith(ORIGIN)) {
				if (url.endsWith("/cli/config")) expect(init?.method).toBe("GET");
				else expect(init?.method).toBe("POST");
				return apiFetch(input, init);
			}
			expect(url.startsWith(EZIL_ID_ISSUER)).toBe(true);
			expect(init?.method).toBe("POST");
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
			expect(new Headers(init?.headers).get("authorization")).toBeNull();
			expect(init?.body).toBeInstanceOf(URLSearchParams);
			const body = Object.fromEntries(init?.body as URLSearchParams);
			const path = url.slice(EZIL_ID_ISSUER.length);
			order.push(path);
			if (path === "oauth/device/code") {
				expect(body).toEqual({ client_id: identity.clientId, scope: identity.scope });
				return Response.json({ device_code: AUTH0_DEVICE, user_code: "BCDF-GHJK", verification_uri: "https://id.ezil.work/activate",
					verification_uri_complete: "https://id.ezil.work/activate?user_code=BCDF-GHJK", expires_in: options.expiresIn ?? 300,
					...(options.interval === undefined ? {} : { interval: options.interval }) });
			}
			expect(path).toBe("oauth/token");
			expect(body).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: AUTH0_DEVICE, client_id: identity.clientId });
			return poll(++polls);
		}) as typeof fetch };
	return { ...h, order, sleeps, writes };
}

function expectNoIdentityTokens(h: ReturnType<typeof identityHarness>) {
	const visible = JSON.stringify([h.out, h.err, h.store.value, h.writes, h.ran, h.opened]);
	for (const secret of [AUTH0_ACCESS, AUTH0_REFRESH, AUTH0_ID, AUTH0_DEVICE]) expect(visible).not.toContain(secret);
	const output = JSON.stringify([h.out, h.err, h.ran, h.opened]);
	for (const secret of [EZIL_TOKENS.access_token, EZIL_TOKENS.refresh_token, `ecd_${"d".repeat(64)}`]) expect(output).not.toContain(secret);
}

describe("EZiL ID device login", () => {
	for (const config of ["404", "network"] as const) {
		it(`uses the built-in EZiL ID client when config fails with ${config}`, async () => {
			const h = identityHarness(() => Response.json({ access_token: AUTH0_ACCESS, refresh_token: AUTH0_REFRESH, id_token: AUTH0_ID }), {
				identity: { issuer: EZIL_ID_ISSUER, clientId: "Mzvm4piCMAKy3ofhywuQDYstJLcYE3mx", scope: "openid email profile" },
				config: () => {
					if (config === "network") throw new TypeError("network down");
					return new Response("Not found", { status: 404 });
				},
			});
			expect(await login(h.io, [gitSetup()])).toBe(0);
			expect(h.order).toEqual(["/cli/config", "oauth/device/code", "oauth/token", "/cli/token"]);
			expect(h.store.value?.accessToken).toBe(EZIL_TOKENS.access_token);
			expect(h.writes).toEqual([h.store.value!]);
			expect(h.ran).toEqual(gitConfigCommands());
			expectNoIdentityTokens(h);
		});
	}
	it("uses the config override, handles pending and cumulative slow_down, exchanges the ID token, stores only EZiL tokens and sets up Git", async () => {
		const h = identityHarness(attempt => attempt < 5
			? Response.json({ error: attempt === 1 || attempt === 4 ? "authorization_pending" : "slow_down" }, { status: 403 })
			: Response.json({ access_token: AUTH0_ACCESS, refresh_token: AUTH0_REFRESH, id_token: AUTH0_ID }), { interval: 2 });
		expect(await login(h.io, [gitSetup()])).toBe(0);
		expect(h.order).toEqual(["/cli/config", "oauth/device/code", ...Array(5).fill("oauth/token"), "/cli/token"]);
		expect(h.sleeps).toEqual([2000, 2000, 7000, 12000, 12000]);
		expect(h.out[0]).toBe("To sign in, open https://id.ezil.work/activate and enter the code:  BCDF-GHJK");
		expect(h.out).toContain("Waiting for sign-in approval.");
		expect(h.opened).toEqual(["https://id.ezil.work/activate?user_code=BCDF-GHJK"]);
		expect(h.store.value).toEqual({ apiOrigin: ORIGIN, sessionId: EZIL_SESSION_ID, accessToken: EZIL_TOKENS.access_token,
			refreshToken: EZIL_TOKENS.refresh_token, accessExpiresAt: EZIL_TOKENS.expires_at });
		expect(h.ran).toEqual(gitConfigCommands());
		expectNoIdentityTokens(h);
	});
	for (const status of [400, 404]) {
		it(`falls back to the legacy device flow when exchange returns ${status}`, async () => {
			const h = identityHarness(() => Response.json({ access_token: AUTH0_ACCESS, refresh_token: AUTH0_REFRESH, id_token: AUTH0_ID }), {
				exchange: () => status === 404 ? new Response(AUTH0_ID, { status }) : Response.json({
					error: "invalid_request", message: AUTH0_ACCESS, error_description: AUTH0_REFRESH, id_token: AUTH0_ID,
				}, { status }),
			});
			expect(await login(h.io, [gitSetup()])).toBe(0);
			expect(h.order).toEqual(["/cli/config", "oauth/device/code", "oauth/token", "/cli/token", "/cli/login/device", "/cli/token"]);
			expect(h.out.slice(0, 4)).toEqual([
				"To sign in, open https://id.ezil.work/activate and enter the code:  BCDF-GHJK",
				"This EZiL server does not accept EZiL ID sign-in yet; falling back to the EZiL device code.",
				"To sign in, open https://app.test/cli/approve and enter the code:  JKLM-NPQR",
				"Signed in.",
			]);
			expect(h.out.filter(line => line.includes("falling back"))).toHaveLength(1);
			expect(h.err).toEqual([]);
			expect(h.opened).toEqual(["https://id.ezil.work/activate?user_code=BCDF-GHJK", "https://app.test/cli/approve?code=JKLM-NPQR"]);
			expect(h.store.value?.accessToken).toBe(EZIL_TOKENS.access_token);
			expect(h.writes).toEqual([h.store.value!]);
			expect(h.ran).toEqual(gitConfigCommands());
			expectNoIdentityTokens(h);
		});
	}
	for (const [status, error, message] of [
		[400, "identity_disabled", "EZiL ID is not enabled. Run `ezil auth login --legacy`."],
		[401, "identity_token_invalid", "EZiL ID could not verify this sign-in. Run `ezil auth login` again."],
		[403, "identity_unverified", "Verify your EZiL ID email before signing in."],
		[403, "no_account", "Sign up at app.ezil.work first."],
		[403, "account_suspended", "This EZiL account is suspended."],
		[503, "identity_unavailable", "EZiL ID is unavailable. Try again shortly."],
		[429, "rate_limited", "Too many sign-in attempts. Try again shortly."],
		[400, "unexpected", "EZiL ID sign-in failed. Run `ezil auth login` again."],
		[403, "invalid_request", "EZiL ID sign-in failed. Run `ezil auth login` again."],
	] as const) {
		it(`keeps the ${status} ${error} refusal without legacy fallback or token disclosure`, async () => {
			const h = identityHarness(() => Response.json({ id_token: AUTH0_ID }), {
				exchange: () => Response.json({ error, message: AUTH0_ACCESS, error_description: AUTH0_REFRESH, id_token: AUTH0_ID }, { status }),
			});
			expect(await login(h.io, [gitSetup()])).toBe(1);
			expect(h.order).toEqual(["/cli/config", "oauth/device/code", "oauth/token", "/cli/token"]);
			expect(h.err).toEqual([message]);
			expect(h.store.value).toBeNull();
			expect(h.writes).toEqual([]);
			expect(h.ran).toEqual([]);
			expectNoIdentityTokens(h);
		});
	}
	it("refuses a successful provider response without an id_token before exchange or storage", async () => {
		const h = identityHarness(() => Response.json({ access_token: AUTH0_ACCESS, refresh_token: AUTH0_REFRESH }));
		expect(await login(h.io, [gitSetup()])).toBe(1);
		expect(h.err).toEqual(["EZiL ID did not return an identity token."]);
		expect(h.order).toEqual(["/cli/config", "oauth/device/code", "oauth/token"]);
		expect(h.store.value).toBeNull();
		expect(h.writes).toEqual([]);
		expect(h.ran).toEqual([]);
		expectNoIdentityTokens(h);
	});
	for (const error of ["access_denied", "expired_token", "invalid_grant"] as const) {
		it(`exits 1 with one safe line for ${error}`, async () => {
			const h = identityHarness(() => Response.json({ error, error_description: AUTH0_ACCESS, access_token: AUTH0_REFRESH, id_token: AUTH0_ID }, { status: 403 }));
			expect(await login(h.io, [gitSetup()])).toBe(1);
			expect(h.sleeps).toEqual([5000]); // RFC 8628 default when interval is absent
			expect(h.err).toEqual([error === "access_denied" ? "Sign-in was declined. Run `ezil auth login` again." : "The code expired before it was approved. Run `ezil auth login` again."]);
			expect(h.order).not.toContain("/cli/token");
			expect(h.store.value).toBeNull();
			expect(h.ran).toEqual([]);
			expectNoIdentityTokens(h);
		});
	}
	it("stops polling when the local deadline expires", async () => {
		const h = identityHarness(() => Response.json({ error: "authorization_pending" }, { status: 403 }), { expiresIn: 12 });
		expect(await login(h.io)).toBe(1);
		expect(h.sleeps).toEqual([5000, 5000, 2000]);
		expect(h.order).toEqual(["/cli/config", "oauth/device/code", "oauth/token", "oauth/token"]);
		expect(h.err).toEqual(["The code expired before it was approved. Run `ezil auth login` again."]);
		expectNoIdentityTokens(h);
	});
	it("never prints provider network errors or unknown refusal descriptions", async () => {
		for (const poll of [() => { throw new Error(AUTH0_ACCESS); }, () => Response.json({ error: "unexpected", error_description: AUTH0_REFRESH }, { status: 500 })]) {
			const h = identityHarness(poll);
			expect(await login(h.io)).toBe(1);
			expect(h.err).toEqual(["EZiL ID sign-in failed. Run `ezil auth login` again."]);
			expect(h.store.value).toBeNull();
			expectNoIdentityTokens(h);
		}
	});
	it("never prints reflected tokens on an exchange refusal or persists a provider token as a device session", async () => {
		for (const exchange of [
			() => Response.json({ error: "no_account", message: AUTH0_ACCESS }, { status: 403 }),
			() => Response.json({ ...EZIL_TOKENS, access_token: AUTH0_ACCESS, refresh_token: AUTH0_REFRESH, id_token: AUTH0_ID }),
		]) {
			const h = identityHarness(() => Response.json({ access_token: AUTH0_ACCESS, refresh_token: AUTH0_REFRESH, id_token: AUTH0_ID }), { exchange });
			expect(await login(h.io, [gitSetup()])).toBe(1);
			expect(h.store.value).toBeNull();
			expect(h.ran).toEqual([]);
			expect(h.err).toHaveLength(1);
			expectNoIdentityTokens(h);
		}
	});
});

describe("refresh", () => {
	it("rotates an access token near expiry, and only once when two helpers race", async () => {
		let refreshes = 0;
		const store = memoryStore(session({ accessExpiresAt: new Date(Date.now() + 10_000).toISOString() }));
		const h = io(async (path, body) => {
			expect(path).toBe("/cli/token"); expect(body?.["refresh_token"]).toBe("ecr_r1");
			refreshes++; await new Promise(r => setTimeout(r, 50)); return tokens(2);
		}, store);
		h.io = { ...h.io, sleep: ms => new Promise(r => setTimeout(r, ms)) };
		const [a, b] = await Promise.all([accessToken(h.io), accessToken(h.io)]);
		expect(refreshes).toBe(1);
		expect(a?.token).toBe("eca_a2"); expect(b?.token).toBe("eca_a2");
		expect(store.value?.refreshToken).toBe("ecr_r2");
	});
	it("forgets the session when the server refuses the refresh (revoked or reused)", async () => {
		const store = memoryStore(session({ accessExpiresAt: new Date(Date.now() - 1000).toISOString() }));
		const h = io(() => Response.json({ error: "refresh_reuse" }, { status: 401 }), store);
		expect(await accessToken(h.io)).toBeNull();
		expect(store.value).toBeNull();
	});
});

it("logs out on the server and forgets the session locally", async () => {
	const store = memoryStore(session());
	const h = io((path, _body, auth) => { expect(path).toBe("/cli/logout"); expect(auth).toBe("Bearer eca_a1"); return Response.json({ revoked: true }); }, store);
	expect(await logout(h.io)).toBe(0);
	expect(h.calls.map(c => c.path)).toEqual(["/cli/logout"]);
	expect(store.value).toBeNull();
});

it("says so, and exits 1, when the local sign-in is removed but the server could not revoke it", async () => {
	const store = memoryStore(session());
	const h = io(() => { throw new TypeError("network down"); }, store);
	expect(await logout(h.io)).toBe(1);
	expect(store.value).toBeNull();
	expect(h.err.join("\n")).toContain("could not be reached to revoke");
	expect(h.out).toEqual([]);
});

it("reports a logout with nothing signed in as such", async () => {
	const h = io(() => { throw new Error("must not call"); });
	expect(await logout(h.io)).toBe(0);
	expect(h.out).toEqual(["Not signed in on this device."]);
});
