/** Standalone Git for the default Artifacts namespace. No project or task service participates. */
import { parseGitRoutePath } from "@ezil/cli-contract/git-gateway";

const ACCOUNT = "2104e6f103f83b34f363985b093edc7c";
const ISSUER = "https://id.ezil.work/";
const JWKS = `${ISSUER}.well-known/jwks.json`;
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/artifacts/namespaces/default`;
const REMOTE = `https://${ACCOUNT}.artifacts.cloudflare.net/git/default/`;
const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const TOKEN = /^eg2_([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/;
const reply = (status: number, message: string) => new Response(JSON.stringify({ error: message }),
	{ status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

interface KV {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
export interface StandaloneEnv {
	STANDALONE_REPOS?: KV;
	ARTIFACTS_ACCOUNT_TOKEN?: string;
	STANDALONE_GRANT_SECRET?: string;
	EZIL_ID_AUDIENCES?: string;
	IP_HASH_SALT?: string;
	CREATE_RL?: { limit(options: { key: string }): Promise<{ success: boolean }> };
	RL?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}
export interface RepoRecord { providerId: string; ownerSub: string; publicRead: boolean }
interface GrantClaims { v: 2; repo: string; providerId: string; sub: string; scope: "read" | "write"; iat: number; exp: number; nonce: string }
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
const base64url = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const jwksCache = new Map<string, { key: CryptoKey; until: number }>();

async function grantKey(secret: string): Promise<CryptoKey> {
	if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid grant secret");
	const raw = Uint8Array.from(secret.match(/../g)!, pair => parseInt(pair, 16));
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signGrant(claims: GrantClaims, secret: string): Promise<string> {
	const encoded = base64url(new TextEncoder().encode(JSON.stringify(claims)));
	const signature = await crypto.subtle.sign("HMAC", await grantKey(secret), new TextEncoder().encode(encoded));
	return `eg2_${encoded}.${base64url(new Uint8Array(signature))}`;
}
async function verifyGrant(token: string, secret: string, now: number): Promise<GrantClaims | null> {
	try {
		const match = TOKEN.exec(token);
		if (!match) return null;
		const valid = await crypto.subtle.verify("HMAC", await grantKey(secret), bytes(match[2]!), new TextEncoder().encode(match[1]!));
		if (!valid) return null;
		const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(match[1]!))) as GrantClaims;
		if (Object.keys(claims).sort().join(",") !== "exp,iat,nonce,providerId,repo,scope,sub,v" || claims.v !== 2 ||
			!REPO.test(claims.repo) || !/^[a-z0-9]{16}$/.test(claims.providerId) ||
			typeof claims.sub !== "string" || !claims.sub ||
			(claims.scope !== "read" && claims.scope !== "write") ||
			!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
			claims.iat > now + 60 || claims.exp <= now || claims.exp - claims.iat > 300 ||
			!/^([a-f0-9]{32})$/.test(claims.nonce)) return null;
		return claims;
	} catch { return null; }
}

class TooLarge extends Error {}
async function smallJson(request: Request): Promise<unknown> {
	if (!request.body) throw new Error("Missing body");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > 4096) throw new TooLarge();
			chunks.push(next.value);
		}
		const all = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
	} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function ipLimit(request: Request, env: StandaloneEnv): Promise<Response | null> {
	const ipHash = await digest(`${env.IP_HASH_SALT}:${request.headers.get("cf-connecting-ip") ?? "missing"}`);
	try {
		return (await env.RL!.limit({ key: `v2:ip:${ipHash}` })).success ? null : reply(429, "Too many Git requests");
	} catch { return reply(503, "Git rate limiter unavailable"); }
}

async function identity(token: string, audiences: string, fetcher: Fetch, now: number): Promise<{ sub: string; exp: number } | null> {
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
		const kid = header["kid"] as string;
		const cached = jwksCache.get(kid);
		let key = cached && cached.until > now ? cached.key : undefined;
		if (!key) {
			const response = await fetcher(JWKS, { signal: AbortSignal.timeout(5000) });
			if (!response.ok) return null;
			const data = await response.json() as { keys?: Array<JsonWebKey & { kid?: string }> };
			const jwk = data.keys?.find(k => k.kid === kid && k.kty === "RSA" && k.use === "sig" && k.alg === "RS256");
			if (!jwk) return null;
			key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
			if (jwksCache.size > 8) jwksCache.clear();
			jwksCache.set(kid, { key, until: now + 300 });
		}
		return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(parts[2]!),
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`)) ? { sub: claims["sub"], exp: claims["exp"] } : null;
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
async function repoRecord(env: StandaloneEnv, name: string, fetcher: Fetch, suppliedRaw?: string): Promise<RepoRecord | null> {
	const raw = suppliedRaw ?? await env.STANDALONE_REPOS!.get(`repo:default/${name}`);
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
	let registeredRaw: string | undefined;
	if (!isApi) {
		if (!env.STANDALONE_REPOS) return null;
		try {
			const raw = await env.STANDALONE_REPOS.get(`repo:default/${route!.routeName}`);
			if (raw === null) return null; // An unregistered default route belongs to the existing handler.
			registeredRaw = raw;
		} catch { return reply(503, "Repository registry unavailable"); }
	}
	if (!env.STANDALONE_REPOS || !env.ARTIFACTS_ACCOUNT_TOKEN || !env.STANDALONE_GRANT_SECRET ||
		!env.EZIL_ID_AUDIENCES || !env.IP_HASH_SALT || !env.RL)
		return reply(503, "Standalone Git is not configured");
	if (isApi) {
		if (request.method !== "POST") return reply(405, "Method not allowed");
		if (Number(request.headers.get("content-length") ?? 0) > 4096) return reply(413, "Request too large");
		const limited = await ipLimit(request, env);
		if (limited) return limited;
		const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
		const principal = bearer && bearer[1]!.length <= 8192 ? await identity(bearer[1]!, env.EZIL_ID_AUDIENCES, fetcher, Math.floor(now / 1000)) : null;
		if (!principal) return reply(401, "EZiL ID sign-in required");
		const sub = principal.sub;
		const limiter = url.pathname === "/v2/repos" ? env.CREATE_RL : env.RL;
		if (!limiter) return reply(503, "Git rate limiter unavailable");
		try { if (!(await limiter.limit({ key: `v2:${await digest(sub)}` })).success) return reply(429, "Too many Git requests"); }
		catch { return reply(503, "Git rate limiter unavailable"); }
		let body: Record<string, unknown>;
		try {
			body = await smallJson(request) as Record<string, unknown>;
		} catch (error) { return reply(error instanceof TooLarge ? 413 : 400, error instanceof TooLarge ? "Request too large" : "Invalid JSON"); }
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
			const issued = Math.floor(now / 1000);
			const expires = Math.min(issued + 300, principal.exp);
			if (expires <= issued) return reply(401, "EZiL ID sign-in expired");
			const grant = await signGrant({ v: 2, repo: name, providerId: record.providerId, sub,
				scope: body["scope"], iat: issued, exp: expires, nonce: hex(crypto.getRandomValues(new Uint8Array(16))) },
				env.STANDALONE_GRANT_SECRET);
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
	const limited = await ipLimit(request, env);
	if (limited) return limited;
	const challenge = () => new Response("EZiL Git sign-in required\n", { status: 401,
		headers: { "www-authenticate": 'Basic realm="EZiL Git"', "cache-control": "no-store" } });
	const authorization = request.headers.get("authorization") ?? "";
	const auth = authorization.length <= 4096 ? /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization) : null;
	let credential = "";
	try { credential = atob(auth?.[1] ?? ""); } catch { /* deny */ }
	const grant = credential.startsWith("ezil:") ? credential.slice(5) : "";
	if (!TOKEN.test(grant)) return challenge();
	const stored = await verifyGrant(grant, env.STANDALONE_GRANT_SECRET, Math.floor(now / 1000));
	if (!stored) return challenge();
	try {
		const grantHash = await digest(grant);
		if (!(await env.RL.limit({ key: `v2:git:${grantHash}` })).success) return reply(429, "Too many Git requests");
		if (stored.repo !== route.routeName) return reply(403, "Repository unavailable");
		const record = await repoRecord(env, route.routeName, fetcher, registeredRaw);
		if (!record || stored.providerId !== record.providerId ||
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
