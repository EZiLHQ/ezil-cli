/** Short-lived OS Git access, independent of the legacy CLI login store. */
import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalRepository, validatePrivateGrant, validateStandaloneInput } from "./private-grant-v2";

const ROOT = "/run/ezil/git/standalone";
export interface StandaloneAccessOptions { runtimeRoot?: string; cliCommand?: string[]; now?: number }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fileFor = (root: string, url: string) => join(root, createHash("sha256").update(url).digest("hex") + ".json");
function uid(): number { if (!process.geteuid) throw new Error("OS Git access requires Linux"); return process.geteuid(); }

function directory(path: string, create: boolean): void {
 if (!isAbsolute(path) || path.includes("\0") || path.split("/").some(part => part === "." || part === "..")) throw new Error("unsafe runtime path");
 let current = parse(path).root;
 for (const part of path.slice(current.length).split("/").filter(Boolean)) {
  current = join(current, part);
  try { if (create) mkdirSync(current, {mode:0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe runtime directory");
  // Public system ancestors are allowed; every private /run/ezil component is owner-only.
  if (current === path || current.startsWith("/run/ezil")) {
   if (stat.uid !== uid() || (stat.mode & 0o777) !== 0o700) throw new Error("unsafe runtime directory");
  }
 }
}
function readState(path: string): unknown {
 const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== uid() || (stat.mode & 0o777) !== 0o600 || stat.size > 16_384) throw new Error("unsafe grant file");
  return JSON.parse(readFileSync(fd, "utf8"));
 } finally { closeSync(fd); }
}
function git(folder: string, args: string[]): {code: number; stdout: string} {
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
 const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", folder, ...args],
  {env:{...env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_COUNT:"0"},encoding:"utf8",stdio:["ignore","pipe","ignore"]});
 return {code:result.status ?? 1, stdout:result.stdout ?? ""};
}
function config(folder: string, args: string[]): void {
 if (git(folder, ["config", "--local", ...args]).code !== 0) throw new Error("could not configure repository Git access");
}

