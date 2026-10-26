import { expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function until(check: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!check()) { if (Date.now() > deadline) throw new Error("cancellation barrier timed out"); await Bun.sleep(20); }
}
function group(child: ChildProcess, signal: NodeJS.Signals) {
	try { process.kill(-child.pid!, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function fixture(stallGrant = false) {
	const root = mkdtempSync(join(tmpdir(), "ezil-cancel-")), home = join(root, "auth"), destination = join(root, "checkout"), scratch = join(root, "scratch");
	mkdirSync(home); mkdirSync(scratch);
	let grantStarted = false;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		if (new URL(request.url).pathname === "/cli/whoami") return Response.json({ account: { id: "a", email: "test@example.invalid", role: "builder" },
			session: { id: "12345678-1234-4234-8234-123456789abc", device: "test", os: "linux", expiresAt: "2100-01-01T00:00:00.000Z" },
			repositories: [{ project: "p", projectId: "p", repository: "r", access: "read", taskPublicId: null, cloneUrl: "https://github.ezil.work/acme/repo.git" }] });
		grantStarted = true;
		if (stallGrant) return new Promise<Response>(() => {});
		return Response.json({ username: "ezil", password: `egg_${"a".repeat(64)}`, password_expiry_utc: 4102444800, scope: "read" });
	} });
	const origin = `http://127.0.0.1:${server.port}`;
	writeFileSync(join(home, "cli-session.json"), JSON.stringify({ [origin]: { apiOrigin: origin, sessionId: "a", accessToken: "eca_synthetic", refreshToken: "ecr_synthetic", accessExpiresAt: "2100-01-01T00:00:00.000Z" } }));
	const realGit = Bun.which("git")!;
	const shim = join(root, "git");
	writeFileSync(shim, `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);
if(!args.includes('clone'))process.exit(cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}).status??1);
const target=args.at(-1);fs.mkdirSync(target);fs.writeFileSync(target+'/partial','owned');
if(process.env.MODE==='success'){
 fs.rmSync(target+'/partial');cp.spawnSync(${JSON.stringify(realGit)},['init',target],{stdio:'ignore'});
 cp.spawnSync(${JSON.stringify(realGit)},['-C',target,'remote','add','origin','https://github.ezil.work/acme/repo.git'],{stdio:'ignore'});process.exit(0);
}
const descendant=cp.spawn(process.execPath,['-e',\`const fs=require('node:fs');process.on('SIGTERM',()=>{if(process.env.MODE!=='force'){fs.writeFileSync(process.env.ROOT+'/descendant-exited','yes');process.exit(0)}});process.on('SIGINT',()=>{});fs.writeFileSync(process.env.ROOT+'/ready','yes');setInterval(()=>{},1000);\`],{stdio:'ignore'});
process.on('SIGTERM',()=>{if(process.env.MODE!=='force')descendant.kill('SIGTERM')});
process.on('SIGINT',()=>{if(process.env.MODE!=='force')descendant.kill('SIGTERM')});
descendant.on('exit',()=>process.exit(1));
`);
	chmodSync(shim, 0o700);
	const children: ChildProcess[] = [];
	const launch = (mode = "block") => {
		const child = spawn(process.env["EZIL_TEST_CLI_RUNTIME"] ?? process.execPath, [process.env["EZIL_TEST_CLI_ENTRY"] ?? join(import.meta.dir, "../../../bin/ezil.ts"), "clone", "https://github.ezil.work/acme/repo.git", "--directory", destination, "--json"], {
			detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ROOT: root, MODE: mode, TMPDIR: scratch,
				PATH: `${root}:${process.env["PATH"]}`, EZIL_HOME: home, EZIL_CLI_STORE: "file", EZIL_API_ORIGIN: origin },
		});
		let stdout = "", stderr = "";
		child.stdout!.on("data", chunk => stdout += chunk); child.stderr!.on("data", chunk => stderr += chunk);
		const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(resolve => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
		children.push(child); return { child, done };
	};
	return { root, destination, scratch, lock: join(root, ".checkout.ezil-clone-lock"), launch, grantStarted: () => grantStarted,
		async close() { for (const child of children) group(child, "SIGKILL"); server.stop(true); await Bun.sleep(50); rmSync(root, { recursive: true, force: true }); } };
}

