import { expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function until(check: () => boolean) {
	const end = Date.now() + 7000;
	while (!check()) { if (Date.now() > end) throw new Error("barrier timed out"); await Bun.sleep(20); }
}

it("two real CLI processes contend while Git is blocked; only one clone uses the pinned socket credential", async () => {
	const root = mkdtempSync(join(tmpdir(), "ezil-process-"));
	const folder = join(root, "checkout"), events = join(root, "events"), release = join(root, "release");
	const realGit = Bun.which("git")!;
	const runner = join(root, "runner.ts");
	writeFileSync(runner, `
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { clone } from ${JSON.stringify(join(import.meta.dir, "clone.ts"))};
const url='https://github.ezil.work/acme/repo.git';
const id=process.argv[2];
const session={accessToken:'eca_a',accessExpiresAt:'2100-01-01T00:00:00Z'};
const io={env:process.env,now:Date.now,sleep:ms=>Bun.sleep(ms),out:console.log,err:console.error,openBrowser:()=>{},
store:{kind:'memory',read:()=>session,write:()=>{},remove:()=>{}},
run:cmd=>{const r=spawnSync(cmd[0],cmd.slice(1),{encoding:'utf8'});return {code:r.status??1,stdout:r.stdout}},
fetch:async(input,init)=>{
if(String(input).endsWith('/cli/whoami')){
appendFileSync(process.env.EVENTS,id+':whoami\\n');
return Response.json({account:{id:'a',email:'test@example.invalid',role:'builder'},session:{id:'12345678-1234-4234-8234-123456789abc',device:'test',os:'linux',expiresAt:'2100-01-01T00:00:00.000Z'},repositories:[{project:'p',projectId:'p',repository:'r',access:'read',taskPublicId:null,cloneUrl:url}]});}
appendFileSync(process.env.EVENTS,id+':grant\\n');
return Response.json({username:'ezil',password:'egg_'+'a'.repeat(64),password_expiry_utc:4102444800,scope:'read'});
}};
process.exitCode=await clone(io,url,{directory:process.env.DESTINATION,json:true});
`);
	const shim = join(root, "git");
	writeFileSync(shim, `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2), index=args.indexOf('clone');
if(index<0){const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);}
if(process.env.GIT_CONFIG_COUNT!=='0' || process.env.GIT_CONFIG_VALUE_0)process.exit(45);
// Invoke real Git's credential protocol and the actual ephemeral socket helper.
const credential=cp.spawnSync(${JSON.stringify(realGit)},[...args.slice(0,index),'credential','fill'],{input:'protocol=https\\nhost=github.ezil.work\\npath=acme/repo.git\\n\\n',encoding:'utf8'});
if(credential.status!==0 || !credential.stdout.includes('password=egg_'+'a'.repeat(64))) process.exit(42);
// Wrong paths must not receive the operation's credential.
const denied=cp.spawnSync(${JSON.stringify(realGit)},[...args.slice(0,index),'credential','fill'],{input:'protocol=https\\nhost=github.ezil.work\\npath=other/repo.git\\n\\n',encoding:'utf8'});
if(denied.status===0 || denied.stdout.includes('egg_')) process.exit(43);
fs.appendFileSync(process.env.EVENTS,process.env.WORKER+':clone\\n');
while(!fs.existsSync(process.env.RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
const target=args.at(-1);
for(const a of [['init',target],['-C',target,'remote','add','origin','https://github.ezil.work/acme/repo.git']]){if(cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'ignore'}).status!==0)process.exit(44);}
fs.writeFileSync(target+'/owner',process.env.WORKER);
`);
	chmodSync(shim, 0o700);
	const children: ReturnType<typeof Bun.spawn>[] = [];
	const launch = (id: string) => {
		const child = Bun.spawn([process.execPath, runner, id], { stdout: "pipe", stderr: "pipe", env: { ...process.env,
			PATH: `${root}:${process.env["PATH"]}`, WORKER: id, EVENTS: events, RELEASE: release, DESTINATION: folder,
			GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "X-Test: inherited-config", EZIL_API_ORIGIN: "https://api.test",
		} }); children.push(child); return child;
	};
	const log = () => existsSync(events) ? readFileSync(events, "utf8") : "";
	try {
		const first = launch("first");
		await until(() => log().includes("first:clone"));
		const second = launch("second");
		await until(() => log().includes("second:whoami"));
		await Bun.sleep(350);
		// This assertion fails with the lock removed: both Git children reach the barrier.
		expect(log().match(/:clone/g)?.length).toBe(1);
		expect(log()).not.toContain("second:grant");
		writeFileSync(release, "go");
		expect(await first.exited).toBe(0); expect(await second.exited).toBe(0);
		const a = await new Response(first.stdout).text(), b = await new Response(second.stdout).text();
		expect(JSON.parse(a).status).toBe("cloned"); expect(JSON.parse(b).status).toBe("reused");
		expect(readFileSync(join(folder, "owner"), "utf8")).toBe("first");
		expect(log().match(/:clone/g)?.length).toBe(1); expect(log()).toContain("second:grant");
		expect(a + b + await new Response(first.stderr).text() + await new Response(second.stderr).text()).not.toContain("egg_");
	} finally {
		writeFileSync(release, "go");
		for (const child of children) child.kill();
		await Promise.all(children.map(child => child.exited));
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);
