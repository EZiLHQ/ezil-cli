import { describe, expect, it } from "bun:test";
import { standalone, type StandaloneEnv } from "./standalone";

const account = "2104e6f103f83b34f363985b093edc7c";
const name = "os-code-url-20261110-a";
const url = `https://github.ezil.work/default/${name}.git`;
const remote = `https://${account}.artifacts.cloudflare.net/git/default/${name}.git`;
const audience = "2tVk0vvzQvm964BtGuXzQxpjlo2JCoCl";
const now = Date.now();
const base64 = (data: Uint8Array | string) => btoa(typeof data === "string" ? data : String.fromCharCode(...data))
	.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

async function fixture() {
	const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
	const publicKey = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "fixture", alg: "RS256", use: "sig" };
	const jwt = async (sub: string, aud = audience) => {
		const head = base64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fixture" }));
		const body = base64(JSON.stringify({ iss: "https://id.ezil.work/", sub, aud,
			iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 600 }));
		const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
		return `${head}.${body}.${base64(new Uint8Array(signature))}`;
	};
	const records = new Map<string, string>([[`repo:default/${name}`,
		JSON.stringify({ providerId: "fg1wtcrexaf7acl0", ownerSub: "auth0|owner", publicRead: true })]]);
	const env: StandaloneEnv = { EZIL_ID_AUDIENCES: `${audience},Mzvm4piCMAKy3ofhywuQDYstJLcYE3mx`, ARTIFACTS_ACCOUNT_TOKEN: "account-secret",
		STANDALONE_REPOS: { get: async key => records.get(key) ?? null, put: async (key, value) => { records.set(key, value); } } };
	const calls: string[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const target = String(input);
		calls.push(target);
		if (target.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [publicKey] });
		if (target.endsWith("/repos") && init?.method === "POST") {
			const created = JSON.parse(String(init.body)) as { name: string };
			return Response.json({ success: true, result: { id: "fg1wtcrexaf7acl0", name: created.name,
				remote: `https://${account}.artifacts.cloudflare.net/git/default/${created.name}.git` } });
		}
		if (target.endsWith(`/repos/${name}`)) return Response.json({ success: true,
			result: { id: "fg1wtcrexaf7acl0", name, remote, default_branch: "main", read_only: false } });
		if (target.endsWith("/tokens")) return Response.json({ success: true, result: { plaintext: "art_v1_fixture" } });
		if (target.startsWith(remote)) {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer art_v1_fixture");
			return new Response("git-ok", { status: 200 });
		}
		throw new Error(`unexpected fetch ${target}`);
	};
	const send = (path: string, init: RequestInit = {}) => standalone(new Request(`https://github.ezil.work${path}`, init), env, fetcher, now);
	return { jwt, send, calls, records };
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
		const read = await f.send("/v2/git/grant", { method: "POST", headers: { authorization: `Bearer ${other}` },
			body: JSON.stringify({ repoURL: url, scope: "read" }) });
		expect(read?.status).toBe(200);
		const packet = await read!.json() as { git: { token: string } };
		const push = await f.send(`/default/${name}.git/git-receive-pack`, { method: "POST",
			headers: { authorization: `Basic ${btoa(`ezil:${packet.git.token}`)}` }, body: "git-data" });
		expect(push?.status).toBe(403);
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
});
