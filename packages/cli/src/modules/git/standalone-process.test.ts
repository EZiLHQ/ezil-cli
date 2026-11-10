import { test, expect } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url="https://github.ezil.work/acme/repo.git";
const entry=process.env["EZIL_TEST_CLI_ENTRY"] ?? join(import.meta.dir,"../../../bin/ezil.ts");
const runtime=process.env["EZIL_TEST_CLI_RUNTIME"] ?? process.execPath;
const packet=()=>({version:2,repository:{id:"cf-fixture",canonicalURL:url,ref:"refs/heads/main"},identity:{issuer:"https://id.ezil.work/",subject:"auth0|fixture"},git:{username:"ezil",token:"v2_synthetic_private_token",expiresAt:new Date(Date.now()+60000).toISOString(),scope:"read"}});
async function until(check:()=>boolean) {const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)throw new Error("barrier timeout");await Bun.sleep(20);}}
function launch(root:string, input: "pipe" | number = "pipe", extraArgs:string[]=[], extraEnv:NodeJS.ProcessEnv={}) {
 // Keep Bun out of extra-FD adaptation. Node passes its actual inherited
 // stdin descriptor to CLI FD3; regular files stay files, and pipes stay pipes.
 // The supervisor shares the CLI's process group and waits for its result.
 const supervisor=`const cp=require('node:child_process');process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});const child=cp.spawn(process.argv[1],process.argv.slice(2),{stdio:['ignore','pipe','pipe',0]});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.on('error',()=>{process.exitCode=1});child.on('close',code=>{process.exitCode=code??1});`;
 const child=spawn('node',['-e',supervisor,runtime,entry,"clone",url,"--directory",join(root,"checkout"),"--json","--grant-fd=3",...extraArgs],{detached:true,env:{...process.env,EZIL_HOME:join(root,"no-auth"),EZIL_CLI_STORE:"file",...extraEnv},stdio:[input,"pipe","pipe"]});
 let stdout="",stderr="";child.stdout!.on("data",c=>stdout+=c);child.stderr!.on("data",c=>stderr+=c);
 const done=new Promise<{code:number|null;stdout:string;stderr:string}>(resolve=>child.on("close",code=>resolve({code,stdout,stderr})));
 return {child,done,packetWriter:child.stdin};
}
function killGroup(child:ChildProcess,signal:NodeJS.Signals) {try{process.kill(-child.pid!,signal);}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw e;}}

test("FD 3 must be anonymous pipe/socket; regular files, oversized packets, duplicate/secret args are refused",async()=>{
 const root=mkdtempSync(join(tmpdir(),"v2-fd-"));
 try {
  const file=join(root,"packet");writeFileSync(file,JSON.stringify(packet()));const fd=openSync(file,"r");
  try{const p=launch(root,fd);const r=await p.done;expect(r.code).toBe(2);expect(JSON.parse(r.stdout).error.code).toBe("repository-not-authorized");}finally{closeSync(fd);}
  for(const [raw,args] of [["x".repeat(17000),[]],[JSON.stringify(packet()),["--directory",join(root,"second")]],[JSON.stringify(packet()),["--token","v2_synthetic_private_token"]]] as const){
   const p=launch(root,"pipe",[...args]);p.packetWriter!.on("error",()=>{}).end(raw);const r=await p.done;expect(r.code).toBe(2);expect(r.stdout+r.stderr).not.toContain(packet().git.token);expect(existsSync(join(root,"checkout"))).toBe(false);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},10000);

test("SIGTERM cancels a stalled private pipe before creating destination state",async()=>{
 const root=mkdtempSync(join(tmpdir(),"v2-pipe-cancel-"));const p=launch(root);
 try{await Bun.sleep(150);const started=Date.now();killGroup(p.child,"SIGTERM");const r=await p.done;expect(Date.now()-started).toBeLessThan(1500);expect(r.code).toBe(1);expect(JSON.parse(r.stdout).error.message).toContain("cancelled");expect(readdirSync(root)).toEqual([]);}
 finally{killGroup(p.child,"SIGKILL");rmSync(root,{recursive:true,force:true});}
},10000);

for(const signal of ["SIGTERM","SIGINT"] as const)test(`${signal} cancels real Git waiting on HTTP and cleans owned state`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"v2-git-cancel-"));const realGit=Bun.which("git")!;let requested=false;
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){requested=true;return new Promise<Response>(()=>{});}});
 const probe=`http://127.0.0.1:${server.port}/repo.git`;
 writeFileSync(join(root,"git"),`#!/usr/bin/env node\nconst cp=require('node:child_process');const args=process.argv.slice(2);const index=args.indexOf(${JSON.stringify(url)});if(index>=0)args[index]=${JSON.stringify(probe)};const child=cp.spawn(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));child.on('close',(code)=>process.exit(code??1));\n`,{mode:0o700});
 const p=launch(root,"pipe",[],{PATH:root+":"+process.env["PATH"]});p.packetWriter!.end(JSON.stringify(packet()));
 try{
  await until(()=>requested);expect(existsSync(join(root,".checkout.ezil-clone-lock"))).toBe(true);
  killGroup(p.child,signal);const r=await p.done;expect(r.code).toBe(1);expect(JSON.parse(r.stdout).error.message).toContain("cancelled");expect(r.stdout+r.stderr).not.toContain(packet().git.token);
  expect(existsSync(join(root,"checkout"))).toBe(false);expect(readdirSync(root).filter(n=>n.startsWith(".ezil-clone-")||n.endsWith(".ezil-clone-lock"))).toEqual([]);
 }finally{killGroup(p.child,"SIGKILL");server.stop(true);rmSync(root,{recursive:true,force:true});}
},10000);


