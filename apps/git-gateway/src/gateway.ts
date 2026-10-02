import { GIT_DENY_MESSAGES, GIT_GRANT_PATTERN, GitAuthorizeResponseSchema, parseGitRoutePath, type GitAuthorizeAllow,
	type GitAuthorizeRequest, type GitService } from "@ezil/cli-contract/git-gateway";
import { INSTALL_PS1, INSTALL_SH } from "./install";
import { splitReceivePack } from "./pkt-line";
import { sha256Hex, signedHeaders } from "./sign";

/**
 * github.ezil.work: Git smart HTTP in front of Cloudflare Artifacts. See docs/ARCHITECTURE.md.
 *
 * The client presents an EZiL git grant (Basic auth, issued by `ezil git-credential`). Every request
 * is authorized by the EZiL Works API, which mints an Artifacts token with the exact scope for the
 * Git service. That token lives only inside the upstream request, so it never reaches the client
 * and never reaches a log.
 */

export interface GatewayEnv {
	readonly API_ORIGIN?: string;
	readonly GIT_GATEWAY_SECRET?: string;
	readonly IP_HASH_SALT?: string;
	/** The commit CI deployed (`wrangler deploy --var EZIL_COMMIT:<sha>`), reported by /health. */
	readonly EZIL_COMMIT?: string;
	readonly RL?: { limit(options: { key: string }): Promise<{ success: boolean }> };
	/** Where release files live; default the public GitHub releases of EZiLHQ/ezil-cli. Tests point it elsewhere. */
	readonly RELEASES_ORIGIN?: string;
}
export interface GatewayDeps {
	readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	readonly now: () => number;
	readonly log: (line: Record<string, unknown>) => void;
	readonly waitUntil: (promise: Promise<unknown>) => void;
	readonly cache: Map<string, { allow: GitAuthorizeAllow; until: number }>;
}

/** How long one read authorization may serve the next requests of the same clone or fetch. */
export const READ_CACHE_MS = 5_000;
const ARTIFACTS_REMOTE = /^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\//;
const FORWARD_REQUEST = ["content-type", "content-encoding", "accept", "accept-encoding", "git-protocol", "user-agent"];
const DROP_RESPONSE = new Set(["set-cookie", "www-authenticate", "authorization", "proxy-authenticate"]);
const CHALLENGE = { "www-authenticate": 'Basic realm="EZiL Git", charset="UTF-8"' };
const text = (status: number, body: string, headers: Record<string, string> = {}) =>
	new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
/** Release files: one binary per target, plus SHA256SUMS. Nothing else in the bucket is reachable. */
const RELEASE_FILE = /^\/cli\/(\d{1,4}\.\d{1,4}\.\d{1,6})\/(ezil-\1-(?:darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64\.exe)|SHA256SUMS)$/;

export const DEFAULT_RELEASES_ORIGIN = "https://github.com/EZiLHQ/ezil-cli/releases";

/**
 * The public, unauthenticated download surface: the installers, the latest version, and redirects to release files.
 * Files are served by the GitHub release itself (so its SHA256SUMS is the one published with the binaries); this only
 * gives them a stable EZiL address. `/cli/latest` follows the release page's own redirect to the newest tag.
 */
