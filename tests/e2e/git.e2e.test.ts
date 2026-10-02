import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DeviceLoginRequestSchema, DeviceLoginResponseSchema, GitGrantRequestSchema, GitGrantResponseSchema, RevokedResponseSchema,
	TokenRequestSchema, TokenResponseSchema, WhoamiResponseSchema,
} from "@ezil/cli-contract/cli-api";
import {
	GIT_DENY_MESSAGES, GIT_GATEWAY_SIGNATURE_HEADER, GIT_GATEWAY_TIMESTAMP_HEADER, GitAnnotateRequestSchema, GitAuthorizeRequestSchema,
	GitAuthorizeResponseSchema, parseGitRoutePath, scopeForService, type GitDenyReason, type RefUpdate,
} from "@ezil/cli-contract/git-gateway";
import { handle } from "../../apps/git-gateway/src/gateway";

/**
 * The whole client side of EZiL Git, locally, with no network and no real credential:
 *
 * stock `git` → `ezil git-credential` (the real CLI binary, signed in by the real `ezil auth login` device flow)
 * → the github.ezil.work gateway (the real handler) → a stand-in EZiL Works API → a stand-in Cloudflare Artifacts
 * that is a real Git server (`git http-backend`) and enforces a repo-scoped bearer whose scope covers the service.
 *
 * The Works stand-in is contract-faithful, not clever: it parses every request and every response with the pinned
 * schemas in `packages/contract`, and it checks the gateway's HMAC exactly as Works does. Real Works authority
 * (tasks, selections, audit chain) is proven in EZiL-Works' own `cli.test.ts`, and the deployed pair is proven by
 * `tests/live` against git-staging.ezil.work.
 */
const SECRET = "e".repeat(48);
const LABEL = "0123456789abcdef0123456789abcdef";
const NS = "p-test";
const CLI_BIN = join(import.meta.dir, "..", "..", "packages", "cli", "bin", "ezil.ts");
let root: string;
const servers: Array<{ stop(force?: boolean): void }> = [];
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "ezil-git-e2e-")); });
afterAll(() => { for (const s of servers) s.stop(true); rmSync(root, { recursive: true, force: true }); });