test("an unfinished private packet times out within the bounded descriptor deadline",()=>{
 const root=mkdtempSync(join(tmpdir(),"v2-pipe-timeout-"));
 // Bun 1.3.14 can throw ENOENT while adapting the extra writer FD in the
 // test host. A Node supervisor owns the anonymous writer and keeps it open;
 // only the CLI's unchanged five-second reader deadline can finish this test.
 const supervisor=`const cp=require('node:child_process');const child=cp.spawn(process.argv[1],[process.argv[2],'clone',${JSON.stringify(url)},'--directory',process.argv[3],'--json','--grant-fd=3'],{stdio:['ignore','pipe','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdio[3].on('error',()=>{});child.on('error',()=>{process.exitCode=1});child.on('close',code=>{child.stdio[3].destroy();process.exitCode=code??1});`;
 const started=Date.now();
 try{
  const child=spawnSync('node',['-e',supervisor,runtime,entry,join(root,"checkout")],{env:{...process.env,EZIL_HOME:join(root,"no-auth"),EZIL_CLI_STORE:"file"},encoding:'utf8',timeout:7000});
  if(child.error)throw child.error;
  const elapsed=Date.now()-started;expect(elapsed).toBeGreaterThanOrEqual(4500);expect(elapsed).toBeLessThan(6500);
  expect(child.status).toBe(2);expect(JSON.parse(child.stdout).error.code).toBe("repository-not-authorized");expect(child.stderr).toBe("");expect(readdirSync(root)).toEqual([]);
 }finally{rmSync(root,{recursive:true,force:true});}
},8000);

test("AbortController cancels a stalled inherited descriptor without a process-group signal",async()=>{
 const root=mkdtempSync(join(tmpdir(),"v2-library-cancel-")), runner=join(root,"runner.ts");
 writeFileSync(runner,`import {standaloneClone} from ${JSON.stringify(join(import.meta.dir,"standalone-clone.ts"))};const controller=new AbortController();setTimeout(()=>controller.abort(),150);process.exitCode=await standaloneClone(${JSON.stringify(url)},{directory:${JSON.stringify(join(root,"checkout"))},json:true,grantFd:3,signal:controller.signal},console.log);`);
 // Keep the idle writer alive in Node, avoiding Bun's extra-FD adapter and
 // preventing EOF from being mistaken for AbortController cancellation.
 const supervisor=`const cp=require('node:child_process');const child=cp.spawn(process.argv[1],[process.argv[2]],{stdio:['ignore','pipe','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.stdio[3].on('error',()=>{});child.on('error',()=>{process.exitCode=1});child.on('close',code=>{child.stdio[3].destroy();process.exitCode=code??1});`;
 const started=Date.now();
 try{
  const child=spawnSync('node',['-e',supervisor,process.execPath,runner],{encoding:'utf8',timeout:2000});
  if(child.error)throw child.error;
  expect(child.status).toBe(1);expect(Date.now()-started).toBeLessThan(1500);expect(JSON.parse(child.stdout).error.message).toContain("cancelled");expect(child.stderr).toBe("");expect(existsSync(join(root,"checkout"))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
},8000);
