import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = "https://github.ezil.work/default/empty-fixture.git";
const git = Bun.which("git")!;

test("standalone Git opens a proven empty main, preserves edits on reopen, and prepares the first plain push", () => {
	const root = mkdtempSync(join(tmpdir(), "ezil-empty-main-"));
	const remote = join(root, "remote.git");
	const bin = join(root, "bin");
	const checkout = join(root, "checkout");
	const probeCount = join(root, "probe-count");
	const run = (...args: string[]) =>
		execFileSync(git, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

	try {
		mkdirSync(bin);
		run("init", "--bare", "--initial-branch=main", "--", remote);
		const fakeGit = `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const url = ${JSON.stringify(url)};
const git = ${JSON.stringify(git)};
const remote = ${JSON.stringify(remote)};
const clone = args.includes("clone");
if (args.includes("ls-remote")) {
  const fill = path => cp.spawnSync(git, [...args.slice(0,args.indexOf("ls-remote")), "credential", "fill"], {
    input: "protocol=https\\nhost=github.ezil.work\\npath=" + path + "\\n\\n",
    encoding: "utf8",
  });
  const allowed = fill("default/empty-fixture.git");
  const denied = fill("default/different-fixture.git");
  if (allowed.status !== 0 || !allowed.stdout.includes("password=art_v1_") ||
      denied.status === 0 || denied.stdout.includes("password=")) process.exit(81);
  if (process.env.EZIL_EMPTY_PROBE_MODE === "auth-failure") process.exit(128);
  if (process.env.EZIL_EMPTY_PROBE_MODE === "raced") {
    const marker = ${JSON.stringify(probeCount)};
    if (fs.existsSync(marker)) {
      process.stdout.write("a".repeat(40) + "\\trefs/heads/other\\n");
      process.exit(0);
    }
    fs.writeFileSync(marker, "first probe");
  }
  args[args.indexOf(url)] = remote;
}
if (clone) args[args.indexOf(url)] = remote;
let result = cp.spawnSync(git, args, { stdio: "inherit" });
if (clone && result.status === 0) {
  result = cp.spawnSync(git, ["-C", args.at(-1), "remote", "set-url", "origin", url], { stdio: "inherit" });
}
process.exit(result.status ?? 1);
`;
		writeFileSync(join(bin, "git"), fakeGit, { mode: 0o700 });

		const supervisor = "const cp=require('node:child_process'),fs=require('node:fs');" +
			"const [runtime,entry,url,folder]=process.argv.slice(1);" +
			"const child=cp.spawn(runtime,[entry,'clone',url,'--directory',folder,'--json','--grant-fd=3']," +
			"{stdio:['ignore','pipe','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);" +
			"child.on('error',()=>{process.exitCode=1});child.on('close',code=>{process.exitCode=code??1});" +
			"child.stdio[3].end(fs.readFileSync(0));";

		function open(folder: string, ref = "refs/heads/main", mode = "") {
			const token = "art_v1_" + "a".repeat(40) + "?expires=" + Math.floor(Date.now() / 1000 + 60);
			const packet = {
				version: 2,
				repository: { id: "cf-empty-fixture", canonicalURL: url, ref },
				identity: { issuer: "https://id.ezil.work/", subject: "auth0|empty-fixture" },
				git: { username: "ezil", token, expiresAt: new Date(Date.now() + 60000).toISOString(), scope: "read" },
			};
			const child = spawnSync("node", [
				"-e", supervisor, process.env["EZIL_TEST_CLI_RUNTIME"] ?? process.execPath,
				process.env["EZIL_TEST_CLI_ENTRY"] ?? join(import.meta.dir, "../../../bin/ezil.ts"), url, folder,
			], {
				env: { ...process.env, PATH: bin + ":" + process.env["PATH"], EZIL_HOME: join(root, "auth"), EZIL_CLI_STORE: "file", EZIL_EMPTY_PROBE_MODE: mode },
				input: JSON.stringify(packet), encoding: "utf8", timeout: 8000,
			});
			if (child.error) throw child.error;
			expect(child.stdout + child.stderr).not.toContain(token);
			return { exit: child.status, value: JSON.parse(child.stdout) };
		}

		const opened = open(checkout);
		expect(opened.exit).toBe(0);
		expect(opened.value.status).toBe("cloned");
		expect(opened.value.repository.ref).toBe("refs/heads/main");
		expect(run("-C", checkout, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
		expect(run("-C", checkout, "for-each-ref")).toBe("");
		expect(run("-C", checkout, "config", "--local", "remote.origin.url")).toBe(url);
		expect(run("-C", checkout, "config", "--local", "remote.origin.fetch")).toBe("+refs/heads/main:refs/remotes/origin/main");
		expect(run("-C", checkout, "config", "--local", "remote.origin.tagOpt")).toBe("--no-tags");
		expect(run("-C", checkout, "config", "--local", "branch.main.remote")).toBe("origin");
		expect(run("-C", checkout, "config", "--local", "branch.main.merge")).toBe("refs/heads/main");

		for (const [name, ref, mode] of [
			["other-ref", "refs/heads/other", ""],
			["denied", "refs/heads/main", "auth-failure"],
			["raced", "refs/heads/main", "raced"],
		] as const) {
			const rejected = join(root, name);
			expect(open(rejected, ref, mode).exit).not.toBe(0);
			expect(existsSync(rejected)).toBe(false);
		}

		writeFileSync(join(checkout, "first.txt"), "first commit");
		run("-C", checkout, "add", "first.txt");
		writeFileSync(join(checkout, "first.txt"), "unstaged change");
		writeFileSync(join(checkout, "untracked.txt"), "preserve");
		const dirty = run("-C", checkout, "status", "--porcelain=v1");
		expect(open(checkout).value.status).toBe("reused");
		expect(run("-C", checkout, "status", "--porcelain=v1")).toBe(dirty);

		run("-C", checkout, "config", "user.name", "Fixture");
		run("-C", checkout, "config", "user.email", "fixture@example.invalid");
		run("-C", checkout, "commit", "-qm", "first fixture commit");
		run("-C", checkout, "remote", "set-url", "origin", remote);
		run("-C", checkout, "tag", "fixture-tag");
		run("-C", checkout, "push", "origin", "refs/tags/fixture-tag");
		const tagOnly = join(root, "tag-only");
		expect(open(tagOnly).exit).not.toBe(0);
		expect(existsSync(tagOnly)).toBe(false);
		run("-C", checkout, "push", "origin", "HEAD:refs/heads/other");
		const missingMain = join(root, "nonempty-without-main");
		expect(open(missingMain).exit).not.toBe(0);
		expect(existsSync(missingMain)).toBe(false);

		run("-C", checkout, "push");
		const commit = run("-C", checkout, "rev-parse", "HEAD");
		expect(run("--git-dir", remote, "rev-parse", "refs/heads/main")).toBe(commit);
		const populated = join(root, "populated");
		expect(open(populated).exit).toBe(0);
		expect(run("-C", populated, "rev-parse", "HEAD")).toBe(commit);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 25000);
