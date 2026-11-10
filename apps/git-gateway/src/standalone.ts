/** Standalone Git for the default Artifacts namespace. No project or task service participates. */
import { parseGitRoutePath } from "@ezil/cli-contract/git-gateway";

const ACCOUNT = "2104e6f103f83b34f363985b093edc7c";
const ISSUER = "https://id.ezil.work/";
const JWKS = `${ISSUER}.well-known/jwks.json`;
const REMOTE = `https://${ACCOUNT}.artifacts.cloudflare.net/git/default/`;
const REPO = /^[a-z0-9][a-z0-9._-]{0,99}$/;
// Native credentials are opaque: validate transport bounds, never a provider-specific prefix.
function safeNativeToken(value: unknown): value is string {
	return typeof value === "string" && value.length >= 16 && value.length <= 8192 &&
		!/[^A-Za-z0-9._~+/=?-]/.test(value);
}
const BASIC_LIMIT = 6 + 4 * Math.ceil((5 + 8192) / 3);
function nativeExpiry(value: unknown): number {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return NaN;
	const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) =>
		`.${(fraction ?? "").padEnd(3, "0")}Z`);
	return new Date(parsed).toISOString() === normalized ? parsed / 1000 : NaN;
}
const reply = (status: number, message: string) => new Response(JSON.stringify({ error: message }),
	{ status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

interface KV {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
export interface StandaloneEnv {
	STANDALONE_REPOS?: KV;
	ARTIFACTS?: ArtifactsBinding;
	EZIL_ID_AUDIENCES?: string;
	IP_HASH_SALT?: string;
	CREATE_RL?: { limit(options: { key: string }): Promise<{ success: boolean }> };
	RL?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}
interface ArtifactsRepoHandle extends Disposable {
	info(): Promise<{ id: string; name: string; remote: string; defaultBranch: string; readOnly: boolean }>;
	createToken(scope: "read" | "write", ttl: number): Promise<{ plaintext: string; scope: "read" | "write"; expiresAt: string }>;
}
interface ArtifactsBinding {
	create(name: string, options: { readOnly: boolean; setDefaultBranch: string }): Promise<{
		id: string; name: string; remote: string; defaultBranch: string; token: string }>;
	get(name: string): Promise<ArtifactsRepoHandle>;
}
export interface RepoRecord { providerId: string; ownerSub: string; publicRead: boolean }
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
const jwksCache = new Map<string, { key: CryptoKey; until: number }>();
type GrantPhase = "registry_lookup" | "repository_get" | "repository_info" | "native_token_create" | "native_response_validate" | "response_serialize";
const ARTIFACTS_ERROR_CODES = new Set(["ALREADY_EXISTS", "NOT_FOUND", "IMPORT_IN_PROGRESS", "FORK_IN_PROGRESS", "INVALID_INPUT",
	"INVALID_REPO_NAME", "INVALID_TTL", "INVALID_URL", "REMOTE_AUTH_REQUIRED", "UPSTREAM_UNAVAILABLE", "MEMORY_LIMIT", "INTERNAL_ERROR"]);
const ERROR_NAMES = new Set(["ArtifactsError", "Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "SuppressedError"]);

/** Primitive, allowlisted diagnostics only: never serialize a provider response or exception. */
function rejectedNativeToken(native: { plaintext?: unknown; scope?: unknown; expiresAt?: unknown }, scope: string,
	issued: number, idExpiry: number, expires: number): void {
	const expiryTimestamp = typeof native.expiresAt === "string" ? Date.parse(native.expiresAt) : NaN;
	const finiteExpiry = Number.isFinite(expires);
	console.warn(JSON.stringify({ event: "native_response_rejected", phase: "native_response_validate",
		hasPlaintextString: typeof native.plaintext === "string", hasScope: typeof native.scope === "string",
		hasExpiresAtString: typeof native.expiresAt === "string", scopeMatches: native.scope === scope,
		nativeTokenFormatMatches: safeNativeToken(native.plaintext),
		finiteExpiry, expiresAfterID: finiteExpiry && expires > idExpiry,
		expiresAfterRequestBound: finiteExpiry && expires > issued + 300,
		tokenLength: typeof native.plaintext === "string" ? native.plaintext.length : 0,
		...(finiteExpiry ? { tokenExpiryMinusIssuedSeconds: expires - issued } : {}),
		...(finiteExpiry && Number.isFinite(expiryTimestamp) ? { expiryTimestampDeltaMilliseconds: expiryTimestamp - expires * 1000 } : {}) }));
}
function failedNativeGrant(phase: GrantPhase, error: unknown): void {
	let errorName = "unknown", errorCode = "unknown";
	try {
		if (error && typeof error === "object") {
			const candidate = error as { name?: unknown; code?: unknown };
			if (typeof candidate.name === "string" && ERROR_NAMES.has(candidate.name)) errorName = candidate.name;
			if (typeof candidate.code === "string" && ARTIFACTS_ERROR_CODES.has(candidate.code)) errorCode = candidate.code;
		}
	} catch { /* An exception accessor is not a diagnostic source. */ }
	console.warn(JSON.stringify({ event: "native_grant_failed", phase, errorName, errorCode }));
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

async function repoRecord(env: StandaloneEnv, name: string, suppliedRaw?: string): Promise<RepoRecord | null> {
	const raw = suppliedRaw ?? await env.STANDALONE_REPOS!.get(`repo:default/${name}`);
	if (!raw) return null;
	let record: RepoRecord;
	try { record = JSON.parse(raw) as RepoRecord; } catch { return null; }
	if (!/^[a-z0-9]{16}$/.test(record.providerId) || !record.ownerSub || typeof record.publicRead !== "boolean") return null;
	return record;
}
function providerMatches(provider: Awaited<ReturnType<ArtifactsRepoHandle["info"]>>, record: RepoRecord, name: string): boolean {
	return provider.id === record.providerId && provider.name === name && provider.remote === `${REMOTE}${name}.git` &&
		provider.defaultBranch === "main" && provider.readOnly === false;
}
function pathOf(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = /^https:\/\/github\.ezil\.work\/default\/([a-z0-9][a-z0-9._-]{0,99})\.git$/.exec(value);
	return match?.[1] ?? null;
}

/** Only /v2 routes and registered /default/*.git paths are handled here. Null preserves legacy routing. */
export async function standalone(request: Request, env: StandaloneEnv, fetcher: Fetch,
	now = Date.now(), clock: () => number = Date.now): Promise<Response | null> {
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
	if (!env.STANDALONE_REPOS || !env.ARTIFACTS ||
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
				const created = await env.ARTIFACTS.create(name, { setDefaultBranch: "main", readOnly: false });
				if (!created.id || !/^[a-z0-9]{16}$/.test(created.id) || created.name !== name ||
					created.remote !== `${REMOTE}${name}.git` || created.defaultBranch !== "main") return reply(502, "Invalid Artifacts response");
				await env.STANDALONE_REPOS.put(`repo:default/${name}`,
					JSON.stringify({ providerId: created.id, ownerSub: sub,
						publicRead: body["visibility"] === "public" } satisfies RepoRecord));
				return Response.json({ repoURL: `https://github.ezil.work/default/${name}.git`, ref: "refs/heads/main", providerId: created.id },
					{ status: 201, headers: { "cache-control": "no-store" } });
			} catch { return reply(503, "Repository creation unavailable"); }
		}
		const name = pathOf(body["repoURL"]);
		if (!name || (body["scope"] !== "read" && body["scope"] !== "write")) return reply(400, "Invalid grant request");
		let phase: GrantPhase = "registry_lookup";
		try {
			const record = await repoRecord(env, name);
			if (!record || (record.ownerSub !== sub && (body["scope"] === "write" || !record.publicRead))) return reply(403, "Repository unavailable");
			phase = "repository_get";
			using repo = await env.ARTIFACTS.get(name);
			phase = "repository_info";
			if (!providerMatches(await repo.info(), record, name)) return reply(403, "Repository unavailable");
			const issued = Math.floor(clock() / 1000);
			const ttl = Math.min(290, principal.exp - issued - 10);
			if (!Number.isFinite(issued) || ttl < 60) return reply(401, "EZiL ID sign-in expires too soon");
			const scope = body["scope"] as "read" | "write";
			phase = "native_token_create";
			const native = await repo.createToken(scope, ttl);
			phase = "native_response_validate";
			const validatedAt = clock() / 1000;
			const expires = nativeExpiry(native.expiresAt);
			if (native.scope !== scope || !safeNativeToken(native.plaintext) ||
				!Number.isFinite(expires) || !Number.isFinite(validatedAt) || expires <= validatedAt ||
				expires > principal.exp || expires > validatedAt + 300) {
				rejectedNativeToken(native, scope, validatedAt, principal.exp, expires);
				return reply(503, "Invalid Artifacts token");
			}
			phase = "response_serialize";
			return Response.json({ version: 2,
				repository: { id: record.providerId, canonicalURL: `https://github.ezil.work/default/${name}.git`, ref: "refs/heads/main" },
				identity: { issuer: ISSUER, subject: sub },
				git: { username: "ezil", token: native.plaintext, expiresAt: native.expiresAt, scope } },
				{ headers: { "cache-control": "no-store" } });
		} catch (error) { failedNativeGrant(phase, error); return reply(503, "Grant unavailable"); }
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
	const auth = authorization.length <= BASIC_LIMIT ? /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization) : null;
	let credential = "";
	try { credential = atob(auth?.[1] ?? ""); } catch { /* deny */ }
	const token = credential.startsWith("ezil:") ? credential.slice(5) : "";
	if (!safeNativeToken(token)) return challenge();
	try {
		const tokenHash = await digest(token);
		if (!(await env.RL.limit({ key: `v2:git:${tokenHash}` })).success) return reply(429, "Too many Git requests");
		const record = await repoRecord(env, route.routeName, registeredRaw);
		if (!record) return reply(403, "Repository unavailable");
		const headers = new Headers();
		for (const key of ["content-type", "content-encoding", "accept", "accept-encoding", "git-protocol", "user-agent"])
			if (request.headers.has(key)) headers.set(key, request.headers.get(key)!);
		headers.set("authorization", `Bearer ${token}`);
		const upstream = await fetcher(`${REMOTE}${route.routeName}.git${route.rest}${route.rest === "/info/refs" ? url.search : ""}`,
			{ method: request.method, headers, redirect: "manual", ...(request.body ? { body: request.body, duplex: "half" } : {}) } as RequestInit);
		if (upstream.status === 401) return challenge();
		if (upstream.status === 403) return reply(403, "Repository unavailable");
		if (upstream.status >= 300 && upstream.status < 400) return reply(502, "Artifacts redirect refused");
		const out = new Headers(upstream.headers);
		for (const key of ["set-cookie", "www-authenticate", "authorization", "proxy-authenticate"]) out.delete(key);
		out.set("cache-control", "no-store");
		return new Response(upstream.body, { status: upstream.status, headers: out });
	} catch { return reply(503, "Standalone Git unavailable"); }
}
