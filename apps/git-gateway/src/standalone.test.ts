import { describe, expect, it, spyOn } from "bun:test";
import { standalone, type StandaloneEnv } from "./standalone";

const account = "2104e6f103f83b34f363985b093edc7c";
const name = "os-code-url-20261110-a";
const url = `https://github.ezil.work/default/${name}.git`;
const remote = `https://${account}.artifacts.cloudflare.net/git/default/${name}.git`;
const audience = "2tVk0vvzQvm964BtGuXzQxpjlo2JCoCl";
const now = Date.now();
const base64 = (data: Uint8Array | string) => btoa(typeof data === "string" ? data : String.fromCharCode(...data))
	.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

async function fixture(limitIp = false) {
	const kid = crypto.randomUUID();
	const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
	const publicKey = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid, alg: "RS256", use: "sig" };
	const jwt = async (sub: string, aud = audience, lifetime = 600) => {
		const head = base64(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
		const body = base64(JSON.stringify({ iss: "https://id.ezil.work/", sub, aud,
			iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + lifetime }));
		const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
		return `${head}.${body}.${base64(new Uint8Array(signature))}`;
	};
	const records = new Map<string, string>([[`repo:default/${name}`,
		JSON.stringify({ providerId: "fg1wtcrexaf7acl0", ownerSub: "auth0|owner", publicRead: true })]]);
	const limitedKeys: string[] = [];
	const providerCalls: string[] = [];
	const nativeTokens = new Map<string, { repo: string; scope: "read" | "write"; expires: number }>();
	let serial = 0;
	const env: StandaloneEnv = { EZIL_ID_AUDIENCES: `${audience},Mzvm4piCMAKy3ofhywuQDYstJLcYE3mx`,
		CREATE_RL: { limit: async () => ({ success: true }) },
		IP_HASH_SALT: "test-salt", RL: { limit: async ({ key }) => { limitedKeys.push(key); return { success: !(limitIp && key.startsWith("v2:ip:")) }; } },
		STANDALONE_REPOS: { get: async key => records.get(key) ?? null, put: async (key, value) => { records.set(key, value); } },
		ARTIFACTS: {
			create: async repoName => { providerCalls.push(`create:${repoName}`); return { id: "fg1wtcrexaf7acl0", name: repoName,
				remote: `https://${account}.artifacts.cloudflare.net/git/default/${repoName}.git`, defaultBranch: "main", token: "unused" }; },
			get: async repoName => { providerCalls.push(`get:${repoName}`); return {
				info: async () => { providerCalls.push(`info:${repoName}`); return { id: "fg1wtcrexaf7acl0", name: repoName,
					remote: `https://${account}.artifacts.cloudflare.net/git/default/${repoName}.git`, defaultBranch: "main", readOnly: false }; },
				createToken: async (scope, ttl) => { providerCalls.push(`token:${repoName}:${scope}:${ttl}`);
					const expires = Math.floor(now / 1000) + ttl;
					const plaintext = `art_v1_${(++serial).toString(16).padStart(40, "0")}?expires=${expires}`;
					nativeTokens.set(plaintext, { repo: repoName, scope, expires });
					return { plaintext, scope, expiresAt: new Date(expires * 1000).toISOString() }; },
				[Symbol.dispose]: () => { providerCalls.push(`dispose:${repoName}`); },
			}; },
		} };
	const calls: string[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const target = String(input);
		calls.push(target);
		if (target.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [publicKey] });
		if (target.startsWith(`https://${account}.artifacts.cloudflare.net/git/default/`)) {
			expect(init?.redirect).toBe("manual");
			const native = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1];
			const grant = nativeTokens.get(native ?? "");
			if (!grant || grant.expires <= Math.floor(now / 1000)) return new Response("invalid token", { status: 401 });
			if (!target.startsWith(`https://${account}.artifacts.cloudflare.net/git/default/${grant.repo}.git`))
				return new Response("foreign repo", { status: 403 });
			if (target.includes("git-receive-pack") && grant.scope !== "write") return new Response("read only", { status: 403 });
			return new Response("git-ok", { status: 200 });
		}
		throw new Error(`unexpected fetch ${target}`);
	};
	const send = (path: string, init: RequestInit = {}, time = now) => standalone(new Request(`https://github.ezil.work${path}`, init), env, fetcher, time);
	return { jwt, send, calls, records, limitedKeys, providerCalls, env };
}

