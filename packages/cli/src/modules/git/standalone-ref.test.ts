import { test, expect } from 'bun:test';
import { spawn, execFileSync } from 'node:child_process';
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
   const packet={version:2,repository:{id:'cf-repo-fixture',canonicalURL:url,ref},identity:{issuer:'https://id.ezil.work/',subject:'auth0|fixture'},git:{username:'ezil',token:'v2_synthetic_private_token',expiresAt:new Date(Date.now()+60000).toISOString(),scope:'read'}};
   const child=spawn(process.env['EZIL_TEST_CLI_RUNTIME']??process.execPath,[process.env['EZIL_TEST_CLI_ENTRY']??join(import.meta.dir,'../../../bin/ezil.ts'),'clone',url,'--directory',dest,'--json','--grant-fd=3'],{env:{...process.env,PATH:bin+':'+process.env['PATH'],EZIL_HOME:join(root,'empty-auth'),EZIL_CLI_STORE:'file'},stdio:['ignore','pipe','pipe','pipe']});
   let stdout='',stderr='';child.stdout!.on('data',c=>stdout+=c);child.stderr!.on('data',c=>stderr+=c);(child.stdio[3] as import('node:stream').Writable).end(JSON.stringify(packet));
   const code=await new Promise(resolve=>child.on('close',resolve));expect(stdout+stderr).not.toContain(packet.git.token);return {code,value:JSON.parse(stdout)};
  }
  expect(run('--git-dir',remote,'symbolic-ref','HEAD')).toBe('refs/heads/main');
  const first=await open('refs/heads/topic');expect(first.value.status).toBe('cloned');expect(first.value.repository).toEqual({id:'cf-repo-fixture',canonicalURL:url,ref:'refs/heads/topic'});expect(first.value.identity).toEqual({issuer:'https://id.ezil.work/',subject:'auth0|fixture'});expect(first.value.folder).toBe(folder);expect(first.value).not.toHaveProperty('accountId');
  expect(run('-C',folder,'symbolic-ref','HEAD')).toBe('refs/heads/topic');expect(run('-C',folder,'rev-parse','HEAD')).toBe(expected);expect(readFileSync(join(folder,'fixture'),'utf8')).toBe('topic');
  run('-C',folder,'config','user.email','fixture@example.invalid');run('-C',folder,'config','user.name','Fixture');writeFileSync(join(folder,'local'),'local commit');run('-C',folder,'add','.');run('-C',folder,'commit','-qm','local');
  const localHead=run('-C',folder,'rev-parse','HEAD');writeFileSync(join(folder,'staged'),'staged local');run('-C',folder,'add','staged');writeFileSync(join(folder,'fixture'),'dirty topic');writeFileSync(join(folder,'untracked'),'preserve');const before=run('-C',folder,'status','--porcelain=v1');
  expect((await open('refs/heads/topic')).value.status).toBe('reused');
  const mismatch=await open('refs/heads/main');expect(mismatch.code).toBe(2);expect(mismatch.value.error.code).toBe('repository-ref-mismatch');
  expect(run('-C',folder,'rev-parse','HEAD')).toBe(localHead);expect(run('-C',folder,'symbolic-ref','HEAD')).toBe('refs/heads/topic');expect(readFileSync(join(folder,'fixture'),'utf8')).toBe('dirty topic');expect(readFileSync(join(folder,'untracked'),'utf8')).toBe('preserve');expect(run('-C',folder,'status','--porcelain=v1')).toBe(before);expect(readFileSync(join(folder,'.git','config'),'utf8')).not.toContain('v2_synthetic');
  const tagDest=join(root,'tag-checkout');expect((await open('refs/heads/tag-only',tagDest)).code).not.toBe(0);expect(existsSync(tagDest)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
},15000);
