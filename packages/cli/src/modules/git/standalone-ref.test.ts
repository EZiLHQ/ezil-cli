import { test, expect } from 'bun:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const url='https://github.ezil.work/acme/repo.git';
const git=execFileSync('which',['git'],{encoding:'utf8'}).trim();
test('standalone v2 selects full branch despite different remote HEAD/same-name tag; mismatched reuse preserves commits and dirty files',async()=>{
 const root=mkdtempSync(join(tmpdir(),'private-ref-'));const source=join(root,'source'), remote=join(root,'remote.git'), bin=join(root,'bin'), folder=join(root,'checkout');mkdirSync(bin);
 const run=(...args:string[])=>execFileSync(git,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{
  run('init','-q','-b','main',source);run('-C',source,'config','user.email','fixture@example.invalid');run('-C',source,'config','user.name','Fixture');
  writeFileSync(join(source,'fixture'),'main');run('-C',source,'add','.');run('-C',source,'commit','-qm','main');
  run('-C',source,'tag','topic');run('-C',source,'tag','tag-only');run('-C',source,'checkout','-qb','topic');
  writeFileSync(join(source,'fixture'),'topic');run('-C',source,'commit','-qam','topic');const expected=run('-C',source,'rev-parse','HEAD');
  run('-C',source,'checkout','-q','main');run('clone','--bare','--',source,remote);
  // Substitute only the test transport URL. Preserve all real production Git argv,
  // including branch selection; the remote has distinct branch/tag objects.
  writeFileSync(join(bin,'git'),`#!/usr/bin/env node\nconst cp=require('node:child_process');const args=process.argv.slice(2);const clone=args.includes('clone');if(clone)args[args.indexOf(${JSON.stringify(url)})]=${JSON.stringify(remote)};let r=cp.spawnSync(${JSON.stringify(git)},args,{stdio:'inherit'});if(clone&&r.status===0)r=cp.spawnSync(${JSON.stringify(git)},['-C',args.at(-1),'remote','set-url','origin',${JSON.stringify(url)}],{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o700});
  async function open(ref:string,dest=folder){
   const packet={version:2,repository:{id:'cf-repo-fixture',canonicalURL:url,ref},identity:{issuer:'https://id.ezil.work/',subject:'auth0|fixture'},git:{username:'ezil',token:'art_v1_'+'a'.repeat(40)+'?expires='+Math.floor(Date.now()/1000+60),expiresAt:new Date(Date.now()+60000).toISOString(),scope:'read'}};
   // Isolate child stdio collection from Bun 1.3.14's asynchronous pipe EOF
   // bookkeeping after the cancellation suites. The supervisor passes the
   // packet only through anonymous stdin and the CLI's inherited descriptor 3.
   const supervisor = `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.argv[1],[process.argv[2],'clone',process.argv[3],'--directory',process.argv[4],'--json','--grant-fd=3'],{stdio:['ignore','pipe','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.on('error',()=>{process.exitCode=1});child.on('close',code=>{process.exitCode=code??1});child.stdio[3].end(fs.readFileSync(0));`;
   const child=spawnSync('node',['-e',supervisor,process.env['EZIL_TEST_CLI_RUNTIME']??process.execPath,process.env['EZIL_TEST_CLI_ENTRY']??join(import.meta.dir,'../../../bin/ezil.ts'),url,dest],{env:{...process.env,PATH:bin+':'+process.env['PATH'],EZIL_HOME:join(root,'empty-auth'),EZIL_CLI_STORE:'file'},input:JSON.stringify(packet),encoding:'utf8',timeout:5000});
   if(child.error) throw child.error;
   expect(child.stdout+child.stderr).not.toContain(packet.git.token);return {code:child.status,value:JSON.parse(child.stdout)};
  }
  expect(run('--git-dir',remote,'symbolic-ref','HEAD')).toBe('refs/heads/main');
  const first=await open('refs/heads/topic');expect(first.value.status).toBe('cloned');expect(first.value.repository).toEqual({id:'cf-repo-fixture',canonicalURL:url,ref:'refs/heads/topic'});expect(first.value.identity).toEqual({issuer:'https://id.ezil.work/',subject:'auth0|fixture'});expect(first.value.folder).toBe(folder);expect(first.value).not.toHaveProperty('accountId');
  expect(run('-C',folder,'symbolic-ref','HEAD')).toBe('refs/heads/topic');expect(run('-C',folder,'rev-parse','HEAD')).toBe(expected);expect(readFileSync(join(folder,'fixture'),'utf8')).toBe('topic');
  run('-C',folder,'config','user.email','fixture@example.invalid');run('-C',folder,'config','user.name','Fixture');writeFileSync(join(folder,'local'),'local commit');run('-C',folder,'add','.');run('-C',folder,'commit','-qm','local');
  const localHead=run('-C',folder,'rev-parse','HEAD');writeFileSync(join(folder,'staged'),'staged local');run('-C',folder,'add','staged');writeFileSync(join(folder,'fixture'),'dirty topic');writeFileSync(join(folder,'untracked'),'preserve');const before=run('-C',folder,'status','--porcelain=v1');
  expect((await open('refs/heads/topic')).value.status).toBe('reused');
  const mismatch=await open('refs/heads/main');expect(mismatch.code).toBe(2);expect(mismatch.value.error.code).toBe('repository-ref-mismatch');
  expect(run('-C',folder,'rev-parse','HEAD')).toBe(localHead);expect(run('-C',folder,'symbolic-ref','HEAD')).toBe('refs/heads/topic');expect(readFileSync(join(folder,'fixture'),'utf8')).toBe('dirty topic');expect(readFileSync(join(folder,'untracked'),'utf8')).toBe('preserve');expect(run('-C',folder,'status','--porcelain=v1')).toBe(before);expect(readFileSync(join(folder,'.git','config'),'utf8')).not.toContain('art_v1_');
  const tagDest=join(root,'tag-checkout');expect((await open('refs/heads/tag-only',tagDest)).code).not.toBe(0);expect(existsSync(tagDest)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
},15000);