describe("standalone Git v2", () => {
	it("mints the exact owner packet and proxies a scoped push without contacting Works", async () => {
		const f = await fixture();
		const token = await f.jwt("auth0|owner");
		const granted = await f.send("/v2/git/grant", { method: "POST", headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ repoURL: url, scope: "write" }) });
		expect(granted?.status).toBe(200);
		const packet = await granted!.json() as { version: number; repository: { id: string; ref: string; canonicalURL: string };
			identity: { issuer: string; subject: string }; git: { username: string; token: string; scope: string; expiresAt: string } };
		expect(packet).toMatchObject({ version: 2, repository: { id: "fg1wtcrexaf7acl0", canonicalURL: url, ref: "refs/heads/main" },
			identity: { issuer: "https://id.ezil.work/", subject: "auth0|owner" }, git: { username: "ezil", scope: "write" } });
		expect(Date.parse(packet.git.expiresAt)).toBe(now - now % 1000 + 300_000);
		const pushed = await f.send(`/default/${name}.git/git-receive-pack`, { method: "POST",
			headers: { authorization: `Basic ${btoa(`ezil:${packet.git.token}`)}` }, body: "git-data" });
		expect(pushed?.status).toBe(200);
		expect(await pushed?.text()).toBe("git-ok");
		expect(f.calls.every(call => !call.includes("api.ezil.work"))).toBe(true);
		expect([...f.records.keys()].every(key => key.startsWith("repo:"))).toBe(true);
		expect(f.providerCalls).toContain(`token:${name}:write:300`);
	});
	it("rejects a wrong audience, another user's write, and read grant push", async () => {
		const f = await fixture();
		const invalid = await f.send("/v2/git/grant", { method: "POST", headers: { authorization: `Bearer ${await f.jwt("auth0|owner", "other")}` },
			body: JSON.stringify({ repoURL: url, scope: "read" }) });
		expect(invalid?.status).toBe(401);
		const other = await f.jwt("auth0|other");
		const denied = await f.send("/v2/git/grant", { method: "POST", headers: { authorization: `Bearer ${other}` },
			body: JSON.stringify({ repoURL: url, scope: "write" }) });
		expect(denied?.status).toBe(403);
		expect(f.providerCalls).toEqual([]);
		const read = await f.send("/v2/git/grant", { method: "POST", headers: { authorization: `Bearer ${other}` },
			body: JSON.stringify({ repoURL: url, scope: "read" }) });
		expect(read?.status).toBe(200);
		const packet = await read!.json() as { git: { token: string } };
		const fetched = await f.send(`/default/${name}.git/info/refs?service=git-upload-pack`,
			{ headers: { authorization: `Basic ${btoa(`ezil:${packet.git.token}`)}` } });
		expect(fetched?.status).toBe(200);
		const push = await f.send(`/default/${name}.git/git-receive-pack`, { method: "POST",
			headers: { authorization: `Basic ${btoa(`ezil:${packet.git.token}`)}` }, body: "git-data" });
		expect(push?.status).toBe(403);
		expect(f.providerCalls.filter(call => call.startsWith("token:"))).toHaveLength(1);
	});
	it("creates a subject-prefixed direct repository and returns its canonical URL", async () => {
		const f = await fixture();
		const created = await f.send("/v2/repos", { method: "POST",
			headers: { authorization: `Bearer ${await f.jwt("auth0|owner")}` }, body: JSON.stringify({ name: "sample" }) });
		expect(created?.status).toBe(201);
		const result = await created!.json() as { repoURL: string; ref: string; providerId: string };
		expect(result.repoURL).toMatch(/^https:\/\/github\.ezil\.work\/default\/u-[a-f0-9]{16}-sample\.git$/);
		expect(result.ref).toBe("refs/heads/main");
		expect(result.providerId).toBe("fg1wtcrexaf7acl0");
		const registered = f.records.get(`repo:default/${result.repoURL.split("/").at(-1)!.replace(/\.git$/, "")}`);
		expect(JSON.parse(registered!).publicRead).toBe(false);
		const invalid = await f.send("/v2/repos", { method: "POST",
			headers: { authorization: `Bearer ${await f.jwt("auth0|owner")}` }, body: JSON.stringify({ name: "foo.git" }) });
		expect(invalid?.status).toBe(400);
	});
	it("limits an invalid caller by hashed IP before any JWKS or Artifacts request", async () => {
		const f = await fixture(true);
		const response = await f.send("/v2/git/grant", { method: "POST", headers: {
			authorization: "Bearer invalid.token.value", "cf-connecting-ip": "203.0.113.9",
		}, body: JSON.stringify({ repoURL: url, scope: "read" }) });
		expect(response?.status).toBe(429);
		expect(f.calls).toEqual([]);
		expect(f.limitedKeys).toHaveLength(1);
		expect(f.limitedKeys[0]).toMatch(/^v2:ip:[a-f0-9]{64}$/);
		expect(f.limitedKeys[0]).not.toContain("203.0.113.9");
		const git = await f.send(`/default/${name}.git/info/refs?service=git-upload-pack`,
			{ headers: { authorization: `Basic ${btoa("ezil:random")}`, "cf-connecting-ip": "203.0.113.9" } });
		expect(git?.status).toBe(429);
		expect(f.calls).toEqual([]);
		expect(f.providerCalls).toEqual([]);
	});
	it("bounds chunked JSON without Content-Length before parsing or provider work", async () => {
		const f = await fixture();
		const body = new ReadableStream<Uint8Array>({ start(controller) {
			controller.enqueue(new Uint8Array(2048));
			controller.enqueue(new Uint8Array(2049));
			controller.close();
		} });
		const response = await f.send("/v2/repos", { method: "POST",
			headers: { authorization: `Bearer ${await f.jwt("auth0|owner")}` }, body, duplex: "half" } as RequestInit);
		expect(response?.status).toBe(413);
		expect(f.providerCalls).toEqual([]);
	});
	it("falls through on an unregistered default path", async () => {
		const f = await fixture();
		const response = await f.send("/default/unregistered.git/info/refs?service=git-upload-pack");
		expect(response).toBeNull();
		expect(f.calls).toEqual([]);
		expect(f.providerCalls).toEqual([]);
	});
	it("challenges malformed, unknown, and expired credentials; rejects a foreign repo", async () => {
		const f = await fixture();
		const random = await f.send(`/default/${name}.git/info/refs?service=git-upload-pack`,
			{ headers: { authorization: `Basic ${btoa("ezil:invalid")}` } });
		expect(random?.status).toBe(401);
		expect(random?.headers.has("www-authenticate")).toBe(true);
		expect(f.calls).toEqual([]);
		expect(f.providerCalls).toEqual([]);
		const granted = await f.send("/v2/git/grant", { method: "POST",
			headers: { authorization: `Bearer ${await f.jwt("auth0|owner")}` }, body: JSON.stringify({ repoURL: url, scope: "read" }) });
		const packet = await granted!.json() as { git: { token: string } };
		const before = f.providerCalls.length;
		const changed = packet.git.token.replace(/^art_v1_./, "art_v1_f");
		const tampered = await f.send(`/default/${name}.git/info/refs?service=git-upload-pack`,
			{ headers: { authorization: `Basic ${btoa(`ezil:${changed}`)}` } });
		expect(tampered?.status).toBe(401);
		expect(f.providerCalls.length).toBe(before);
		expect(f.calls.at(-1)).toContain(remote);
		f.records.set("repo:default/other", JSON.stringify({ providerId: "fg1wtcrexaf7acl0", ownerSub: "auth0|owner", publicRead: true }));
		const wrongRepo = await f.send("/default/other.git/info/refs?service=git-upload-pack",
			{ headers: { authorization: `Basic ${btoa(`ezil:${packet.git.token}`)}` } });
		expect(wrongRepo?.status).toBe(403);
		expect(f.providerCalls.length).toBe(before);
		expect(f.calls.at(-1)).toContain("/other.git/");
		const callsBeforeExpiry = f.calls.length;
		const expired = await f.send(`/default/${name}.git/info/refs?service=git-upload-pack`,
			{ headers: { authorization: `Basic ${btoa(`ezil:${packet.git.token}`)}` } }, now + 301_000);
		expect(expired?.status).toBe(401);
		expect(expired?.headers.has("www-authenticate")).toBe(true);
		expect(f.providerCalls.length).toBe(before);
		expect(f.calls.length).toBe(callsBeforeExpiry);
	});
	it("caps a grant at the verified ID token expiry and caches its JWKS key", async () => {
		const f = await fixture();
		const token = await f.jwt("auth0|owner", audience, 120);
		const request = { method: "POST", headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ repoURL: url, scope: "read" }) };
		const first = await f.send("/v2/git/grant", request);
		const second = await f.send("/v2/git/grant", request);
		const packet = await first!.json() as { git: { expiresAt: string } };
		expect(Date.parse(packet.git.expiresAt)).toBe(Math.floor(now / 1000) * 1000 + 120_000);
		expect(second?.status).toBe(200);
		expect(f.calls.filter(call => call.endsWith("/.well-known/jwks.json"))).toHaveLength(1);
	});
	it("refuses a native grant when ID lifetime is below Cloudflare's 60-second minimum", async () => {
		const f = await fixture();
		const response = await f.send("/v2/git/grant", { method: "POST",
			headers: { authorization: `Bearer ${await f.jwt("auth0|owner", audience, 59)}` },
			body: JSON.stringify({ repoURL: url, scope: "write" }) });
		expect(response?.status).toBe(401);
		expect(f.providerCalls.some(call => call.startsWith("token:"))).toBe(false);
	});
	it("reports only primitive rejection metrics without leaking native response fields", async () => {
		const f = await fixture();
		const warning = spyOn(console, "warn").mockImplementation(() => {});
		const secret = "sensitive-provider-secret-sentinel";
		const issued = Math.floor(now / 1000);
		const nativeToken = `art_v1_${"a".repeat(40)}?expires=${issued + 301}`;
		try {
			f.env.ARTIFACTS!.get = async () => ({
				info: async () => ({ id: "fg1wtcrexaf7acl0", name, remote, defaultBranch: "main", readOnly: false }),
				createToken: async () => ({ plaintext: nativeToken, scope: "read",
					expiresAt: new Date((issued + 301) * 1000 + 123).toISOString(), secret, subject: secret, idToken: secret }),
				[Symbol.dispose]: () => {},
			});
			const response = await f.send("/v2/git/grant", { method: "POST",
				headers: { authorization: `Bearer ${await f.jwt("auth0|owner")}` }, body: JSON.stringify({ repoURL: url, scope: "read" }) });
			expect(response?.status).toBe(503);
			expect(await response!.json()).toEqual({ error: "Invalid Artifacts token" });
			expect(warning).toHaveBeenCalledTimes(1);
			expect(JSON.parse(warning.mock.calls[0]![0] as string)).toEqual({ event: "native_response_rejected", phase: "native_response_validate",
				hasPlaintextString: true, hasScope: true, hasExpiresAtString: true, scopeMatches: true,
				nativeTokenFormatMatches: true, finiteExpiry: true, expiresAfterID: false, expiresAfterRequestBound: true,
				tokenLength: nativeToken.length, tokenExpiryMinusIssuedSeconds: 301, expiryTimestampDeltaMilliseconds: 123 });
			f.env.ARTIFACTS!.get = async () => ({
				info: async () => ({ id: "fg1wtcrexaf7acl0", name, remote, defaultBranch: "main", readOnly: false }),
				createToken: async () => ({ plaintext: secret, scope: secret as "read", expiresAt: secret }),
				[Symbol.dispose]: () => {},
			});
			const malformed = await f.send("/v2/git/grant", { method: "POST",
				headers: { authorization: `Bearer ${await f.jwt("auth0|owner")}` }, body: JSON.stringify({ repoURL: url, scope: "read" }) });
			expect(malformed?.status).toBe(503);
			expect(await malformed!.json()).toEqual({ error: "Invalid Artifacts token" });
			expect(warning).toHaveBeenCalledTimes(2);
			expect(JSON.parse(warning.mock.calls[1]![0] as string)).toEqual({ event: "native_response_rejected", phase: "native_response_validate",
				hasPlaintextString: true, hasScope: true, hasExpiresAtString: true, scopeMatches: false,
				nativeTokenFormatMatches: false, finiteExpiry: false, expiresAfterID: false, expiresAfterRequestBound: false,
				tokenLength: secret.length });
			expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
			expect(JSON.stringify(warning.mock.calls)).not.toContain(nativeToken);
			expect(JSON.stringify(warning.mock.calls)).not.toContain("auth0|owner");
		} finally { warning.mockRestore(); }
	});
	it("allowlists native catch diagnostics and excludes exception messages and stacks", async () => {
		const f = await fixture();
		const warning = spyOn(console, "warn").mockImplementation(() => {});
		const secret = "sensitive-exception-secret-sentinel";
		try {
			for (const known of [false, true]) {
				f.env.ARTIFACTS!.get = async () => { throw Object.assign(new Error(secret), {
					name: known ? "ArtifactsError" : secret, code: known ? "UPSTREAM_UNAVAILABLE" : secret,
					stack: secret, subject: secret, token: secret,
				}); };
				const response = await f.send("/v2/git/grant", { method: "POST",
					headers: { authorization: `Bearer ${await f.jwt("auth0|owner")}` }, body: JSON.stringify({ repoURL: url, scope: "read" }) });
				expect(response?.status).toBe(503);
				expect(await response!.json()).toEqual({ error: "Grant unavailable" });
			}
			expect(warning).toHaveBeenCalledTimes(2);
			expect(warning.mock.calls.map(call => JSON.parse(call[0] as string))).toEqual([
				{ event: "native_grant_failed", phase: "repository_get", errorName: "unknown", errorCode: "unknown" },
				{ event: "native_grant_failed", phase: "repository_get", errorName: "ArtifactsError", errorCode: "UPSTREAM_UNAVAILABLE" },
			]);
			expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
			expect(JSON.stringify(warning.mock.calls)).not.toContain("auth0|owner");
		} finally { warning.mockRestore(); }
	});

});
