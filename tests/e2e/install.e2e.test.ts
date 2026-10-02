import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handle } from "../../apps/git-gateway/src/gateway";

/**
 * The install path end to end, locally: the real `ezil` binary (bun build --compile), served by the real gateway handler
 * from a stand-in for the R2 bucket, installed by the real /install.sh, then run. A tampered SHA256SUMS installs nothing.
 * Linux and macOS hosts only (the installer is POSIX sh; install.ps1 is exercised on Windows by hand).
 */
const VERSION = "0.0.1-test".replace("-test", "");
const target = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const FILE = `ezil-${VERSION}-${target}`;
let root: string;
const servers: Array<{ stop(force?: boolean): void }> = [];
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "ezil-install-e2e-")); });
afterAll(() => { for (const s of servers) s.stop(true); rmSync(root, { recursive: true, force: true }); });

async function run(cmd: string[], env: Record<string, string>) {
	const proc = Bun.spawn(cmd, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

it.skipIf(process.platform === "win32")("installs the checksum-verified binary from the gateway, and refuses a tampered one", async () => {
	const binary = join(root, FILE);
	const build = await run([process.execPath, "build", join(import.meta.dir, "..", "..", "packages", "cli", "bin", "ezil.ts"), "--compile", "--outfile", binary],
		{ PATH: process.env["PATH"] ?? "/usr/bin", HOME: root });
	expect(build.code).toBe(0);
	const bytes = new Uint8Array(readFileSync(binary)) as Uint8Array<ArrayBuffer>;
	const sums = `${createHash("sha256").update(bytes).digest("hex")}  ${FILE}\n`;
	const objects = new Map<string, Uint8Array<ArrayBuffer>>([
		["cli/latest", new TextEncoder().encode(VERSION)],
		[`cli/${VERSION}/${FILE}`, bytes],
		[`cli/${VERSION}/SHA256SUMS`, new TextEncoder().encode(sums)],
	]);
	const RELEASES = { get: async (key: string) => {
		const value = objects.get(key);
		return value ? { body: new Response(value).body!, size: value.length, httpEtag: `"${key}"` } : null;
	} };
	const gateway = Bun.serve({ port: 0, fetch: request => handle(request, { API_ORIGIN: "http://127.0.0.1:9", GIT_GATEWAY_SECRET: "s".repeat(48), IP_HASH_SALT: "salt", RELEASES },
		{ fetch, now: Date.now, cache: new Map(), log: () => {}, waitUntil: () => {} }) });
	servers.push(gateway);
	const base = `http://127.0.0.1:${gateway.port}`;
	const script = join(root, "install.sh");
	await Bun.write(script, await (await fetch(`${base}/install.sh`)).text());

	const dir = join(root, "bin");
	const env = { PATH: process.env["PATH"] ?? "/usr/bin", HOME: root, EZIL_DOWNLOAD_BASE: base, EZIL_INSTALL_DIR: dir };
	const installed = await run(["sh", script], env);
	expect(installed.stderr).toBe("");
	expect(installed.code).toBe(0);
	expect(installed.stdout).toContain(`Installed ezil ${VERSION} to ${dir}/ezil`);
	expect(installed.stdout).toContain("ezil auth login");
	const usage = await run([join(dir, "ezil")], { PATH: env.PATH, HOME: root });
	expect(usage.code).toBe(0);
	expect(usage.stderr + usage.stdout).toContain("ezil auth login");

	// A binary that does not match SHA256SUMS is never installed.
	rmSync(dir, { recursive: true, force: true });
	objects.set(`cli/${VERSION}/SHA256SUMS`, new TextEncoder().encode(`${"0".repeat(64)}  ${FILE}\n`));
	const refused = await run(["sh", script], env);
	expect(refused.code).not.toBe(0);
	expect(refused.stderr).toContain("checksum mismatch");
	expect(existsSync(join(dir, "ezil"))).toBe(false);
}, 120_000);
