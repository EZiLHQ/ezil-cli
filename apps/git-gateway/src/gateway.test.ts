import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { GitAnnotateRequestSchema, GitAuthorizeRequestSchema, type GitAuthorizeResponse } from "@ezil/cli-contract/git-gateway";
import { handle, type GatewayDeps, type GatewayEnv } from "./gateway";
import { parseCommands } from "./pkt-line";

const SECRET = "s".repeat(48);
const env: GatewayEnv = { API_ORIGIN: "https://api.test", GIT_GATEWAY_SECRET: SECRET, IP_HASH_SALT: "salt" };
const GRANT = `egg_${"a".repeat(64)}`;
const ART = "art_v1_" + "f".repeat(40) + "?expires=1790000000";
const REMOTE = `https://${"0".repeat(32)}.artifacts.cloudflare.net/git/p-x/source.git`;
const basic = (password: string, user = "ezil") => `Basic ${btoa(`${user}:${password}`)}`;
const allow = (over: Partial<Extract<GitAuthorizeResponse, { decision: "allow" }>> = {}): GitAuthorizeResponse => ({ decision: "allow",
	artifactsRemote: REMOTE, artifactsToken: ART, scope: "read", expiresAt: new Date(Date.now() + 600_000).toISOString(), operationId: crypto.randomUUID(), ...over });

interface Call { url: string; init: RequestInit & { headers?: HeadersInit }; body?: Uint8Array }
function harness(answer: (call: Call) => Response | Promise<Response> = () => Response.json(allow()),
	upstream: (call: Call) => Response | Promise<Response> = () => new Response("ok", { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement", "set-cookie": "x=1" } })) {
	const api: Call[] = []; const up: Call[] = []; const logs: string[] = []; const waits: Promise<unknown>[] = [];
	const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = String(input);
		let body: Uint8Array | undefined;
		if (init.body instanceof ReadableStream) body = new Uint8Array(await new Response(init.body).arrayBuffer());
		else if (typeof init.body === "string") body = new TextEncoder().encode(init.body);
		const call = { url, init, ...(body ? { body } : {}) } as Call;
		if (url.startsWith("https://api.test/")) { api.push(call); return answer(call); }
		up.push(call); return upstream(call);
	}) as typeof fetch;
	const deps: GatewayDeps = { fetch: fetcher, now: Date.now, cache: new Map(), log: line => logs.push(JSON.stringify(line)), waitUntil: p => { waits.push(p); } };
	const send = (path: string, init: RequestInit = {}) => handle(new Request(`https://github.ezil.work${path}`, init), env, deps);
	return { api, up, logs, waits, deps, send };
}
const infoRefs = "/acme-3f9a1c/acme.git/info/refs?service=git-upload-pack";

describe("routing and authentication", () => {
	it("challenges a request without credentials, so Git calls the credential helper", async () => {
		const h = harness();
		const response = await h.send(infoRefs);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain('Basic realm="EZiL Git"');
		expect(h.api).toHaveLength(0);
	});
	it("refuses Bearer tokens and malformed grants without asking the API", async () => {
		const h = harness();
		for (const authorization of [`Bearer ${ART}`, basic("not-a-grant"), basic(ART)])
			expect((await h.send(infoRefs, { headers: { authorization } })).status).toBe(401);
		expect(h.api).toHaveLength(0);
	});
	it("serves only the three smart-HTTP endpoints", async () => {
		const h = harness();
		const auth = { authorization: basic(GRANT) };
		for (const path of ["/acme/acme.git/HEAD", "/acme/acme.git/objects/info/packs", "/acme/../x.git/info/refs?service=git-upload-pack",
			"/acme/acme.git/info/refs", "/acme/acme.git/info/refs?service=git-foo", "/acme/acme.git"])
			expect((await h.send(path, { headers: auth })).status).toBe(404);
		expect((await h.send("/acme/acme.git/git-upload-pack", { headers: auth })).status).toBe(405);
		expect(h.api).toHaveLength(0);
		expect((await h.send("/")).status).toBe(200);
	});
	it("reports the deployed commit and whether it is configured on /health, never a secret", async () => {
		const h = harness();
		const body = await (await handle(new Request("https://github.ezil.work/health"), { ...env, EZIL_COMMIT: "abc123" }, h.deps)).json();
		expect(body).toEqual({ ok: true, commit: "abc123", configured: true });
		const bare = await (await handle(new Request("https://github.ezil.work/health"), { API_ORIGIN: "https://api.test" }, h.deps)).json();
		expect(bare).toEqual({ ok: true, commit: null, configured: false });
		expect(JSON.stringify([body, bare])).not.toContain(SECRET);
		expect(h.api).toHaveLength(0);
	});
});

