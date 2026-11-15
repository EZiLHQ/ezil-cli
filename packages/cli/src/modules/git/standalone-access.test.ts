import {test,expect} from "bun:test";
import {execFileSync} from "node:child_process";
import {mkdtempSync,readFileSync,readdirSync,rmSync,chmodSync,symlinkSync,writeFileSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {installStandaloneAccess,standaloneCredential} from "./standalone-access";
import {validateStandaloneInput} from "./private-grant-v2";
const url="https://github.ezil.work/default/example.git",now=Date.now();
const packet=()=>({version:2,repository:{id:"abc123fixture",canonicalURL:url,ref:"refs/heads/main"},identity:{issuer:"https://id.ezil.work/",subject:"auth0|contact"},git:{username:"ezil",token:"art_v1_synthetic_secret?expires=123456",expiresAt:new Date(now+120000).toISOString(),scope:"write"},gitAuthor:{name:"Contact",email:"contact@ezil.work"}});
function fixture(){const root=mkdtempSync(join(tmpdir(),"ezil-access-")),folder=join(root,"checkout"),runtimeRoot=join(root,"runtime");const git=(...args:string[])=>execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();git("init","-q","-b","main",folder);git("-C",folder,"remote","add","origin",url);return {root,folder,runtimeRoot,git,options:{runtimeRoot,cliCommand:[process.execPath,join(root,"helper.js")],now}};}
test("OS metadata stays separate from exact gateway packet and refresh is true-only",()=>{
 const p=packet();expect(validateStandaloneInput({...p,refreshOnly:true},url,now).refreshOnly).toBe(true);expect(validateStandaloneInput({...p,gitAccess:true},url,now).gitAccess).toBe(true);
 for(const bad of [{...p,gitAccess:false},{...p,refreshOnly:false},{...p,extra:true},{...p,gitAuthor:{name:" bad",email:"x@y"}},{...p,gitAuthor:{name:"x",email:"x\ny@y"}},{...p,gitAuthor:{name:"x".repeat(129),email:"x@y"}}])expect(()=>validateStandaloneInput(bad,url,now)).toThrow();
 expect(validateStandaloneInput({...p,gitAuthor:{name:"名",email:"名@example.test"}},url,now).gitAuthor?.name).toBe("名");
});
test("repo-local author and ephemeral access survive dirty reopen; explicit author is preserved",()=>{
 const f=fixture();try{
  installStandaloneAccess(f.folder,packet(),f.options);
  expect(f.git("-C",f.folder,"config","--local","user.email")).toBe("contact@ezil.work");expect(f.git("-C",f.folder,"config","--local","user.name")).toBe("Contact");
  writeFileSync(join(f.folder,"dirty"),"preserve");f.git("-C",f.folder,"config","user.name","Custom");
  installStandaloneAccess(f.folder,{...packet(),refreshOnly:true},f.options);expect(f.git("-C",f.folder,"config","user.name")).toBe("Custom");expect(readFileSync(join(f.folder,"dirty"),"utf8")).toBe("preserve");
  const configBefore = readFileSync(join(f.folder,".git/config"),"utf8");installStandaloneAccess(f.folder,{...packet(),refreshOnly:true},f.options);
  expect(readFileSync(join(f.folder,".git/config"),"utf8")).toBe(configBefore);
  expect(readFileSync(join(f.folder,".git/config"),"utf8")).not.toContain(packet().git.token);
  expect(readdirSync(f.runtimeRoot)).toHaveLength(1);
  const request="protocol=https\nhost=github.ezil.work\npath=default/example.git\n\n";
  expect(standaloneCredential("get",request,f.options)).toContain(`password=${packet().git.token}\n`);
  for(const bad of [request.replace("https","http"),request.replace("github.ezil.work","github.ezil.work:443"),request.replace("example.git","other.git"),request.replace("example.git","example.git?x=1"),request+"host=evil\n",request+"username=someone\n"])
   expect(standaloneCredential("get",bad,f.options)).toBe("quit=true\n\n");
  expect(standaloneCredential("get",request,{...f.options,now:now+100000})).toBe("quit=true\n\n");
  expect(standaloneCredential("store",request+`password=${packet().git.token}`,f.options)).toBe("");
  expect(()=>installStandaloneAccess(f.folder,{...packet(),identity:{issuer:"https://id.ezil.work/",subject:"auth0|other"}},f.options)).toThrow("identity mismatch");
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("runtime symlink, permissions and grant-file substitutions fail closed",()=>{
 const f=fixture();try{
  const outside=join(f.root,"outside");mkdirSync(outside,{mode:0o700});symlinkSync(outside,f.runtimeRoot);expect(()=>installStandaloneAccess(f.folder,packet(),f.options)).toThrow();rmSync(f.runtimeRoot);
  installStandaloneAccess(f.folder,packet(),f.options);const file=join(f.runtimeRoot,readdirSync(f.runtimeRoot)[0]!);chmodSync(file,0o644);
  const request="protocol=https\nhost=github.ezil.work\npath=default/example.git\n\n";expect(standaloneCredential("get",request,f.options)).toBe("quit=true\n\n");expect(()=>installStandaloneAccess(f.folder,packet(),f.options)).toThrow();
  rmSync(file);symlinkSync(join(outside,"grant.json"),file);expect(()=>installStandaloneAccess(f.folder,packet(),f.options)).toThrow();
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("local included config cannot append a credential store helper after the reset",()=>{
 const f=fixture();try{
  const included=join(f.root,"included.conf");writeFileSync(included,`[credential "${url}"]\nhelper = !cat\n`);
  f.git("-C",f.folder,"config",`credential.${url}.useHttpPath`,"true");f.git("-C",f.folder,"config","include.path",included);
  expect(()=>installStandaloneAccess(f.folder,packet(),f.options)).toThrow("included repository config");
  expect(()=>readdirSync(f.runtimeRoot)).toThrow();
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
