import { expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("real Git reproduces inherited netrc/template injection; scoped transport blocks both", async () => {
	const root = mkdtempSync(join(tmpdir(), "ezil-env-test-"));
	const home = join(root, "home"), templates = join(root, "templates"), source = join(root, "source");
	const realGit = Bun.which("git")!;
	mkdirSync(home); mkdirSync(join(templates, "hooks"), { recursive: true });
	writeFileSync(join(home, ".netrc"), "machine 127.0.0.1 login account-b password synthetic-b\n", { mode: 0o600 });
	const hookMarker = join(root, "hook-ran");
	writeFileSync(join(templates, "config"), '[http]\n\textraHeader = X-Injected: template-b\n');
	writeFileSync(join(templates, "hooks", "post-checkout"), `#!/bin/sh\nprintf ran > '${hookMarker}'\n`);
	chmodSync(join(templates, "hooks", "post-checkout"), 0o700);
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, CURL_HOME: home,
		GIT_TEMPLATE_DIR: templates, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
	delete env["NETRC"]; // Baseline specifically reproduces HOME/.netrc lookup.
	const git = (...args: string[]) => spawnSync(realGit, args, { env, encoding: "utf8" });
	git("init", "--template=", source);
	writeFileSync(join(source, "file"), "content"); git("-C", source, "add", ".");
	expect(git("-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial").status).toBe(0);
	const received: boolean[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
		received.push(request.headers.get("authorization") === `Basic ${Buffer.from("account-b:synthetic-b").toString("base64")}`);
		return new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="test"' } });
	} });
	const probe = `http://127.0.0.1:${server.port}/repo.git`;
	try {
		// Executed repro: libcurl tries B from the inherited HOME without our helper.
		const baseline = Bun.spawn([realGit, "ls-remote", probe], { env, stdout: "ignore", stderr: "ignore" });
		await baseline.exited;
		expect(received).toContain(true);
		const baselineFolder = join(root, "baseline");
		expect(git("clone", source, baselineFolder).status).toBe(0);
		expect(existsSync(hookMarker)).toBe(true);
		expect(readFileSync(join(baselineFolder, ".git", "config"), "utf8")).toContain("X-Injected: template-b");
		rmSync(hookMarker); received.length = 0;

		// The shim changes only the network target for this local test. It runs real Git
		// with the production child's actual environment and all production config flags.
		const shim = join(root, "git");
		writeFileSync(shim, `#!/usr/bin/env node
const cp=require('node:child_process');const args=process.argv.slice(2),i=args.indexOf('clone'),flags=args.slice(0,i);
if(process.env.GIT_TEMPLATE_DIR || process.env.HOME===${JSON.stringify(home)})process.exit(41);
cp.spawnSync(${JSON.stringify(realGit)},[...flags,'ls-remote',${JSON.stringify(probe)}],{stdio:'ignore'});
const local=[...args];local[local.length-2]=${JSON.stringify(source)};
process.exit(cp.spawnSync(${JSON.stringify(realGit)},local,{stdio:'ignore'}).status??1);
`);
		chmodSync(shim, 0o700);
		const destination = join(root, "isolated");
		const runner = join(root, "runner.ts");
		writeFileSync(runner, `import {cloneWithGrant} from ${JSON.stringify(join(import.meta.dir, "clone-transport.ts"))};
process.exitCode=await cloneWithGrant('https://github.ezil.work/acme/repo.git',${JSON.stringify(destination)},{username:'ezil',password:'egg_'+'a'.repeat(64),password_expiry_utc:4102444800,scope:'read'});`);
		const fixed = Bun.spawn([process.execPath, runner], { env: { ...env, NETRC: join(home, ".netrc"), PATH: `${root}:${process.env["PATH"]}` }, stdout: "pipe", stderr: "pipe" });
		expect(await fixed.exited).toBe(0);
		expect(received.length).toBeGreaterThan(0); expect(received).not.toContain(true);
		expect(existsSync(hookMarker)).toBe(false);
		expect(existsSync(join(destination, ".git", "hooks", "post-checkout"))).toBe(false);
		expect(readFileSync(join(destination, ".git", "config"), "utf8")).not.toContain("X-Injected");
		expect(readFileSync(join(destination, "file"), "utf8")).toBe("content");
		expect(await new Response(fixed.stdout).text()).toBe("");
		expect(await new Response(fixed.stderr).text()).toBe("");
	} finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 15000);