describe("authorization", () => {
	it("sends a contract-valid, correctly signed authorize request", async () => {
		const h = harness();
		await h.send(infoRefs, { headers: { authorization: basic(GRANT), "cf-connecting-ip": "203.0.113.9", "cf-ray": "abc-HKG" } });
		const call = h.api[0]!;
		const body = new TextDecoder().decode(call.body!);
		const parsed = GitAuthorizeRequestSchema.parse(JSON.parse(body));
		expect(parsed).toMatchObject({ grant: GRANT, routeNamespace: "acme-3f9a1c", routeName: "acme", service: "git-upload-pack", cfRay: "abc-HKG" });
		expect(parsed.ipHash).toMatch(/^[0-9a-f]{64}$/);
		expect(body).not.toContain("203.0.113.9");
		const headers = new Headers(call.init.headers);
		const expected = createHmac("sha256", SECRET).update(`${headers.get("x-ezil-timestamp")}.${body}`).digest("hex");
		expect(headers.get("x-ezil-signature")).toBe(expected);
	});
	it("forwards with the Artifacts token, never the client's credentials, and strips cookies from the answer", async () => {
		const h = harness();
		const response = await h.send(infoRefs, { headers: { authorization: basic(GRANT), cookie: "session=1", "git-protocol": "version=2", "x-forwarded-for": "1.2.3.4" } });
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toBeNull();
		const call = h.up[0]!;
		expect(call.url).toBe(`${REMOTE}/info/refs?service=git-upload-pack`);
		const headers = new Headers(call.init.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${ART}`);
		expect(headers.get("cookie")).toBeNull();
		expect(headers.get("x-forwarded-for")).toBeNull();
		expect(headers.get("git-protocol")).toBe("version=2");
	});
	it("turns a deny into the builder's sentence, with a challenge only for 401", async () => {
		const h403 = harness(() => Response.json({ decision: "deny", status: 403, reason: "repo_not_selected", message: "x" }));
		const forbidden = await h403.send(infoRefs, { headers: { authorization: basic(GRANT) } });
		expect(forbidden.status).toBe(403);
		expect(await forbidden.text()).toContain("not selected for any of your open tasks");
		expect(forbidden.headers.get("www-authenticate")).toBeNull();
		const h401 = harness(() => Response.json({ decision: "deny", status: 401, reason: "session_revoked", message: "x" }));
		const unauthorized = await h401.send(infoRefs, { headers: { authorization: basic(GRANT) } });
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("www-authenticate")).toContain("Basic");
		expect(h403.up).toHaveLength(0); expect(h401.up).toHaveLength(0);
	});
	it("fails closed when the API is down, slow, wrong or answering garbage", async () => {
		for (const answer of [() => { throw new Error("down"); }, () => new Response("<html>", { status: 500 }),
			() => Response.json({ decision: "allow" }), () => Response.json({ ok: true })]) {
			const h = harness(answer as () => Response);
			const response = await h.send(infoRefs, { headers: { authorization: basic(GRANT) } });
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBe("5");
			expect(h.up).toHaveLength(0);
		}
	});
	it("refuses an upstream that is not an Artifacts remote", async () => {
		// The contract schema already rejects it; this proves the gateway's own check holds too.
		const h = harness(() => Response.json(allow({ artifactsRemote: "https://evil.example/git/p-x/source.git" })));
		expect((await h.send(infoRefs, { headers: { authorization: basic(GRANT) } })).status).toBe(503);
		expect(h.up).toHaveLength(0);
	});
	it("never serves a push from cache, so revocation stops the very next push", async () => {
		const h = harness(() => Response.json(allow({ scope: "write" })));
		for (let i = 0; i < 3; i++) await h.send("/acme-3f9a1c/acme.git/info/refs?service=git-receive-pack", { headers: { authorization: basic(GRANT) } });
		expect(h.api).toHaveLength(3);
	});
	it("expires a cached read after a few seconds", async () => {
		let clock = Date.now();
		const h = harness();
		const deps = { ...h.deps, now: () => clock };
		const send = () => handle(new Request(`https://github.ezil.work${infoRefs}`, { headers: { authorization: basic(GRANT) } }), env, deps);
		await send(); clock += 4_000; await send();
		expect(h.api).toHaveLength(1);
		clock += 2_000; await send();
		expect(h.api).toHaveLength(2);
	});
	it("caches an allow for the next request, never a deny", async () => {
		const ok = harness();
		await ok.send(infoRefs, { headers: { authorization: basic(GRANT) } });
		await ok.send("/acme-3f9a1c/acme.git/git-upload-pack", { method: "POST", headers: { authorization: basic(GRANT) }, body: "0000" });
		await ok.send(infoRefs, { headers: { authorization: basic(GRANT) } });
		expect(ok.api).toHaveLength(1);
		const no = harness(() => Response.json({ decision: "deny", status: 403, reason: "authority_lapsed", message: "x" }));
		await no.send(infoRefs, { headers: { authorization: basic(GRANT) } });
		await no.send(infoRefs, { headers: { authorization: basic(GRANT) } });
		expect(no.api).toHaveLength(2);
	});
});

describe("push correlation", () => {
	const old = "1".repeat(40), next = "2".repeat(40);
	const pkt = (s: string) => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
	const commands = pkt(`${old} ${next} refs/heads/main\0 report-status side-band-64k agent=git/2.43.0\n`) + pkt(`${old} ${"3".repeat(40)} refs/heads/claude/x\n`) + "0000";
	const pack = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
	const body = () => { const head = new TextEncoder().encode(commands); const all = new Uint8Array(head.length + pack.length); all.set(head); all.set(pack, head.length); return all; };

	it("parses the commands, forwards byte-identical body, and annotates without delaying the push", async () => {
		const h = harness(call => {
			if (call.url.endsWith("/annotate")) return new Response("{}", { status: 200 });
			return Response.json(allow({ scope: "write" }));
		});
		const sent = body();
		const response = await h.send("/acme-3f9a1c/acme.git/git-receive-pack", { method: "POST",
			headers: { authorization: basic(GRANT), "content-type": "application/x-git-receive-pack-request" }, body: sent });
		expect(response.status).toBe(200);
		expect(h.up[0]!.body).toEqual(sent);
		await Promise.all(h.waits);
		const annotate = h.api.find(c => c.url.endsWith("/internal/git/annotate"))!;
		const parsed = GitAnnotateRequestSchema.parse(JSON.parse(new TextDecoder().decode(annotate.body!)));
		expect(parsed.refUpdates).toEqual([{ old, new: next, ref: "refs/heads/main" }, { old, new: "3".repeat(40), ref: "refs/heads/claude/x" }]);
	});
	it("still pushes when the annotate call fails", async () => {
		const h = harness(call => call.url.endsWith("/annotate") ? (() => { throw new Error("down"); })() : Response.json(allow({ scope: "write" })));
		const response = await h.send("/acme-3f9a1c/acme.git/git-receive-pack", { method: "POST", headers: { authorization: basic(GRANT) }, body: body() });
		await Promise.allSettled(h.waits);
		expect(response.status).toBe(200);
	});
	it("parses nothing from a non-command body, rather than guessing", () => {
		expect(parseCommands(new TextEncoder().encode("0008abcd"))?.refUpdates).toEqual([]);
		expect(parseCommands(new TextEncoder().encode(pkt(`${old} ${next} refs/heads/main\n`)))).toBeNull();
	});
});

it("never logs a credential", async () => {
	const h = harness();
	await h.send(infoRefs, { headers: { authorization: basic(GRANT), "cf-connecting-ip": "203.0.113.9" } });
	await h.send(infoRefs);
	const all = h.logs.join("\n");
	expect(all.length).toBeGreaterThan(0);
	for (const secret of [GRANT, ART, "art_v1_", "Basic ", "Bearer ", "203.0.113.9", "0".repeat(32)]) expect(all).not.toContain(secret);
});

it("rate-limits by grant when the binding exists", async () => {
	const h = harness();
	const limited = await handle(new Request(`https://github.ezil.work${infoRefs}`, { headers: { authorization: basic(GRANT) } }),
		{ ...env, RL: { limit: async () => ({ success: false }) } }, h.deps);
	expect(limited.status).toBe(429);
	expect(h.api).toHaveLength(0);
});