async function run(cmd: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
	const proc = Bun.spawn(cmd, { cwd: options.cwd ?? root, env: options.env ?? process.env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

/** A minimal Artifacts stand-in: Bearer checked against minted tokens, then `git http-backend` as CGI. */
function fakeArtifacts(projectRoot: string, minted: Map<string, { name: string; scope: "read" | "write" }>) {
	return Bun.serve({ port: 0, async fetch(request) {
		const url = new URL(request.url);
		const match = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(url.pathname);
		if (!match) return new Response("not found", { status: 404 });
		const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
		const grant = token ? minted.get(token) : undefined;
		const service = url.searchParams.get("service") ?? match[3]!.slice(1);
		if (!grant || grant.name !== match[2]) return new Response("unauthorized", { status: 401 });
		if (service === "git-receive-pack" && grant.scope !== "write") return new Response("forbidden", { status: 403 });
		const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : undefined;
		const env: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/bin", GIT_PROJECT_ROOT: projectRoot, GIT_HTTP_EXPORT_ALL: "1",
			REQUEST_METHOD: request.method, PATH_INFO: `/${match[1]}/${match[2]}.git${match[3]}`, QUERY_STRING: url.search.slice(1),
			CONTENT_TYPE: request.headers.get("content-type") ?? "", CONTENT_LENGTH: String(body?.length ?? 0), REMOTE_USER: "artifacts",
			REMOTE_ADDR: "127.0.0.1", ...(request.headers.get("git-protocol") ? { GIT_PROTOCOL: request.headers.get("git-protocol")! } : {}) };
		const proc = Bun.spawn(["git", "http-backend"], { env, stdin: body ?? "ignore", stdout: "pipe", stderr: "pipe" });
		const raw = new Uint8Array(await new Response(proc.stdout).arrayBuffer()); await proc.exited;
		const split = Buffer.from(raw).indexOf("\r\n\r\n");
		const head = Buffer.from(raw.subarray(0, split)).toString("latin1");
		const headers = new Headers(); let status = 200;
		for (const line of head.split("\r\n")) {
			const [k, ...v] = line.split(":"); const value = v.join(":").trim();
			if (k!.toLowerCase() === "status") status = parseInt(value, 10); else if (k) headers.set(k, value);
		}
		return new Response(raw.subarray(split + 4), { status, headers });
	} });
}

interface AuditEvent { type: string; payload: Record<string, unknown> }

/** The EZiL Works API, reduced to its contract: two repositories, one writable, one read-only. */
function fakeWorks(minted: Map<string, { name: string; scope: "read" | "write" }>) {
	const repos = new Map([
		["acme-3f9a1c/acme", { artifacts: "artifact-a", scope: "write" as const }],
		["acme-3f9a1c/docs", { artifacts: "artifact-b", scope: "read" as const }],
	]);
	const sessions = new Map<string, { id: string; revoked: boolean }>();
	const grants = new Map<string, { session: string; route: string; scope: "read" | "write" }>();
	const audit: AuditEvent[] = [];
	let deviceCode = "";
	const hex = (n: number) => randomBytes(n).toString("hex");
	const json = (value: unknown, status = 200) => Response.json(value, { status });
	const refuse = (status: number, error: string, message: string) => json({ error, message }, status);
	const signed = (request: Request, body: string) => {
		const stamp = request.headers.get(GIT_GATEWAY_TIMESTAMP_HEADER) ?? "";
		const given = Buffer.from(request.headers.get(GIT_GATEWAY_SIGNATURE_HEADER) ?? "", "hex");
		const want = createHmac("sha256", SECRET).update(`${stamp}.${body}`).digest();
		return given.length === want.length && timingSafeEqual(given, want) && Math.abs(Date.now() - Number(stamp)) < 300_000;
	};
	const caller = (request: Request) => {
		const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
		const session = token ? sessions.get(token) : undefined;
		return session && !session.revoked ? session : null;
	};
	const deny = (status: 401 | 403 | 404, reason: GitDenyReason, payload: Record<string, unknown>) => {
		audit.push({ type: "git_operation.denied", payload: { ...payload, reason } });
		return json(GitAuthorizeResponseSchema.parse({ decision: "deny", status, reason, message: GIT_DENY_MESSAGES[reason] }));
	};
	const server: ReturnType<typeof Bun.serve> = Bun.serve({ port: 0, async fetch(request): Promise<Response> {
		const path = new URL(request.url).pathname;
		const body = request.method === "GET" ? "" : await request.text();
		if (path === "/cli/login/device") {
			DeviceLoginRequestSchema.parse(JSON.parse(body));
			deviceCode = `ecd_${hex(32)}`;
			const origin: string = `http://127.0.0.1:${server.port}`;
			return json(DeviceLoginResponseSchema.parse({ deviceCode, userCode: "BCDF-GHJK", verificationUri: `${origin}/cli/approve`,
				verificationUriComplete: `${origin}/cli/approve?code=BCDF-GHJK`, expiresAt: new Date(Date.now() + 600_000).toISOString(), interval: 1 }));
		}
		if (path === "/cli/token") {
			const input = TokenRequestSchema.parse(JSON.parse(body));
			if (input.grant_type !== "device_code" || input.device_code !== deviceCode) return refuse(401, "invalid_grant", "Sign in again.");
			const id = randomUUID(); const access = `eca_${id}_${hex(32)}`;
			sessions.set(access, { id, revoked: false });
			return json(TokenResponseSchema.parse({ access_token: access, refresh_token: `ecr_${id}_${hex(32)}`, token_type: "Bearer",
				expires_at: new Date(Date.now() + 900_000).toISOString(), session_id: id, session_expires_at: new Date(Date.now() + 86_400_000).toISOString() }));
		}
		if (path === "/cli/whoami") {
			const session = caller(request);
			if (!session) return refuse(401, "unauthorized", "Run `ezil auth login`.");
			return json(WhoamiResponseSchema.parse({ account: { id: "b-1", email: "builder@example.test", role: "builder" },
				session: { id: session.id, device: "e2e", os: "linux", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
				repositories: [...repos].map(([route, r]) => ({ project: "Acme", projectId: "p-1", repository: route.split("/")[1]!, access: r.scope,
					taskPublicId: r.scope === "write" ? "t-1" : null, cloneUrl: `https://github.ezil.work/${route}.git` })) }));
		}
		if (path === "/cli/git-grant") {
			const session = caller(request);
			if (!session) return refuse(401, "unauthorized", "Run `ezil auth login`.");
			const input = GitGrantRequestSchema.parse(JSON.parse(body));
			const route = parseGitRoutePath(`/${input.path.replace(/^\/+/, "")}`);
			const repo = route ? repos.get(`${route.routeNamespace}/${route.routeName}`) : undefined;
			if (!route || !repo) return refuse(404, "repository_not_found", GIT_DENY_MESSAGES.repository_not_found);
			const grant = `egg_${hex(32)}`;
			grants.set(grant, { session: session.id, route: `${route.routeNamespace}/${route.routeName}`, scope: repo.scope });
			audit.push({ type: "git_grant.issued", payload: { route: `${route.routeNamespace}/${route.routeName}`, scope: repo.scope } });
			return json(GitGrantResponseSchema.parse({ username: "ezil", password: grant, password_expiry_utc: Math.floor(Date.now() / 1000) + 900, scope: repo.scope }));
		}
		if (path === "/cli/logout") {
			const session = caller(request);
			if (session) session.revoked = true;
			return json(RevokedResponseSchema.parse({ revoked: true }));
		}
		if (path === "/internal/git/authorize") {
			if (!signed(request, body)) return refuse(401, "invalid_signature", "Bad signature.");
			const input = GitAuthorizeRequestSchema.parse(JSON.parse(body)); // strict: the gateway sends exactly the contract
			const grant = grants.get(input.grant);
			const where = { route: `${input.routeNamespace}/${input.routeName}`, service: input.service };
			if (!grant || grant.route !== where.route) return deny(401, "grant_invalid", where);
			if ([...sessions.values()].some(s => s.id === grant.session && s.revoked)) return deny(401, "session_revoked", where);
			const scope = scopeForService(input.service);
			if (scope === "write" && grant.scope !== "write") return deny(403, "scope_read_only", where);
			const repo = repos.get(where.route)!;
			const token = `art_v1_${hex(16)}`; minted.set(token, { name: repo.artifacts, scope });
			const operationId = randomUUID();
			audit.push({ type: "git_operation.authorized", payload: { ...where, scope, operationId } });
			return json(GitAuthorizeResponseSchema.parse({ decision: "allow", artifactsRemote: `https://${LABEL}.artifacts.cloudflare.net/git/${NS}/${repo.artifacts}.git`,
				artifactsToken: token, scope, expiresAt: new Date(Date.now() + 600_000).toISOString(), operationId }));
		}
		if (path === "/internal/git/annotate") {
			if (!signed(request, body)) return refuse(401, "invalid_signature", "Bad signature.");
			const input = GitAnnotateRequestSchema.parse(JSON.parse(body));
			audit.push({ type: "git_operation.ref_updates", payload: { operationId: input.operationId, refUpdates: input.refUpdates } });
			return json({ recorded: true });
		}
		return refuse(404, "not_found", "Not found.");
	} });
	return { server, audit };
}

it("signs in, clones into the real repo name, pushes, is audited, and is refused where it should be", async () => {
	// --- Artifacts stand-in: two bare repos with one commit each. ---
	const bare = join(root, "artifacts"); mkdirSync(join(bare, NS), { recursive: true });
	const seed = join(root, "seed"); mkdirSync(seed);
	const gitEnv0 = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "seed.gitconfig"), HOME: root } as Record<string, string>;
	for (const name of ["artifact-a", "artifact-b"]) {
		expect((await run(["git", "init", "-q", "--bare", "-b", "main", join(bare, NS, `${name}.git`)], { env: gitEnv0 })).code).toBe(0);
		const work = join(seed, name); mkdirSync(work);
		await run(["git", "init", "-q", "-b", "main"], { cwd: work, env: gitEnv0 });
		writeFileSync(join(work, "README.md"), `# ${name}\n`);
		await run(["git", "add", "."], { cwd: work, env: gitEnv0 });
		await run(["git", "-c", "user.name=seed", "-c", "user.email=seed@example.test", "commit", "-q", "-m", "seed"], { cwd: work, env: gitEnv0 });
		expect((await run(["git", "push", "-q", join(bare, NS, `${name}.git`), "main"], { cwd: work, env: gitEnv0 })).code).toBe(0);
	}
	const minted = new Map<string, { name: string; scope: "read" | "write" }>();
	const artifacts = fakeArtifacts(bare, minted); servers.push(artifacts);
	const works = fakeWorks(minted); servers.push(works.server);
	const apiOrigin = `http://127.0.0.1:${works.server.port}`;

	// --- The gateway (real handler), upstream rewritten from the Artifacts host to the stand-in. ---
	const pendingWork: Promise<unknown>[] = [];
	const gateway = Bun.serve({ port: 0, fetch: request => handle(request, { API_ORIGIN: apiOrigin, GIT_GATEWAY_SECRET: SECRET, IP_HASH_SALT: "salt" }, {
		fetch: ((input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const upstream = /^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net(\/git\/.*)$/.exec(url);
			return fetch(upstream ? `http://127.0.0.1:${artifacts.port}${upstream[1]}` : url, init);
		}) as typeof fetch,
		now: Date.now, cache: new Map(), log: () => {}, waitUntil: p => { pendingWork.push(p); } }) });
	servers.push(gateway);
	const gw = `127.0.0.1:${gateway.port}`;

	// --- `ezil auth login`: the real device flow, file store, and the git config it writes. ---
	const gitconfig = join(root, "builder.gitconfig");
	writeFileSync(gitconfig, ["[user]", "\tname = Builder", "\temail = builder@example.test", "[protocol]", "\tversion = 2", ""].join("\n"));
	const ezilHome = join(root, ".ezil");
	const cliEnv = { PATH: process.env["PATH"] ?? "/usr/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitconfig, GIT_TERMINAL_PROMPT: "0",
		EZIL_HOME: ezilHome, EZIL_API_ORIGIN: apiOrigin, EZIL_CLI_STORE: "file", EZIL_DEVICE_LABEL: "e2e" };
	const login = await run([process.execPath, CLI_BIN, "auth", "login"], { env: cliEnv });
	expect(login.code).toBe(0);
	expect(login.stdout).toContain("BCDF-GHJK");
	expect(login.stdout + login.stderr).not.toMatch(/eca_|ecr_|ecd_/);
	const written = readFileSync(gitconfig, "utf8");
	expect(written).toContain('[credential "https://github.ezil.work"]');
	expect(written).toContain("helper = !ezil git-credential");
	expect(written).toContain("useHttpPath = true");
	expect((readFileSync(join(ezilHome, "cli-session.json")).length)).toBeGreaterThan(0);
	const whoami = await run([process.execPath, CLI_BIN, "whoami"], { env: cliEnv });
	expect(whoami.code).toBe(0);
	expect(whoami.stdout).toContain("rw  https://github.ezil.work/acme-3f9a1c/acme.git");

	// Point git at the local gateway the way the helper is meant to be reached: the helper for that host is this CLI.
	writeFileSync(gitconfig, `${readFileSync(gitconfig, "utf8")}[url "http://${gw}/"]\n\tinsteadOf = https://github.ezil.work/\n` +
		`[credential "http://${gw}"]\n\thelper =\n\thelper = !'${process.execPath}' '${CLI_BIN}' git-credential\n\tuseHttpPath = true\n`);
	const gitEnv = { ...cliEnv, EZIL_GIT_TEST_HOST: gw };

	// 1. Clone: plain git, no token pasted, lands in the real name.
	const work = join(root, "work"); mkdirSync(work);
	const clone = await run(["git", "clone", "https://github.ezil.work/acme-3f9a1c/acme.git"], { cwd: work, env: gitEnv });
	expect(clone.stderr).not.toContain("fatal");
	expect(clone.code).toBe(0);
	expect(existsSync(join(work, "acme", "README.md"))).toBe(true);
	const checkout = join(work, "acme");

	// 2. Commit and push: accepted, and the Artifacts repo moves.
	writeFileSync(join(checkout, "feature.txt"), "hello\n");
	await run(["git", "add", "feature.txt"], { cwd: checkout, env: gitEnv });
	await run(["git", "commit", "-q", "-m", "feature"], { cwd: checkout, env: gitEnv });
	const head = (await run(["git", "rev-parse", "HEAD"], { cwd: checkout, env: gitEnv })).stdout.trim();
	const push = await run(["git", "push", "origin", "main"], { cwd: checkout, env: gitEnv });
	expect(push.code).toBe(0);
	expect((await run(["git", "--git-dir", join(bare, NS, "artifact-a.git"), "rev-parse", "main"], { env: gitEnv0 })).stdout.trim()).toBe(head);

	// 3. Audit: the push was authorized for write and annotated with the exact ref and SHA it moved.
	await Promise.all(pendingWork);
	expect(works.audit.some(e => e.type === "git_operation.authorized" && e.payload["service"] === "git-receive-pack" && e.payload["scope"] === "write")).toBe(true);
	const moved = works.audit.filter(e => e.type === "git_operation.ref_updates").flatMap(e => e.payload["refUpdates"] as RefUpdate[]);
	expect(moved).toContainEqual(expect.objectContaining({ ref: "refs/heads/main", new: head }));
	expect(JSON.stringify(works.audit)).not.toMatch(/egg_|art_v1_/);

	// 4. Negative: the read-only repo clones, and its push is refused without moving Artifacts.
	const docsClone = await run(["git", "clone", "https://github.ezil.work/acme-3f9a1c/docs.git"], { cwd: work, env: gitEnv });
	expect(docsClone.code).toBe(0);
	const docsDir = join(work, "docs");
	writeFileSync(join(docsDir, "x.md"), "x\n");
	await run(["git", "add", "."], { cwd: docsDir, env: gitEnv });
	await run(["git", "commit", "-q", "-m", "x"], { cwd: docsDir, env: gitEnv });
	const refused = await run(["git", "push", "origin", "main"], { cwd: docsDir, env: gitEnv });
	expect(refused.code).not.toBe(0);
	expect((await run(["git", "--git-dir", join(bare, NS, "artifact-b.git"), "rev-parse", "main"], { env: gitEnv0 })).stdout.trim())
		.not.toBe((await run(["git", "rev-parse", "HEAD"], { cwd: docsDir, env: gitEnv })).stdout.trim());
	expect(works.audit.filter(e => e.type === "git_operation.denied").map(e => e.payload["reason"])).toContain("scope_read_only");

	// 5. Logout: revoked on the server, forgotten locally; the next Git operation is refused and nothing is left on disk.
	const logout = await run([process.execPath, CLI_BIN, "auth", "logout"], { env: cliEnv });
	expect(logout.code).toBe(0);
	expect(existsSync(join(ezilHome, "cli-session.json"))).toBe(false);
	const afterLogout = await run(["git", "fetch", "origin"], { cwd: checkout, env: gitEnv });
	expect(afterLogout.code).not.toBe(0);
	expect(afterLogout.stderr).toContain("ezil auth login");
	expect(readFileSync(gitconfig, "utf8")).not.toContain("egg_");
	expect(existsSync(join(root, ".git-credentials"))).toBe(false);
}, 120_000);
