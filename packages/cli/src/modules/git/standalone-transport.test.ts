import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real Git credential protocol preserves native Artifacts passwords for only the pinned repository; argv/env/config contain no token",async()=>{
 const root=mkdtempSync(join(tmpdir(),"v2-credential-"));const realGit=Bun.which("git")!, marker=join(root,"checked"), runner=join(root,"runner.ts"), destination=join(root,"checkout");
 const token="art_v1_"+"b".repeat(40)+"?expires="+Math.floor(Date.now()/1000+60);
 writeFileSync(join(root,"git"),`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2),index=args.indexOf('clone'),flags=args.slice(0,index),token=${JSON.stringify(token)};
if(args.join(' ').includes(token)||Object.values(process.env).some(value=>value.includes(token)))process.exit(41);
if(process.env.GIT_CONFIG_VALUE_0||process.env.GIT_TRACE||process.env.GIT_DIR||process.env.GIT_TEMPLATE_DIR)process.exit(42);
const fill=(host,path)=>cp.spawnSync(${JSON.stringify(realGit)},[...flags,'credential','fill'],{input:'protocol=https\\nhost='+host+'\\npath='+path+'\\n\\n',encoding:'utf8'});
const good=fill('github.ezil.work','acme/repo.git');if(good.status!==0||!good.stdout.includes('password='+token))process.exit(43);
for(const [host,path] of [['github.ezil.work','other/repo.git'],['evil.invalid','acme/repo.git']]){const bad=fill(host,path);if(bad.status===0||bad.stdout.includes(token))process.exit(44);}
const target=args.at(-1);if(cp.spawnSync(${JSON.stringify(realGit)},['init','--template=',target],{stdio:'ignore'}).status!==0)process.exit(45);
fs.writeFileSync(${JSON.stringify(marker)},'passed');
`);chmodSync(join(root,"git"),0o700);
 writeFileSync(runner,`import {cloneWithGrant} from ${JSON.stringify(join(import.meta.dir,"clone-transport.ts"))};process.exitCode=await cloneWithGrant('https://github.ezil.work/acme/repo.git',${JSON.stringify(destination)},{username:'ezil',password:${JSON.stringify(token)},password_expiry_utc:Math.floor(Date.now()/1000)+60,scope:'write'});`);
 try{
  const child=Bun.spawn([process.execPath,runner],{env:{...process.env,PATH:root+":"+process.env["PATH"],GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"http.extraHeader",GIT_CONFIG_VALUE_0:"X-Injection: synthetic",GIT_TRACE:"1",GIT_DIR:join(root,"wrong"),GIT_TEMPLATE_DIR:join(root,"template")},stdout:"pipe",stderr:"pipe"});
  expect(await child.exited).toBe(0);expect(readFileSync(marker,"utf8")).toBe("passed");expect(readFileSync(join(destination,".git","config"),"utf8")).not.toContain(token);expect(await new Response(child.stdout).text()+await new Response(child.stderr).text()).not.toContain(token);
 }finally{rmSync(root,{recursive:true,force:true});}
},10000);
