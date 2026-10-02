#!/usr/bin/env bun
/**
 * Live end-to-end check of the deployed EZiL Git path: the real CLI → the deployed gateway → the deployed EZiL Works
 * API → real Cloudflare Artifacts, signed in as the shared QA builder. CI runs it after every gateway deploy;
 * a person can run it by hand. It never prints a credential.
 *
 *   EZIL_LIVE_GATEWAY   gateway host, default git-staging.ezil.work (github.ezil.work for production)
 *   EZIL_API_ORIGIN     default https://api.ezil.work
 *   EZIL_E2E_QA_EMAIL   default qa-builder@ezil.work
 *   EZIL_E2E_QA_PASSWORD
 *
 * The CLI's credential helper answers only for github.ezil.work and git.ezil.work. For any other gateway host the
 * helper line rewrites `host=` to github.ezil.work first. The grant is bound to the repository, not the hostname,
 * so the same grant is valid at either edge.
 *
 * Side effects are bounded: one device session (revoked at the end), and for a writable repository a push of a
 * throwaway branch `ezil-cli-live-<run>` that is deleted again. The selected task ref is never touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApproveLoginResponseSchema, DescribeLoginResponseSchema, WhoamiResponseSchema } from "@ezil/cli-contract/cli-api";

const GATEWAY = process.env["EZIL_LIVE_GATEWAY"] ?? "git-staging.ezil.work";
const API = (process.env["EZIL_API_ORIGIN"] ?? "https://api.ezil.work").replace(/\/+$/, "");
const EMAIL = process.env["EZIL_E2E_QA_EMAIL"] ?? "qa-builder@ezil.work";
const PASSWORD = process.env["EZIL_E2E_QA_PASSWORD"];
const CLI = join(import.meta.dir, "..", "..", "packages", "cli", "bin", "ezil.ts");
const LEAK = /egg_[0-9a-f]{8}|art_v1_|eca_[0-9a-f]|ecr_[0-9a-f]|ecd_[0-9a-f]/;

if (!PASSWORD) { console.error("EZIL_E2E_QA_PASSWORD is required."); process.exit(2); }
const home = mkdtempSync(join(tmpdir(), "ezil-live-"));
const transcript: string[] = [];
let failed = false;
const step = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"}  ${what}`); if (!ok) failed = true; return ok; };
const env = { PATH: process.env["PATH"] ?? "/usr/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
	EZIL_HOME: join(home, ".ezil"), EZIL_API_ORIGIN: API, EZIL_CLI_STORE: "file", EZIL_DEVICE_LABEL: `live-e2e-${GATEWAY}` };

async function run(cmd: string[], cwd = home) {
	const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	transcript.push(stdout, stderr);
	return { code, stdout, stderr };
}
async function post(path: string, token: string, body: unknown) {
	const response = await fetch(`${API}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: response.status, json: await response.json().catch(() => null) as unknown };
}

try {
	// 1. `ezil auth login`, approved the way the /cli/approve page does it: describe, then approve, as the builder.
	const login = Bun.spawn([process.execPath, CLI, "auth", "login"], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
	const reader = login.stdout.getReader(); let seen = "";
	while (!/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(seen)) { const { value, done } = await reader.read(); if (done) break; seen += new TextDecoder().decode(value); }
	const userCode = /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(seen)?.[1];
	if (!step(Boolean(userCode), "device login shows a user code")) throw new Error("no user code");
	const signin = await fetch(`${API}/auth/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
	const web = (await signin.json() as { accessToken?: string }).accessToken;
	if (!step(signin.status === 200 && Boolean(web), `QA builder web sign-in (${signin.status})`)) throw new Error("sign-in");
	const described = await post("/cli/login/describe", web!, { userCode });
	step(described.status === 200 && DescribeLoginResponseSchema.safeParse(described.json).success, `describe shows the device before approval (${described.status})`);
	const approved = await post("/cli/login/approve", web!, { userCode });
	step(approved.status === 200 && ApproveLoginResponseSchema.safeParse(approved.json).success, `approve (${approved.status})`);
	while (!(await reader.read()).done) { /* drain */ }
	step(await login.exited === 0, "ezil auth login completes");

	// 2. whoami through the CLI and, for the contract check, through the API with the stored session.
	const who = await run([process.execPath, CLI, "whoami"]);
	step(who.code === 0, "ezil whoami");
	const session = JSON.parse(await Bun.file(join(home, ".ezil", "cli-session.json")).text())[API] as { accessToken: string };
	const me = WhoamiResponseSchema.safeParse(await (await fetch(`${API}/cli/whoami`, { headers: { authorization: `Bearer ${session.accessToken}` } })).json());
	step(me.success, "whoami matches the pinned contract");
	const repo = me.success ? (me.data.repositories.find(r => r.access === "write") ?? me.data.repositories[0]) : undefined;
	if (!step(Boolean(repo), `QA builder has a repository (${me.success ? me.data.repositories.length : 0} listed)`)) throw new Error("no repository: the QA builder needs a staffed project with a ready repository");

	// 3. Git, configured for the gateway under test with this checkout's CLI as the helper.
	const rewrite = GATEWAY === "github.ezil.work" ? "cat" : `sed 's/^host=${GATEWAY.replace(/\./g, "\\.")}$/host=github.ezil.work/'`;
	for (const args of [["user.name", "EZiL live e2e"], ["user.email", EMAIL], [`credential.https://${GATEWAY}.helper`, ""]])
		await run(["git", "config", "--global", ...args]);
	await run(["git", "config", "--global", "--add", `credential.https://${GATEWAY}.helper`, `!f(){ ${rewrite} | '${process.execPath}' '${CLI}' git-credential "$1"; }; f`]);
	await run(["git", "config", "--global", `credential.https://${GATEWAY}.useHttpPath`, "true"]);
	const url = repo!.cloneUrl.replace("https://github.ezil.work/", `https://${GATEWAY}/`);
	const clone = await run(["git", "clone", "-q", url]);
	step(clone.code === 0, `clone ${repo!.repository} (${repo!.access}) through ${GATEWAY}`);
	const dir = join(home, repo!.repository);
	step((await run(["git", "rev-parse", "--is-inside-work-tree"], dir)).stdout.trim() === "true", `clone landed in ./${repo!.repository}`);

	// 4. Push: a throwaway branch for write access, deleted again; a clear refusal for read-only.
	const branch = `ezil-cli-live-${Date.now()}`;
	await run(["git", "commit", "-q", "--allow-empty", "-m", "ezil-cli live e2e"], dir);
	const push = await run(["git", "push", "-q", "origin", `HEAD:refs/heads/${branch}`], dir);
	if (repo!.access === "write") {
		step(push.code === 0, "push a throwaway branch");
		step((await run(["git", "push", "-q", "origin", "--delete", branch], dir)).code === 0, "delete the throwaway branch");
	} else {
		step(push.code !== 0 && /read-only access/.test(push.stderr), "push to a read-only repository is refused with the builder's sentence");
	}

	// 4b. When the builder also has a read-only repository (staffed, no task), its push is refused at the edge,
	// before anything reaches Artifacts: the audited `scope_read_only` denial.
	const readOnly = me.success ? me.data.repositories.find(r => r.access === "read" && r.repository !== repo!.repository) : undefined;
	if (repo!.access === "write" && readOnly) {
		const roUrl = readOnly.cloneUrl.replace("https://github.ezil.work/", `https://${GATEWAY}/`);
		step((await run(["git", "clone", "-q", roUrl, "read-only"])).code === 0, `clone read-only ${readOnly.repository}`);
		const roDir = join(home, "read-only");
		await run(["git", "commit", "-q", "--allow-empty", "-m", "ezil-cli live e2e (must be refused)"], roDir);
		const refused = await run(["git", "push", "-q", "origin", `HEAD:refs/heads/${branch}`], roDir);
		step(refused.code !== 0 && /read-only access/.test(refused.stderr), "push to a read-only repository is refused with the builder's sentence");
	}

	// 5. An unknown repository answers like a forbidden one, so a URL can't be used to probe.
	const unknown = await run(["git", "ls-remote", `https://${GATEWAY}/no-such-namespace/no-such-repo.git`]);
	step(unknown.code !== 0, "unknown repository is refused");

	// 6. Logout revokes the device; the very next Git operation is refused.
	step((await run([process.execPath, CLI, "auth", "logout"])).code === 0, "ezil auth logout");
	const after = await run(["git", "fetch", "-q", "origin"], dir);
	step(after.code !== 0 && /ezil auth login/.test(after.stderr), "fetch after logout is refused and says to sign in");
} catch (error) {
	step(false, error instanceof Error ? error.message : "unexpected failure");
} finally {
	// A run that failed early must not leave a live device session behind.
	if (await Bun.file(join(home, ".ezil", "cli-session.json")).exists()) await run([process.execPath, CLI, "auth", "logout"]);
	step(!LEAK.test(transcript.join("\n")), "no credential appeared in any output");
	rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
