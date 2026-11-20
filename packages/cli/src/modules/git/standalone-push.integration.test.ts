import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createProxy, connect, type Socket } from "node:net";
import { installStandaloneAccess } from "./standalone-access";

const URL = "https://github.ezil.work/default/example.git";
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));

/** Real Git, TLS, HTTP Basic auth, the installed helper, and git-http-backend; no push/credential mocks. */
test("OS author and renewable repository credentials support a real commit and authenticated push", async () => {
 const root = mkdtempSync(join(tmpdir(), "ezil-standalone-push-"));
 const checkout = join(root, "checkout"), repositories = join(root, "repos"), bare = join(repositories, "default", "example.git");
 const runtimeRoot = join(root, "runtime"), globalConfig = join(root, "global.gitconfig"), leaked = join(root, "helper-leak");
 const feature = "qa/repo-renewal";
 const sockets = new Set<Socket>();
 const children = new Set<ReturnType<typeof spawn>>();
 const env = {...cleanEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0"};
 const git = (folder: string, ...args: string[]) => {
  const result = spawnSync("git", ["-C", folder, ...args], {env, encoding:"utf8"});
  if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
 };
 const push = (branch = "main") => new Promise<{code:number; output:string}>((done, reject) => {
  const child = spawn("git", ["-C", checkout, "push", "origin", `HEAD:refs/heads/${branch}`], {env, stdio:["ignore", "pipe", "pipe"]});
  children.add(child);
  let output = "";
  child.stdout!.on("data", chunk => output += chunk.toString());
  child.stderr!.on("data", chunk => output += chunk.toString());
  child.once("error", reject);
  child.once("close", code => { children.delete(child); done({code:code ?? 1, output}); });
 });
 const grants = new Map<string, {scope:"read"|"write"; expires:number}>();
 const authorized: string[] = [];
 const deniedWrites: string[] = [];
 let https: ReturnType<typeof createHttpsServer> | undefined;
 const proxy = createProxy();
 try {
  mkdirSync(checkout); mkdirSync(join(repositories, "default"), {recursive:true});
  writeFileSync(globalConfig, "");
  git(root, "init", "--bare", "--initial-branch=main", bare);
  git(bare, "config", "http.receivepack", "true");
  git(checkout, "init", "--initial-branch=main");
  git(checkout, "remote", "add", "origin", URL);
  const cert = join(root, "cert.pem"), key = join(root, "key.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=github.ezil.work",
   "-addext", "subjectAltName=DNS:github.ezil.work", "-keyout", key, "-out", cert], {stdio:"ignore"});
  expect(generated.status).toBe(0);
  https = createHttpsServer({key:readFileSync(key), cert:readFileSync(cert)});
  https.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const backend = join(git(root, "--exec-path"), "git-http-backend");
  https.on("request", (request, response) => {
   const basic = request.headers.authorization;
   const credential = basic?.startsWith("Basic ") ? Buffer.from(basic.slice(6), "base64").toString() : "";
   const token = credential.startsWith("ezil:") ? credential.slice(5) : "";
   const grant = grants.get(token);
   if (!grant || grant.expires <= Date.now()) {
    response.writeHead(401, {"www-authenticate":"Basic realm=\"EZiL test repository\""}); response.end(); return;
   }
   const url = new globalThis.URL(request.url!, "https://github.ezil.work");
   if (grant.scope === "read" && (url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack"))) {
    deniedWrites.push(token);
    response.writeHead(403); response.end("write access required"); return;
   }
   authorized.push(token);
   const child = spawn(backend, [], {env:{...cleanEnv(), GIT_PROJECT_ROOT:repositories, GIT_HTTP_EXPORT_ALL:"1", REMOTE_USER:"fixture",
    REQUEST_METHOD:request.method!, PATH_INFO:url.pathname, QUERY_STRING:url.search.slice(1),
    CONTENT_TYPE:String(request.headers["content-type"] ?? ""), CONTENT_LENGTH:String(request.headers["content-length"] ?? "")},
    stdio:["pipe","pipe","pipe"]});
   children.add(child);
   const chunks: Buffer[] = [];
   child.stdout!.on("data", chunk => chunks.push(Buffer.from(chunk)));
   child.stderr!.resume();
   request.pipe(child.stdin!);
   child.once("error", () => { response.writeHead(500); response.end(); });
   child.once("close", () => {
    children.delete(child);
    const output = Buffer.concat(chunks), split = output.indexOf("\r\n\r\n");
    if (split < 0) { response.writeHead(500); response.end(); return; }
    let status = 200;
    const headers: Record<string,string> = {};
    for (const line of output.subarray(0, split).toString().split("\r\n")) {
     const colon = line.indexOf(":");
     if (colon < 1) continue;
     const name = line.slice(0,colon), value = line.slice(colon+1).trim();
     if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers[name] = value;
    }
    response.writeHead(status, headers); response.end(output.subarray(split+4));
   });
  });
  await new Promise<void>(done => https!.listen(0, "127.0.0.1", done));
  const tlsPort = (https.address() as {port:number}).port;
  proxy.on("connection", socket => {
   sockets.add(socket); socket.once("close", () => sockets.delete(socket));
   let pending = Buffer.alloc(0);
   const handshake = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const split = pending.indexOf("\r\n\r\n"); if (split < 0) return;
    socket.off("data", handshake);
    if (!pending.subarray(0,split).toString().startsWith("CONNECT github.ezil.work:443 HTTP/")) { socket.destroy(); return; }
    const tunnel = connect(tlsPort, "127.0.0.1", () => {
     socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
     if (pending.length > split+4) tunnel.write(pending.subarray(split+4));
     socket.pipe(tunnel); tunnel.pipe(socket);
    });
    sockets.add(tunnel); tunnel.once("close", () => sockets.delete(tunnel));
    tunnel.on("error", () => socket.destroy()); socket.on("error", () => tunnel.destroy());
   };
   socket.on("data", handshake);
  });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  git(checkout, "config", "http.proxy", `http://127.0.0.1:${(proxy.address() as {port:number}).port}`);
  git(checkout, "config", "http.sslCAInfo", cert);
  git(checkout, "config", "http.version", "HTTP/1.1");
  const entry = join(root,"helper-entry.ts"), bundle = join(root,"helper.mjs");
  writeFileSync(entry, `import {standaloneCredential} from ${JSON.stringify(resolve(import.meta.dir,"standalone-access.ts"))};\n`
   + `import {standaloneClone} from ${JSON.stringify(resolve(import.meta.dir,"standalone-clone.ts"))};\n`
   + `const runtimeRoot=${JSON.stringify(runtimeRoot)};\n`
   + `if(process.argv[2]==="refresh"){\n`
   + ` process.exitCode=await standaloneClone(${JSON.stringify(URL)},{directory:process.argv[3],grantFd:3,json:true,access:{runtimeRoot}},line=>console.log(line));\n`
   + `}else{\n`
   + ` let input="";for await(const chunk of process.stdin)input+=chunk;process.stdout.write(standaloneCredential(process.argv[3],input,{runtimeRoot}));\n`
   + `}\n`);
  const built = await Bun.build({entrypoints:[entry], target:"node", format:"esm"});
  expect(built.success).toBe(true);
  writeFileSync(bundle,Buffer.from(await built.outputs[0]!.arrayBuffer()));
  const node = spawnSync(process.env["EZIL_TEST_CLI_RUNTIME"] ?? "node", ["-p", "process.execPath"], {encoding:"utf8"}).stdout.trim();
  // Use the actual anonymous grant FD, under the same Node runtime as the credential helper.
  const supervisor = "const cp=require('node:child_process'),fs=require('node:fs');" +
   "const [node,entry,folder]=process.argv.slice(1);" +
   "const child=cp.spawn(node,[entry,'refresh',folder],{stdio:['ignore','pipe','pipe','pipe']});" +
   "child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);" +
   "child.on('error',()=>{process.exitCode=1});child.on('close',code=>{process.exitCode=code??1});" +
   "child.stdio[3].end(fs.readFileSync(0));";
  const refresh = (folder:string, accessGrant:{git:{token:string}}) => {
   const child = spawnSync(node,["-e",supervisor,node,bundle,folder],{
    env,input:JSON.stringify(accessGrant),encoding:"utf8",timeout:5000,
   });
   if (child.error) throw child.error;
   expect(child.stdout+child.stderr).not.toContain(accessGrant.git.token);
   return {code:child.status,value:JSON.parse(child.stdout)};
  };
  // These helpers would copy Git's store input, including its password, if a reset were missing.
  const malicious = `!f() { cat >> '${leaked}'; }; f`;
  git(root, "config", "--file", globalConfig, "--add", "credential.helper", malicious);
  git(root, "config", "--file", globalConfig, "--add", `credential.${URL}.helper`, malicious);
  git(checkout, "config", "--add", "credential.https://github.ezil.work/default.helper", malicious);
  git(checkout, "config", "--add", `credential.${URL}.helper`, malicious);
  git(checkout, "config", "--add", "credential.helper", malicious);
  const packet = (token:string, scope:"read"|"write" = "write") => {
   const expires = Date.now()+240_000; grants.set(token,{scope,expires});
   return {version:2, repository:{id:"fixtureartifact", canonicalURL:URL, ref:"refs/heads/main"},
    identity:{issuer:"https://id.ezil.work/",subject:"auth0|contact"},
    git:{username:"ezil",token,expiresAt:new Date(expires).toISOString(),scope}, gitAuthor:{name:"contact",email:"contact@ezil.work"}};
  };
  const options = {runtimeRoot,cliCommand:[node,bundle]};
  const firstToken = "integration-write-grant-000001";
  installStandaloneAccess(checkout, packet(firstToken), options);
  writeFileSync(join(checkout,"README.md"), "First commit from OS Code\n");
  git(checkout,"add","README.md"); git(checkout,"commit","-m","OS commit and push integration");
  const first = git(checkout,"rev-parse","HEAD");
  const initialPush = await push();
  expect(initialPush.code, initialPush.output).toBe(0);
  expect(git(bare,"rev-parse","refs/heads/main")).toBe(first);
  expect(git(bare,"show","-s","--format=%an <%ae>","main")).toBe("contact <contact@ezil.work>");
  expect(authorized).toContain(firstToken);
  expect(existsSync(leaked)).toBe(false);
  expect(readFileSync(join(checkout,".git","config"),"utf8")).not.toContain(firstToken);
  git(checkout,"switch","-c",feature);
  writeFileSync(join(checkout,"README.md"),"Second committed change\n");
  git(checkout,"add","README.md"); git(checkout,"commit","-m","Renewed OS push");
  const second = git(checkout,"rev-parse","HEAD");
  writeFileSync(join(checkout,"dirty.txt"),"Uncommitted work survives renewal\n");
  writeFileSync(join(checkout,"staged.txt"),"Staged work survives renewal\n");
  git(checkout,"add","staged.txt");
  writeFileSync(join(checkout,"README.md"),"Unstaged work survives renewal\n");
  const index = git(checkout,"write-tree");
  const dirty = git(checkout,"status","--porcelain");
  const readToken = "integration-read-grant-0000002";
  installStandaloneAccess(checkout,{...packet(readToken,"read"),refreshOnly:true},options);
  expect((await push()).code).not.toBe(0);
  expect(deniedWrites).toContain(readToken);
  expect(git(bare,"rev-parse","refs/heads/main")).toBe(first);
  const state = join(runtimeRoot,createHash("sha256").update(URL).digest("hex")+".json");
  const expired = JSON.parse(readFileSync(state,"utf8"));
  expired.git.expiresAt = new Date(Date.now()-1000).toISOString(); writeFileSync(state,JSON.stringify(expired));
  expect((await push()).code).not.toBe(0);
  expect(git(bare,"rev-parse","refs/heads/main")).toBe(first);
  const renewedToken = "integration-renewed-write-00003";
  const renewed = {...packet(renewedToken),refreshOnly:true};
  const absent = join(root,"absent");
  const absentResult = refresh(absent,renewed);
  expect(absentResult.code).toBe(2);
  expect(absentResult.value.error.code).toBe("repository-not-open");
  expect(existsSync(absent)).toBe(false);
  git(checkout,"remote","set-url","origin","https://github.ezil.work/default/other.git");
  const foreign = refresh(checkout,renewed);
  expect(foreign.code).toBe(1);
  expect(foreign.value.error.code).toBe("destination-conflict");
  git(checkout,"remote","set-url","origin",URL);
  expect(JSON.parse(readFileSync(state,"utf8")).git.expiresAt).toBe(expired.git.expiresAt);
  const renewedResult = refresh(checkout,renewed);
  expect(renewedResult).toMatchObject({code:0,value:{status:"reused",repository:{ref:"refs/heads/main"}}});
  expect(git(checkout,"symbolic-ref","HEAD")).toBe(`refs/heads/${feature}`);
  expect(git(checkout,"rev-parse","HEAD")).toBe(second);
  expect(git(checkout,"write-tree")).toBe(index);
  expect(git(checkout,"status","--porcelain")).toBe(dirty);
  expect(readFileSync(join(checkout,"dirty.txt"),"utf8")).toBe("Uncommitted work survives renewal\n");
  expect(readFileSync(join(checkout,"README.md"),"utf8")).toBe("Unstaged work survives renewal\n");
  const renewedPush = await push(feature);
  expect(renewedPush.code,renewedPush.output).toBe(0);
  expect(git(bare,"rev-parse",`refs/heads/${feature}`)).toBe(second);
  expect(git(bare,"rev-parse","refs/heads/main")).toBe(first);
  expect(git(bare,"show","-s","--format=%an <%ae>",feature)).toBe("contact <contact@ezil.work>");
  expect(authorized).toContain(renewedToken);
  expect(readFileSync(join(checkout,".git","config"),"utf8")).not.toContain(renewedToken);
  expect(existsSync(leaked)).toBe(false);
 } finally {
  for (const child of children) child.kill("SIGKILL");
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise<void>(done => https ? https.close(() => done()) : done()), new Promise<void>(done => proxy.close(() => done()))]);
  rmSync(root,{recursive:true,force:true});
 }
},30_000);
