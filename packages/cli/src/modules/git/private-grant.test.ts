import { test, expect } from 'bun:test';
import { openSync, closeSync } from 'node:fs';
import { validatePrivateGrant, readPrivateGrant } from './private-grant';
const url='https://github.ezil.work/acme/repo.git';
const packet=()=>({version:1,binding:{projectId:'11111111-1111-4111-8111-111111111111',repositoryId:'22222222-2222-4222-8222-222222222222',canonicalURL:url,ref:'refs/heads/main',bindingVersion:'a'.repeat(64)},identity:{issuer:'https://id.ezil.work/',subject:'auth0|a'},git:{username:'ezil',token:'egg_synthetic',expiresAt:new Date(Date.now()+60000).toISOString(),scope:'read'}});
test('private grant yields only short-lived read transport and issuer/subject, never an invented Works account ID',()=>{
 const p=packet();const v=validatePrivateGrant(p,url);expect(v.grant.password).toBe(p.git.token);expect(v.grant.scope).toBe('read');expect(v.identity).toEqual(p.identity);expect(v).not.toHaveProperty('accountId');
});
test('rejects substitutions, stale grants, write scope, extra fields and unsafe refs',()=>{
 for(const p of [{...packet(),extra:true},{...packet(),git:{...packet().git,scope:'write'}},{...packet(),git:{...packet().git,token:'egg_secret\npassword=evil'}},{...packet(),git:{...packet().git,expiresAt:new Date(0).toISOString()}},{...packet(),git:{...packet().git,expiresAt:new Date(Date.now()+600000).toISOString()}},{...packet(),binding:{...packet().binding,canonicalURL:'https://github.ezil.work/other/repo.git'}},{...packet(),binding:{...packet().binding,ref:'refs/heads/../evil'}}]) expect(()=>validatePrivateGrant(p,url)).toThrow();
});
test('refuses arbitrary descriptors and regular-file input',async()=>{
 await expect(readPrivateGrant(0)).rejects.toThrow();
 const fd=openSync('/dev/null','r');try {await expect(readPrivateGrant(fd)).rejects.toThrow();}finally{closeSync(fd);}
});