for (const signal of ["SIGTERM", "SIGINT"] as const) it(`${signal} group cancellation waits for descendant exit, cleans owned state and permits retry`, async () => {
	const f = await fixture();
	try {
		const operation = f.launch(); await until(() => existsSync(join(f.root, "ready")));
		group(operation.child, signal);
		const result = await operation.done;
		expect(result.code).toBe(1); expect(JSON.parse(result.stdout).error.code).toBe("clone-failed"); expect(result.stderr).toBe("");
		expect(existsSync(join(f.root, "descendant-exited"))).toBe(true);
		expect(existsSync(f.lock)).toBe(false); expect(existsSync(f.destination)).toBe(false);
		expect(readdirSync(f.root).filter(name => name.startsWith(".ezil-clone-"))).toEqual([]); expect(readdirSync(f.scratch)).toEqual([]);
		const retry = await f.launch("success").done;
		expect(retry.code).toBe(0); expect(JSON.parse(retry.stdout).status).toBe("cloned");
	} finally { await f.close(); }
}, 10000);

it("SIGTERM aborts an in-flight grant and cleans the already-owned lock/temp", async () => {
	const f = await fixture(true);
	try {
		const operation = f.launch(); await until(f.grantStarted);
		expect(existsSync(f.lock)).toBe(true);
		group(operation.child, "SIGTERM"); const result = await operation.done;
		expect(result.code).toBe(1); expect(JSON.parse(result.stdout).error.message).toContain("cancelled");
		expect(existsSync(f.lock)).toBe(false); expect(readdirSync(f.root).filter(name => name.startsWith(".ezil-clone-"))).toEqual([]);
	} finally { await f.close(); }
}, 10000);

it("forced group kill leaves recovery-required state; a cancelled retry never removes unknown state", async () => {
	const f = await fixture();
	try {
		const operation = f.launch("force"); await until(() => existsSync(join(f.root, "ready")));
		group(operation.child, "SIGTERM"); await Bun.sleep(150);
		expect(operation.child.exitCode).toBeNull(); expect(existsSync(f.lock)).toBe(true);
		group(operation.child, "SIGKILL"); expect((await operation.done).signal).toBe("SIGKILL");
		const temp = readdirSync(f.root).find(name => name.startsWith(".ezil-clone-"))!;
		expect(readFileSync(join(f.root, temp, "checkout", "partial"), "utf8")).toBe("owned");
		const retry = f.launch(); await Bun.sleep(300); group(retry.child, "SIGTERM");
		expect((await retry.done).code).toBe(1);
		expect(existsSync(f.lock)).toBe(true); expect(existsSync(join(f.root, temp, "checkout", "partial"))).toBe(true);
		expect(existsSync(f.destination)).toBe(false);
		// OS reports recovery-required on its SIGKILL path; the killed CLI cannot emit JSON.
	} finally { await f.close(); }
}, 10000);

it("CLI escalates its stubborn Git child after 500ms, exits within OS grace and preserves uncertain state", async () => {
	const f = await fixture();
	try {
		const operation = f.launch("force"); await until(() => existsSync(join(f.root, "ready")));
		const started = Date.now(); group(operation.child, "SIGTERM");
		const result = await operation.done;
		expect(Date.now() - started).toBeLessThan(2000);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout).error.code).toBe("clone-failed");
		expect(JSON.parse(result.stdout).error.message).toContain("recovery required");
		expect(existsSync(f.lock)).toBe(true);
		const temp = readdirSync(f.root).find(name => name.startsWith(".ezil-clone-"))!;
		expect(readFileSync(join(f.root, temp, "checkout", "partial"), "utf8")).toBe("owned");
		expect(readdirSync(f.scratch).some(name => name.startsWith("ezil-grant-"))).toBe(true);
		// Fixture teardown, like the OS subreaper, terminates proven remaining descendants.
	} finally { await f.close(); }
}, 10000);