/** Install after a successful open; a renewal never fetches or changes checkout content. */
export function installStandaloneAccess(folder: string, raw: unknown, options: StandaloneAccessOptions = {}): void {
 const input = raw as {repository?: {canonicalURL?: string}};
 const url = input?.repository?.canonicalURL;
 if (!url) throw new Error("invalid repository");
 const approved = validateStandaloneInput(raw, url, options.now);
 const gitDir = join(folder, ".git");
 for (const path of [folder, gitDir]) {
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe checkout");
 }
 const cfg = lstatSync(join(gitDir, "config"));
 if (!cfg.isFile() || cfg.isSymbolicLink()) throw new Error("unsafe Git config");
 // An include can append another helper after the exact-path reset. A checkout
 // placed by clone has no includes; preserve and refuse manually included config.
 if (git(folder, ["config", "--local", "--name-only", "--get-regexp", "^(include\\.path|includeif\\..*\\.path)$"]).code === 0)
  throw new Error("included repository config requires manual Git access setup");
 if (git(folder, ["config", "--local", "--get-all", "remote.origin.url"]).stdout.trim() !== url
  || git(folder, ["rev-parse", "--show-toplevel"]).stdout.trim() !== folder) throw new Error("repository binding mismatch");
 const root = options.runtimeRoot ?? ROOT;
 directory(root, true);
 const target = fileFor(root, url);
 try {
  // Check the old identity even when its grant expired; renewal cannot change the owner.
  const old = readState(target) as Record<string, unknown>;
  const person = old["identity"] as {issuer?: unknown; subject?: unknown};
  const repo = old["repository"] as {id?: unknown; canonicalURL?: unknown};
  if (person?.issuer !== approved.identity.issuer || person?.subject !== approved.identity.subject
   || repo?.id !== approved.repository.id || repo?.canonicalURL !== url) throw new Error("repository identity mismatch");
 } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
 const cli = options.cliCommand ?? [process.execPath, process.argv[1]!];
 if (cli.length !== 2 || !cli.every(part => isAbsolute(part) && !/[\x00-\x1f\x7f]/.test(part))) throw new Error("invalid installed CLI path");
 // A fixed executable path, never a token or per-user credential in .git/config.
 const helper = `!${cli.map(quote).join(" ")} standalone-git-credential`;
 if (approved.gitAuthor) {
  for (const [key, value] of [["user.name", approved.gitAuthor.name], ["user.email", approved.gitAuthor.email]] as const) {
   const existing = git(folder, ["config", "--local", "--get-all", key]);
   if (existing.code !== 0 || !existing.stdout.trim()) config(folder, ["--replace-all", key, value]);
  }
 }
 // Git invokes every matching helper for store after successful HTTP auth. Remove
 // old matching local helpers and append an exact-path reset so no prior helper
 // (including one inherited from global config) receives this ephemeral password.
 const helpers = git(folder, ["config", "--local", "--name-only", "--get-regexp", "^credential\\..*\\.helper$"]);
 for (const key of new Set(helpers.stdout.split("\n").filter(Boolean))) {
  const section = key.slice("credential.".length, -".helper".length);
  try {
   const old = new URL(section);
   if (old.hostname === "github.ezil.work") config(folder, ["--unset-all", key]);
  } catch { /* Other credential sections do not match our canonical HTTPS URL. */ }
 }
 // git config --add inserts into an existing section, which may precede a
 // generic helper later in the file. Append the final reset physically at EOF.
 const configPath = join(gitDir, "config"), lockPath = configPath + ".lock";
 const lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, cfg.mode & 0o777);
 try {
  const escaped = helper.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  let contents = readFileSync(configPath, "utf8");
  const begin = "\n# EZiL standalone Git access: begin\n", end = "# EZiL standalone Git access: end\n";
  const managed = contents.lastIndexOf(begin);
  if (managed >= 0 && contents.endsWith(end)) {
   const block = contents.slice(managed + begin.length, -end.length);
   const lines = block.split("\n").filter(Boolean);
   if (lines[0] === `[credential "${url}"]` && lines.slice(1).every(line => /^\s+(?:helper|useHttpPath|username)\s*=/.test(line))) contents = contents.slice(0, managed);
  }
  writeFileSync(lock, contents);
  writeFileSync(lock, `${begin}[credential "${url}"]\n\thelper =\n\thelper = "${escaped}"\n\tuseHttpPath = true\n\tusername = ezil\n${end}`);
  fsyncSync(lock); closeSync(lock); renameSync(lockPath, configPath);
 } catch (error) { try { closeSync(lock); } catch { /* already closed */ } throw error; }
 finally { try { unlinkSync(lockPath); } catch { /* renamed */ } }
 const temporary = join(root, ".grant-" + randomBytes(12).toString("hex"));
 const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
 try { writeFileSync(fd, JSON.stringify(approved.packet)); }
 finally { closeSync(fd); }
 try { renameSync(temporary, target); } finally { try { unlinkSync(temporary); } catch { /* renamed */ } }
}

/** Git asks per exact HTTPS repository; expiry/read scope remain enforced by Artifacts. */
export function standaloneCredential(action: string, input: string, options: StandaloneAccessOptions = {}): string {
 if (action !== "get") return "";
 const refuse = "quit=true\n\n";
 try {
  if (input.length > 4096 || input.includes("\0") || input.includes("\r")) return refuse;
  const fields = new Map<string,string>();
  for (const line of input.split("\n").filter(Boolean)) {
   const index = line.indexOf("="); if (index < 1) return refuse;
   const key = line.slice(0,index);
   // Modern Git repeats protocol capabilities and HTTP challenges. They do not
   // select a repository or identity and need no value in this fixed helper.
   if (["capability[]", "wwwauth[]", "state[]"].includes(key)) continue;
   if (fields.has(key)) return refuse; fields.set(key,line.slice(index+1));
  }
  if (fields.get("protocol") !== "https" || fields.get("host") !== "github.ezil.work") return refuse;
  const url = `https://github.ezil.work/${fields.get("path") ?? ""}`;
  if (!canonicalRepository(url)) return refuse;
  const root = options.runtimeRoot ?? ROOT;
  directory(root, false);
  const approved = validatePrivateGrant(readState(fileFor(root, url)), url, (options.now ?? Date.now()) + 30_000);
  if (fields.has("username") && fields.get("username") !== "ezil") return refuse;
  return `username=ezil\npassword=${approved.grant.password}\npassword_expiry_utc=${approved.grant.password_expiry_utc}\n\n`;
 } catch { return refuse; }
}
