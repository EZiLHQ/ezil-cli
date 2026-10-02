import { describe, expect, it } from "bun:test";

import { gitConfigCommands, gitSetup } from "../modules/git/credential";
import { login, logout } from "./auth";
import { accessToken } from "./session";
import { io, memoryStore, session, tokens, useTempHome } from "./testing";

useTempHome();

describe("ezil auth login", () => {
	it("shows a code, polls until approved, stores the session and configures git for github.ezil.work only", async () => {
		let polls = 0;
		const h = io((path) => {
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
