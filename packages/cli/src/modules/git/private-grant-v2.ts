import { closeSync, fstatSync, readlinkSync } from "node:fs";
import { spawn } from "node:child_process";

export interface StandaloneRepository { id: string; canonicalURL: string; ref: string }
export interface StandaloneIdentity { issuer: "https://id.ezil.work/"; subject: string }
export interface StandaloneGrant { username: "ezil"; password: string; password_expiry_utc: number; scope: "read" | "write" }
export const PRIVATE_GRANT_MAX_BYTES = 16384;
export const PRIVATE_GRANT_MAX_LIFETIME_MS = 300000;

/** Check the raw canonical spelling before URL parsing can normalize escapes or traversal. */
export function canonicalRepository(value: string): boolean {
 const match = /^https:\/\/github\.ezil\.work\/([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9._-]{0,99})\.git$/.exec(value);
 return !!match && match[0] === value && !match[2]!.includes("..") && !match[2]!.endsWith(".git");
}
export function branchRef(value: string): boolean {
 return value.length <= 255 && !/\s/.test(value) && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value)
  && !value.includes("..") && !value.includes("//") && !value.endsWith("/")
  && !value.split("/").some(part => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"));
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
 return !!value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function opaqueId(value: unknown): value is string {
 return typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\s\x00-\x1f\x7f]/u.test(value);
}
/** Strict v2 only. Cloudflare repository ID and EZiL issuer/subject are independent of Works. */
export function validatePrivateGrant(value: unknown, canonicalURL: string, now = Date.now()): {repository: StandaloneRepository; identity: StandaloneIdentity; grant: StandaloneGrant} {
 if (!exact(value, ["version", "repository", "identity", "git"]) || value["version"] !== 2) throw new Error("invalid private grant");
 const repository = value["repository"], identity = value["identity"], git = value["git"];
 if (!exact(repository, ["id", "canonicalURL", "ref"]) || !opaqueId(repository["id"])
  || repository["canonicalURL"] !== canonicalURL || !canonicalRepository(canonicalURL)
  || typeof repository["ref"] !== "string" || !branchRef(repository["ref"])
  || !exact(identity, ["issuer", "subject"]) || identity["issuer"] !== "https://id.ezil.work/" || !opaqueId(identity["subject"])
  || !exact(git, ["username", "token", "expiresAt", "scope"]) || git["username"] !== "ezil"
  || (git["scope"] !== "read" && git["scope"] !== "write")
  || typeof git["token"] !== "string" || /\s/.test(git["token"]) || !/^[A-Za-z0-9._~+\/=\-]{16,8192}$/.test(git["token"])
  || typeof git["expiresAt"] !== "string" || !git["expiresAt"].endsWith("Z") || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(git["expiresAt"])) throw new Error("invalid private grant");
 const expires = Date.parse(git["expiresAt"]);
 if (!Number.isFinite(expires) || expires <= now || expires > now + PRIVATE_GRANT_MAX_LIFETIME_MS) throw new Error("invalid private grant");
 return {repository: {id: repository["id"], canonicalURL, ref: repository["ref"]},
  identity: {issuer:"https://id.ezil.work/", subject:identity["subject"]},
  grant:{username:"ezil", password:git["token"], password_expiry_utc: Math.floor(expires / 1000), scope:git["scope"]}};
}

/** Read only inherited anonymous descriptor 3, bounded in size and time. Never read a path.
 * A tiny Node reader owns the descriptor: Bun's fs reader cannot cancel an in-flight
 * pipe read and its net.Socket does not adopt inherited descriptors. The bytes travel
 * only through anonymous inherited pipes; the helper's arguments contain no packet.
 */
export async function readPrivateGrant(fd: number, signal?: AbortSignal): Promise<unknown> {
 if (fd !== 3) throw new Error("invalid private descriptor");
 const stat = fstatSync(fd);
 if (!stat.isFIFO() && !stat.isSocket()) throw new Error("private input must be a pipe");
 if (process.platform === "linux" && !/^(?:pipe|socket):\[\d+\]$/.test(readlinkSync(`/proc/self/fd/${fd}`))) throw new Error("private input must be anonymous");
 signal?.throwIfAborted();
 const reader = "const s=new(require('node:net').Socket)({fd:3,readable:true,writable:false});s.on('error',()=>process.exitCode=1);s.pipe(process.stdout);";
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
 const child = spawn(process.versions.bun ? "node" : process.execPath, ["-e", reader], {env, stdio:["ignore","pipe","ignore",fd]});
 closeSync(fd);
 return new Promise<unknown>((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0, failure: Error | undefined;
  const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
  const abort = () => stop(new Error("private input cancelled"));
  const timer = setTimeout(() => stop(new Error("private input timed out")), 5000);
  signal?.addEventListener("abort", abort, {once:true});
  if (signal?.aborted) abort();
  child.stdout!.on("data", (chunk: Buffer) => {
   size += chunk.length;
   if (size > PRIVATE_GRANT_MAX_BYTES) stop(new Error("private input too large"));
   else chunks.push(chunk);
  });
  child.once("error", () => { failure = new Error("private input unavailable"); });
  child.once("close", code => {
   clearTimeout(timer); signal?.removeEventListener("abort", abort);
   if (failure || code !== 0) { reject(failure ?? new Error("invalid private input")); return; }
   try { resolve(JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks)))); }
   catch { reject(new Error("invalid private input")); }
  });
 });
}
