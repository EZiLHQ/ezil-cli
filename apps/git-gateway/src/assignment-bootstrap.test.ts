import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmAssignmentBootstrap } from "./assignment-bootstrap";

const attemptId = "6ca895d2-c89b-44cd-864b-7647fbd85300";
const repoURL = "https://github.ezil.work/default/u-0123456789abcdef-a-" + attemptId + ".git";
const remote = "https://provider.invalid/assignment.git";
const token = "synthetic-service-git-token";
const gitAvailable = Bun.spawnSync(["git", "--version"]).success;

it.skipIf(!gitAvailable)("bootstraps once, reconciles the exact historical root, and refuses changed contents", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "ezil-assignment-git-"));
	try {
		function git(args: string[], stdin?: Uint8Array | string, env = process.env): Uint8Array<ArrayBuffer> {
			const result = Bun.spawnSync(["git", ...args], { cwd, stdin: typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin, env, stdout: "pipe", stderr: "pipe" });
			if (!result.success) throw new Error(result.stderr.toString());
			return new Uint8Array(result.stdout);
		}
		const text = new TextDecoder();
		git(["init", "--bare", "--initial-branch=main", "."]);
		let pushes = 0;
		const fetcher = async (input: Request | URL | string, init?: RequestInit) => {
			const url = new URL(String(input));
			expect(url.origin + (url.pathname.split("/").slice(0, 2).join("/"))).toBe(remote);
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + token);
			const service = url.searchParams.get("service") ?? url.pathname.split("/").at(-1)!;
			const isAdvertisement = url.searchParams.has("service");
			if (!isAdvertisement && service === "git-receive-pack") pushes += 1;
			const command = [service.slice(4), "--stateless-rpc", ...(isAdvertisement ? ["--advertise-refs"] : []), "."];
			const output = git(command, init?.body instanceof Uint8Array ? init.body : undefined);
			return new Response(output, { headers: {
				"content-type": "application/x-" + service + "-" + (isAdvertisement ? "advertisement" : "result"),
			} });
		};
		const confirm = () => confirmAssignmentBootstrap(repoURL, remote, attemptId, token, fetcher);
		const first = await confirm();
		expect(await confirm()).toBe(first);
		expect(pushes).toBe(1);
		const marker = JSON.parse(text.decode(git(["show", "HEAD:.ezil/assignment.json"])));
		expect(marker).toMatchObject({ schema: "ezil.assignment/v2", repositoryUrl: repoURL, preload: { port: 5679 } });
		const tree = text.decode(git(["rev-parse", "HEAD^{tree}"])).trim();
		const env = { ...process.env, GIT_AUTHOR_NAME: "EZiL OS", GIT_AUTHOR_EMAIL: "noreply@ezil.work",
			GIT_AUTHOR_DATE: "@1795000000 +0000", GIT_COMMITTER_NAME: "EZiL OS",
			GIT_COMMITTER_EMAIL: "noreply@ezil.work", GIT_COMMITTER_DATE: "@1795000000 +0000" };
		const legacy = text.decode(git(["commit-tree", tree], "Initialize EZiL assignment " + attemptId + "\n", env)).trim();
		git(["update-ref", "refs/heads/main", legacy]);
		expect(await confirm()).toBe(legacy);
		const changed = text.decode(git(["commit-tree", tree, "-p", legacy], "Participant's changes\n", env)).trim();
		git(["update-ref", "refs/heads/main", changed]);
		await expect(confirm()).rejects.toThrow();
		expect(text.decode(git(["rev-parse", "HEAD"])).trim()).toBe(changed);
		expect(pushes).toBe(1);
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
});

it.skipIf(!gitAvailable)("refuses a seeded head whose message, tree or author differs from the OS bootstrap", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "ezil-assignment-git-"));
	try {
		function git(args: string[], stdin?: Uint8Array | string, env = process.env): Uint8Array<ArrayBuffer> {
			const result = Bun.spawnSync(["git", ...args], { cwd, stdin: typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin, env, stdout: "pipe", stderr: "pipe" });
			if (!result.success) throw new Error(result.stderr.toString());
			return new Uint8Array(result.stdout);
		}
		const text = new TextDecoder();
		git(["init", "--bare", "--initial-branch=main", "."]);
		const fetcher = async (input: Request | URL | string, init?: RequestInit) => {
			const url = new URL(String(input));
			const service = url.searchParams.get("service") ?? url.pathname.split("/").at(-1)!;
			const isAdvertisement = url.searchParams.has("service");
			const output = git([service.slice(4), "--stateless-rpc", ...(isAdvertisement ? ["--advertise-refs"] : []), "."],
				init?.body instanceof Uint8Array ? init.body : undefined);
			return new Response(output, { headers: {
				"content-type": "application/x-" + service + "-" + (isAdvertisement ? "advertisement" : "result"),
			} });
		};
		const confirm = () => confirmAssignmentBootstrap(repoURL, remote, attemptId, token, fetcher);
		const seeded = await confirm();
		const tree = text.decode(git(["rev-parse", seeded + "^{tree}"])).trim();
		const identity = (name: string, email: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
			GIT_AUTHOR_DATE: "@1795000000 +0000", GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
			GIT_COMMITTER_DATE: "@1795000000 +0000" });
		const os = identity("EZiL OS", "noreply@ezil.work");
		const readme = text.decode(git(["hash-object", "-w", "--stdin"], "# Something else\n")).trim();
		const ezil = text.decode(git(["rev-parse", tree + ":.ezil"])).trim();
		const otherTree = text.decode(git(["mktree"], `040000 tree ${ezil}\t.ezil\n100644 blob ${readme}\tREADME.md\n`)).trim();
		const cases = {
			message: text.decode(git(["commit-tree", tree], "Initialize EZiL assignment 00000000-0000-4000-8000-000000000000\n", os)).trim(),
			tree: text.decode(git(["commit-tree", otherTree], "Initialize EZiL assignment " + attemptId + "\n", os)).trim(),
			author: text.decode(git(["commit-tree", tree], "Initialize EZiL assignment " + attemptId + "\n",
				identity("Someone", "someone@example.com"))).trim(),
		};
		for (const [label, commit] of Object.entries(cases)) {
			git(["update-ref", "refs/heads/main", commit]);
			await expect(confirm(), label).rejects.toThrow();
			expect(text.decode(git(["rev-parse", "refs/heads/main"])).trim()).toBe(commit);
		}
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
});