async function download(pathname: string, env: GatewayEnv, deps: GatewayDeps): Promise<Response | null> {
	const script = (body: string) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
	if (pathname === "/install.sh") return script(INSTALL_SH);
	if (pathname === "/install.ps1") return script(INSTALL_PS1);
	const origin = (env.RELEASES_ORIGIN ?? DEFAULT_RELEASES_ORIGIN).replace(/\/+$/, "");
	if (pathname === "/cli/latest") {
		let location: string | null = null;
		try {
			const answer = await deps.fetch(`${origin}/latest`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
			location = answer.headers.get("location");
		} catch { /* below */ }
		const version = location ? /\/tag\/v(\d{1,4}\.\d{1,4}\.\d{1,6})$/.exec(location)?.[1] : undefined;
		if (!version) return text(503, "EZiL: the latest version is unavailable. Try again shortly.\n", { "retry-after": "60" });
		return new Response(version, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" } });
	}
	const file = RELEASE_FILE.exec(pathname);
	if (!file) return null;
	return new Response(null, { status: 302, headers: { location: `${origin}/download/v${file[1]}/${file[2]}`, "cache-control": "public, max-age=3600" } });
}

const maskRemote = (url: string) => url.replace(/^https:\/\/[0-9a-f]{32}\./, "https://***.");

function grantFrom(header: string | null): string | null {
	const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? "");
	if (!match) return null;
	let decoded: string;
	try { decoded = atob(match[1]!); } catch { return null; }
	const colon = decoded.indexOf(":");
	const password = colon >= 0 ? decoded.slice(colon + 1) : "";
	return GIT_GRANT_PATTERN.test(password) ? password : null;
}

async function authorize(env: GatewayEnv, deps: GatewayDeps, request: GitAuthorizeRequest): Promise<Response | GitAuthorizeAllow> {
	const body = JSON.stringify(request);
	let response: Response;
	try {
		response = await deps.fetch(new URL("/internal/git/authorize", env.API_ORIGIN).toString(), {
			method: "POST", headers: await signedHeaders(env.GIT_GATEWAY_SECRET!, body, deps.now()), body, signal: AbortSignal.timeout(5000) });
	} catch {
		return text(503, "EZiL: the authorization service is unavailable. Try again shortly.\n", { "retry-after": "5" });
	}
	let parsed;
	try { parsed = GitAuthorizeResponseSchema.parse(await response.json()); } catch {
		return text(503, "EZiL: the authorization service is unavailable. Try again shortly.\n", { "retry-after": "5" });
	}
	if (parsed.decision === "deny") {
		return text(parsed.status, `${GIT_DENY_MESSAGES[parsed.reason]}\n`, parsed.status === 401 ? CHALLENGE : {});
	}
	return parsed;
}

export async function handle(request: Request, env: GatewayEnv, deps: GatewayDeps): Promise<Response> {
	const started = deps.now();
	const url = new URL(request.url);
	const requestId = crypto.randomUUID();
	const fields: Record<string, unknown> = { requestId, cfRay: request.headers.get("cf-ray"), method: request.method, path: url.pathname };
	const finish = (response: Response, extra: Record<string, unknown> = {}) => {
		deps.log({ ...fields, ...extra, status: response.status, durationMs: deps.now() - started });
		return response;
	};

	// Deploy probe: which commit is live, and whether the secrets it needs are bound. Never their values.
	if (url.pathname === "/health" && request.method === "GET")
		return finish(Response.json({ ok: true, commit: env.EZIL_COMMIT ?? null, configured: Boolean(env.API_ORIGIN && env.GIT_GATEWAY_SECRET && env.IP_HASH_SALT) },
			{ headers: { "cache-control": "no-store" } }));
	if (request.method === "GET" || request.method === "HEAD") {
		const served = await download(url.pathname, env, deps);
		if (served) return finish(served);
	}
	if (url.pathname === "/" && request.method === "GET")
		return finish(text(200, "github.ezil.work — EZiL Git.\n\nInstall the EZiL CLI:\n  macOS / Linux:  curl -fsSL https://github.ezil.work/install.sh | sh\n  Windows:        irm https://github.ezil.work/install.ps1 | iex\n\nThen run `ezil auth login`, and use plain git.\n"));
	const route = parseGitRoutePath(url.pathname);
	if (!route || route.rest === "") return finish(text(404, "Not found.\n"));
	let service: GitService;
	if (route.rest === "/info/refs") {
		if (request.method !== "GET") return finish(text(405, "Method not allowed.\n", { allow: "GET" }));
		const asked = url.searchParams.get("service");
		if (asked !== "git-upload-pack" && asked !== "git-receive-pack") return finish(text(404, "Not found.\n"));
		service = asked;
	} else {
		if (request.method !== "POST") return finish(text(405, "Method not allowed.\n", { allow: "POST" }));
		service = route.rest === "/git-receive-pack" ? "git-receive-pack" : "git-upload-pack";
	}
	Object.assign(fields, { service, ns: route.routeNamespace, repo: route.routeName });
	if (!env.API_ORIGIN || !env.GIT_GATEWAY_SECRET) return finish(text(503, "EZiL: Git is not configured on this host.\n", { "retry-after": "60" }));

	const grant = grantFrom(request.headers.get("authorization"));
	if (!grant) return finish(text(401, "EZiL: sign in with `ezil auth login`.\n", CHALLENGE));
	const grantKey = await sha256Hex(grant);
	const ip = request.headers.get("cf-connecting-ip");
	const ipHash = ip && env.IP_HASH_SALT ? await sha256Hex(`${env.IP_HASH_SALT}:${ip}`) : null;
	if (env.RL) {
		const limits = await Promise.all([env.RL.limit({ key: `grant:${grantKey}` }), ...(ipHash ? [env.RL.limit({ key: `ip:${ipHash}` })] : [])]);
		if (limits.some(l => !l.success)) return finish(text(429, "EZiL: too many Git requests. Slow down.\n", { "retry-after": "30" }));
	}

	// Reads only, and only for a few seconds: a clone makes 2–3 requests in a row, and those may share one
	// decision. A push is never served from cache, so revocation and task closure stop it at once, and
	// every push gets its own authorization (and audit row) to correlate its ref updates with.
	const cacheable = service === "git-upload-pack";
	const cacheKey = `${grantKey}:${route.routeNamespace}/${route.routeName}:${service}`;
	const cached = cacheable ? deps.cache.get(cacheKey) : undefined;
	let allow: GitAuthorizeAllow;
	if (cached && cached.until > deps.now()) allow = cached.allow;
	else {
		const decided = await authorize(env, deps, { grant, routeNamespace: route.routeNamespace, routeName: route.routeName, service,
			requestId, cfRay: request.headers.get("cf-ray"), ipHash });
		if (decided instanceof Response) return finish(decided, { decision: "deny" });
		allow = decided;
		// Allows only, and never past the token's own life. Denials are never cached, so a fixed permission works at once.
		const until = Math.min(deps.now() + READ_CACHE_MS, Date.parse(allow.expiresAt) - 5_000);
		if (cacheable && until > deps.now()) deps.cache.set(cacheKey, { allow, until });
	}
	if (!ARTIFACTS_REMOTE.test(allow.artifactsRemote)) return finish(text(503, "EZiL: upstream refused.\n"), { decision: "bad_upstream" });

	const headers = new Headers();
	for (const name of FORWARD_REQUEST) { const value = request.headers.get(name); if (value) headers.set(name, value); }
	headers.set("authorization", `Bearer ${allow.artifactsToken}`);
	const upstreamUrl = `${allow.artifactsRemote}${route.rest}${route.rest === "/info/refs" ? url.search : ""}`;

	let body: ReadableStream<Uint8Array> | null = request.body;
	if (service === "git-receive-pack" && route.rest === "/git-receive-pack" && body && !request.headers.get("content-encoding")) {
		const split = await splitReceivePack(body);
		body = split.stream;
		if (split.refUpdates && allow.operationId) {
			const annotate = JSON.stringify({ operationId: allow.operationId, requestId, refUpdates: split.refUpdates });
			deps.waitUntil((async () => {
				try { await deps.fetch(new URL("/internal/git/annotate", env.API_ORIGIN).toString(), { method: "POST",
					headers: await signedHeaders(env.GIT_GATEWAY_SECRET!, annotate, deps.now()), body: annotate, signal: AbortSignal.timeout(5000) }); }
				catch { /* correlation is best effort; the push already went through */ }
			})());
			fields["refUpdates"] = split.refUpdates.length;
		}
	}
	let upstream: Response;
	try {
		upstream = await deps.fetch(upstreamUrl, { method: request.method, headers, redirect: "manual", ...(body ? { body, duplex: "half" } : {}) } as RequestInit);
	} catch {
		return finish(text(502, "EZiL: the Git backend is unavailable. Try again shortly.\n", { "retry-after": "5" }), { upstream: maskRemote(upstreamUrl) });
	}
	const out = new Headers();
	upstream.headers.forEach((value, name) => { if (!DROP_RESPONSE.has(name.toLowerCase())) out.set(name, value); });
	return finish(new Response(upstream.body, { status: upstream.status, headers: out }), { upstreamStatus: upstream.status, decision: "allow" });
}
