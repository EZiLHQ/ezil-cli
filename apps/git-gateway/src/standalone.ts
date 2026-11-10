/** Standalone Git for the default Artifacts namespace. No project or task service participates. */
import { parseGitRoutePath } from "@ezil/cli-contract/git-gateway";

const ACCOUNT = "2104e6f103f83b34f363985b093edc7c";
const ISSUER = "https://id.ezil.work/";
const JWKS = `${ISSUER}.well-known/jwks.json`;
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/artifacts/namespaces/default`;
const REMOTE = `https://${ACCOUNT}.artifacts.cloudflare.net/git/default/`;
const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const TOKEN = /^egg_[a-f0-9]{64}$/;
const reply = (status: number, message: string) => new Response(JSON.stringify({ error: message }),
	{ status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

interface KV {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
export interface StandaloneEnv {
	STANDALONE_REPOS?: KV;
	ARTIFACTS_ACCOUNT_TOKEN?: string;
	EZIL_ID_AUDIENCES?: string;
	CREATE_RL?: { limit(options: { key: string }): Promise<{ success: boolean }> };
	RL?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}
export interface RepoRecord { providerId: string; ownerSub: string; publicRead: boolean }
interface GrantRecord { repo: string; providerId: string; sub: string; scope: "read" | "write"; expires: number }
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));

async function identity(token: string, audiences: string, fetcher: Fetch, now: number): Promise<string | null> {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const header = JSON.parse(new TextDecoder().decode(bytes(parts[0]!))) as Record<string, unknown>;
		const claims = JSON.parse(new TextDecoder().decode(bytes(parts[1]!))) as Record<string, unknown>;
		if (header["alg"] !== "RS256" || typeof header["kid"] !== "string" || !header["kid"] || header["typ"] !== "JWT") return null;
		if (claims["iss"] !== ISSUER || typeof claims["sub"] !== "string" || !claims["sub"] ||
			typeof claims["exp"] !== "number" || claims["exp"] <= now || claims["exp"] > now + 86400 ||
			typeof claims["iat"] !== "number" || claims["iat"] > now + 60 ||
			(typeof claims["nbf"] === "number" && claims["nbf"] > now + 60)) return null;
		const allowed = audiences.split(",").map(a => a.trim()).filter(Boolean);
		if (!allowed.length || !allowed.some(a => claims["aud"] === a || (Array.isArray(claims["aud"]) && claims["aud"].includes(a)))) return null;
		if (Array.isArray(claims["aud"]) && claims["aud"].length > 1 && !allowed.includes(String(claims["azp"]))) return null;
		const response = await fetcher(JWKS, { signal: AbortSignal.timeout(5000) });
		if (!response.ok) return null;
		const data = await response.json() as { keys?: Array<JsonWebKey & { kid?: string }> };
		const jwk = data.keys?.find(k => k.kid === header["kid"] && k.kty === "RSA" && k.use === "sig" && k.alg === "RS256");
		if (!jwk) return null;
		const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
		return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(parts[2]!),
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`)) ? claims["sub"] : null;
	} catch { return null; }
}

async function cf(env: StandaloneEnv, fetcher: Fetch, path: string, method = "GET", body?: unknown): Promise<unknown> {
	const response = await fetcher(`${API}${path}`, { method, headers: {
		authorization: `Bearer ${env.ARTIFACTS_ACCOUNT_TOKEN}`,
		"content-type": "application/json",
	}, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
	const result = await response.json() as { success?: boolean; result?: unknown };
	if (!response.ok || !result.success) throw new Error("Artifacts API failed");
	return result.result;
}
async function repoRecord(env: StandaloneEnv, name: string, fetcher: Fetch): Promise<RepoRecord | null> {
	const raw = await env.STANDALONE_REPOS!.get(`repo:default/${name}`);
	if (!raw) return null;
	let record: RepoRecord;
	try { record = JSON.parse(raw) as RepoRecord; } catch { return null; }
	if (!/^[a-z0-9]{16}$/.test(record.providerId) || !record.ownerSub || typeof record.publicRead !== "boolean") return null;
	const provider = await cf(env, fetcher, `/repos/${encodeURIComponent(name)}`) as
		{ id?: string; name?: string; remote?: string; default_branch?: string; read_only?: boolean };
	return provider.id === record.providerId && provider.name === name && provider.remote === `${REMOTE}${name}.git` &&
		provider.default_branch === "main" && provider.read_only === false ? record : null;
}
function pathOf(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = /^https:\/\/github\.ezil\.work\/default\/([a-z0-9][a-z0-9._-]{0,99})\.git$/.exec(value);
	return match?.[1] ?? null;
}

/** Only /v2 routes and registered /default/*.git paths are handled here. Null preserves legacy routing. */
export async function standalone(request: Request, env: StandaloneEnv, fetcher: Fetch,
	now = Date.now()): Promise<Response | null> {
	const url = new URL(request.url);
	const isApi = url.pathname === "/v2/repos" || url.pathname === "/v2/git/grant";
	const route = parseGitRoutePath(url.pathname);
	if (!isApi && (!route || route.routeNamespace !== "default" || route.rest === "")) return null;
	if (!env.STANDALONE_REPOS || !env.ARTIFACTS_ACCOUNT_TOKEN || !env.EZIL_ID_AUDIENCES) return reply(503, "Standalone Git is not configured");
	if (isApi) {
		if (request.method !== "POST") return reply(405, "Method not allowed");
		if (Number(request.headers.get("content-length") ?? 0) > 4096) return reply(413, "Request too large");
		const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
		const sub = bearer && bearer[1]!.length <= 8192 ? await identity(bearer[1]!, env.EZIL_ID_AUDIENCES, fetcher, Math.floor(now / 1000)) : null;
		if (!sub) return reply(401, "EZiL ID sign-in required");
		const limiter = url.pathname === "/v2/repos" ? env.CREATE_RL : env.RL;
		if (limiter && !(await limiter.limit({ key: `v2:${await digest(sub)}` })).success) return reply(429, "Too many Git requests");
		let body: Record<string, unknown>;
		try {
			const raw = await request.text();
			if (raw.length > 4096) return reply(413, "Request too large");
			body = JSON.parse(raw) as Record<string, unknown>;
		} catch { return reply(400, "Invalid JSON"); }
		if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, "Invalid JSON");
		if (url.pathname === "/v2/repos") {
			if (typeof body["name"] !== "string" || !REPO.test(body["name"]) || body["name"].includes("..") ||
				body["name"].endsWith(".git")) return reply(400, "Invalid repository name");
			if (body["visibility"] !== undefined && body["visibility"] !== "private" && body["visibility"] !== "public")
				return reply(400, "Invalid repository visibility");
			const prefix = (await digest(sub)).slice(0, 16);
			const name = `u-${prefix}-${body["name"]}`;
			if (name.length > 100) return reply(400, "Repository name too long");
			try {
				const created = await cf(env, fetcher, "/repos", "POST", { name, default_branch: "main", read_only: false }) as
					{ id?: string; name?: string; remote?: string };
				if (!created.id || !/^[a-z0-9]{16}$/.test(created.id) || created.name !== name ||
					created.remote !== `${REMOTE}${name}.git`) return reply(502, "Invalid Artifacts response");
				await env.STANDALONE_REPOS.put(`repo:default/${name}`,
					JSON.stringify({ providerId: created.id, ownerSub: sub,
						publicRead: body["visibility"] === "public" } satisfies RepoRecord));
				return Response.json({ repoURL: `https://github.ezil.work/default/${name}.git`, ref: "refs/heads/main", providerId: created.id },
					{ status: 201, headers: { "cache-control": "no-store" } });
			} catch { return reply(503, "Repository creation unavailable"); }
		}
		const name = pathOf(body["repoURL"]);
		if (!name || (body["scope"] !== "read" && body["scope"] !== "write")) return reply(400, "Invalid grant request");
		try {
			const record = await repoRecord(env, name, fetcher);
			if (!record || (record.ownerSub !== sub && (body["scope"] === "write" || !record.publicRead))) return reply(403, "Repository unavailable");
			const grant = `egg_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
			const expires = Math.floor(now / 1000) + 300;
			await env.STANDALONE_REPOS.put(`grant:${await digest(grant)}`,
				JSON.stringify({ repo: name, providerId: record.providerId, sub, scope: body["scope"], expires } satisfies GrantRecord),
				{ expirationTtl: 300 });
			return Response.json({ version: 2,
				repository: { id: record.providerId, canonicalURL: `https://github.ezil.work/default/${name}.git`, ref: "refs/heads/main" },
				identity: { issuer: ISSUER, subject: sub },
				git: { username: "ezil", token: grant, expiresAt: new Date(expires * 1000).toISOString(), scope: body["scope"] } },
				{ headers: { "cache-control": "no-store" } });
		} catch { return reply(503, "Grant unavailable"); }
	}
	if (!route || !REPO.test(route.routeName)) return reply(404, "Not found");
	const service = route.rest === "/info/refs" ? url.searchParams.get("service") : route.rest.slice(1);
	if ((route.rest === "/info/refs" && request.method !== "GET") ||
		(route.rest !== "/info/refs" && request.method !== "POST") ||
		(service !== "git-upload-pack" && service !== "git-receive-pack")) return reply(404, "Not found");
	const auth = /^Basic ([A-Za-z0-9+/=]+)$/.exec(request.headers.get("authorization") ?? "");
	let grant = "";
	try { grant = atob(auth?.[1] ?? "").split(":").slice(1).join(":"); } catch { /* deny */ }
	if (!TOKEN.test(grant)) return new Response("EZiL Git sign-in required\n", { status: 401, headers: { "www-authenticate": 'Basic realm="EZiL Git"', "cache-control": "no-store" } });
	try {
		const grantHash = await digest(grant);
		if (env.RL && !(await env.RL.limit({ key: `v2:git:${grantHash}` })).success) return reply(429, "Too many Git requests");
		const raw = await env.STANDALONE_REPOS.get(`grant:${grantHash}`);
		const stored = raw ? JSON.parse(raw) as GrantRecord : null;
		const record = await repoRecord(env, route.routeName, fetcher);
		if (!stored || !record || stored.repo !== route.routeName || stored.providerId !== record.providerId ||
			stored.expires <= Math.floor(now / 1000) ||
			(stored.sub !== record.ownerSub && !record.publicRead) ||
			(service === "git-receive-pack" && (stored.scope !== "write" || stored.sub !== record.ownerSub))) return reply(403, "Repository unavailable");
		const issued = await cf(env, fetcher, "/tokens", "POST",
			{ repo: route.routeName, scope: service === "git-receive-pack" ? "write" : "read", ttl: 300 }) as { plaintext?: string };
		if (!issued.plaintext) return reply(503, "Artifacts token unavailable");
		const headers = new Headers();
		for (const key of ["content-type", "content-encoding", "accept", "accept-encoding", "git-protocol", "user-agent"])
			if (request.headers.has(key)) headers.set(key, request.headers.get(key)!);
		headers.set("authorization", `Bearer ${issued.plaintext}`);
		const upstream = await fetcher(`${REMOTE}${route.routeName}.git${route.rest}${route.rest === "/info/refs" ? url.search : ""}`,
			{ method: request.method, headers, redirect: "manual", ...(request.body ? { body: request.body, duplex: "half" } : {}) } as RequestInit);
		const out = new Headers(upstream.headers);
		for (const key of ["set-cookie", "www-authenticate", "authorization", "proxy-authenticate"]) out.delete(key);
		out.set("cache-control", "no-store");
		return new Response(upstream.body, { status: upstream.status, headers: out });
	} catch { return reply(503, "Standalone Git unavailable"); }
}
