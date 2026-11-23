import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionAssignmentRepository } from "./assignment-repository";
import { sha256Hex } from "./sign";
import type { RepoRecord } from "./standalone";

const attemptId = "6ca895d2-c89b-44cd-864b-7647fbd85300";
const owner = "auth0|assignment-owner";
const remoteBase = "https://provider.invalid/git/default/";
const providerId = "fg1wtcrexaf7acl0";
const now = 1_795_435_200_000;
const gitAvailable = Bun.spawnSync(["git", "--version"]).success;
const text = new TextDecoder();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

const legacyEnv = (seconds: number) => ({ ...process.env, GIT_AUTHOR_NAME: "EZiL OS", GIT_AUTHOR_EMAIL: "noreply@ezil.work",
	GIT_AUTHOR_DATE: `@${seconds} +0000`, GIT_COMMITTER_NAME: "EZiL OS", GIT_COMMITTER_EMAIL: "noreply@ezil.work",
	GIT_COMMITTER_DATE: `@${seconds} +0000` });

/** A real bare repository behind a fake Artifacts binding and registry. */
async function world(options: {
	registered?: Partial<RepoRecord> | RepoRecord | undefined; exists?: boolean | undefined; description?: string | null | undefined;
	failFirstPut?: boolean | undefined; environment?: "staging" | "production" | undefined;
} = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "ezil-assignment-route-"));
	dirs.push(cwd);
	const git = (args: string[], stdin?: Uint8Array | string, env: NodeJS.ProcessEnv = process.env) => {
		const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe",
			stdin: typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin });
		if (!result.success) throw new Error(result.stderr.toString());
		return new Uint8Array(result.stdout);
	};
	git(["init", "--bare", "--initial-branch=main", "."]);
	const name = `u-${(await sha256Hex(owner)).slice(0, 16)}-a-${attemptId}`;
	const remote = `${remoteBase}${name}.git`;
	const records = new Map<string, string>();
	if (options.registered) records.set(`repo:default/${name}`, JSON.stringify(options.registered));
	let exists = options.exists ?? Boolean(options.registered);
	let description: string | null | undefined = options.description;
	const described = () => (description === undefined ? {} : { description });
	let failPut = options.failFirstPut ?? false;
	const calls = { creates: 0, gets: 0, puts: 0, pushes: 0, git: 0 };
	const registry = {
		async get(key: string) { return records.get(key) ?? null; },
		async put(key: string, value: string) {
			calls.puts += 1;
			if (failPut) { failPut = false; throw new Error("registry unavailable"); }
			records.set(key, value);
		},
	};
	const artifacts = {
		async create(repoName: string, config: { readOnly: boolean; setDefaultBranch: string; description?: string }) {
			expect(repoName).toBe(name);
			calls.creates += 1;
			if (exists) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
			exists = true;
			description = config.description;
			return { id: providerId, name, remote, defaultBranch: "main", token: "unused", ...described() };
		},
		async get(repoName: string) {
			expect(repoName).toBe(name);
			calls.gets += 1;
			return {
				async info() { return { id: providerId, name, remote, defaultBranch: "main", readOnly: false, ...described() }; },
				async createToken() { return { plaintext: "synthetic-assignment-native-token", scope: "write" as const,
					expiresAt: new Date(now + 90_000).toISOString() }; },
				[Symbol.dispose]() {},
			};
		},
	};
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		expect(url.href.startsWith(remote + "/")).toBe(true);
		calls.git += 1;
		const service = url.searchParams.get("service") ?? url.pathname.split("/").at(-1)!;
		const isAdvertisement = url.searchParams.has("service");
		if (!isAdvertisement && service === "git-receive-pack") calls.pushes += 1;
		const output = git([service.slice(4), "--stateless-rpc", ...(isAdvertisement ? ["--advertise-refs"] : []), "."],
			init?.body instanceof Uint8Array ? init.body : undefined);
		return new Response(output, { headers: { "content-type": `application/x-${service}-${isAdvertisement ? "advertisement" : "result"}` } });
	};
	const provision = () => provisionAssignmentRepository(registry, artifacts, owner, attemptId,
		options.environment ?? "staging", remoteBase, fetcher, () => now);
	const head = () => text.decode(git(["rev-parse", "refs/heads/main"])).trim();
	/** Reproduce the former OS seed: the same tree, committed with a real attempt-time date. */
	const seedLegacy = async (seconds = 1_795_000_000) => {
		const first = await world({ environment: options.environment });
		expect((await first.provision()).status).toBe(201);
		const tree = text.decode(first.git(["rev-parse", "HEAD^{tree}"])).trim();
		const objects = first.git(["pack-objects", "--revs", "--all", "--stdout"], "");
		git(["unpack-objects"], objects);
		const commit = text.decode(git(["commit-tree", tree], `Initialize EZiL assignment ${attemptId}\n`, legacyEnv(seconds))).trim();
		git(["update-ref", "refs/heads/main", commit]);
		return { commit, tree };
	};
	return { git, name, records, calls, provision, head, seedLegacy, key: `repo:default/${name}` };
}

const legacyRecord: RepoRecord = { providerId, ownerSub: owner, publicRead: false };

describe.skipIf(!gitAvailable)("assignment repository provisioning", () => {
	it("creates, seeds once and registers a new repository with its environment", async () => {
		const w = await world();
		const first = await w.provision();
		expect(first.status).toBe(201);
		const reply = await first.json() as Record<string, string>;
		expect(Object.keys(reply).sort()).toEqual(["attemptId", "baseSha", "providerId", "ref", "repoURL"]);
		expect(reply["baseSha"]).toBe(w.head());
		expect(JSON.parse(w.records.get(w.key)!)).toEqual({ ...legacyRecord, assignmentEnvironment: "staging" });
		expect((await w.provision()).status).toBe(200);
		expect(w.calls.pushes).toBe(1);
		expect(w.calls.creates).toBe(1);
	});

	it("returns the existing head for a registered repository the former OS seeded, without rewriting it", async () => {
		const w = await world({ registered: legacyRecord, description: undefined });
		const { commit } = await w.seedLegacy();
		const before = w.records.get(w.key);
		const result = await w.provision();
		expect(result.status).toBe(200);
		expect((await result.json() as { baseSha: string }).baseSha).toBe(commit);
		expect(w.head()).toBe(commit);
		expect(w.records.get(w.key)).toBe(before);
		expect(w.calls.pushes).toBe(0);
		expect(w.calls.puts).toBe(0);
	});

	it("seeds a registered empty repository", async () => {
		const w = await world({ registered: legacyRecord, description: undefined });
		const result = await w.provision();
		expect(result.status).toBe(200);
		expect((await result.json() as { baseSha: string }).baseSha).toBe(w.head());
		expect(w.calls.pushes).toBe(1);
		expect(w.calls.puts).toBe(0);
	});

	it("adopts an empty orphan the former OS created but never registered", async () => {
		const w = await world({ exists: true, description: undefined });
		const first = await w.provision();
		expect(first.status).toBe(200);
		const head = w.head();
		expect((await first.json() as { baseSha: string }).baseSha).toBe(head);
		expect(JSON.parse(w.records.get(w.key)!)).toEqual(legacyRecord);
		const again = await w.provision();
		expect(again.status).toBe(200);
		expect((await again.json() as { baseSha: string }).baseSha).toBe(head);
		expect(w.calls.pushes).toBe(1);
	});

	it("adopts an orphan whose provider description is an empty string", async () => {
		const w = await world({ exists: true, description: "" });
		expect((await w.provision()).status).toBe(200);
		expect(JSON.parse(w.records.get(w.key)!)).toEqual(legacyRecord);
	});

	it("adopts an orphan the former OS already seeded and keeps its head", async () => {
		const w = await world({ exists: true, description: null });
		const { commit } = await w.seedLegacy();
		const result = await w.provision();
		expect(result.status).toBe(200);
		expect((await result.json() as { baseSha: string }).baseSha).toBe(commit);
		expect(w.calls.pushes).toBe(0);
		expect(JSON.parse(w.records.get(w.key)!)).toEqual(legacyRecord);
	});

	it("refuses an orphan that holds other work and writes no registry record", async () => {
		const w = await world({ exists: true, description: undefined });
		const { commit, tree } = await w.seedLegacy();
		const changed = new TextDecoder().decode(w.git(["commit-tree", tree, "-p", commit], "Participant's changes\n",
			legacyEnv(1_795_000_100))).trim();
		w.git(["update-ref", "refs/heads/main", changed]);
		expect((await w.provision()).status).toBe(409);
		expect(w.records.has(w.key)).toBe(false);
		expect(w.head()).toBe(changed);
	});

	it("refuses an unregistered repository with any other description before touching Git", async () => {
		for (const description of ["ezil-universe-project:abc", "ezil-universe-assignment:" + "0".repeat(64)]) {
			const w = await world({ exists: true, description });
			expect((await w.provision()).status).toBe(409);
			expect(w.records.has(w.key)).toBe(false);
			expect(w.calls.git).toBe(0);
		}
	});

	it("registers on retry after a failed registry write", async () => {
		const w = await world({ failFirstPut: true });
		expect((await w.provision()).status).toBe(503);
		expect(w.records.has(w.key)).toBe(false);
		const retry = await w.provision();
		expect(retry.status).toBe(200);
		expect(JSON.parse(w.records.get(w.key)!)).toEqual({ ...legacyRecord, assignmentEnvironment: "staging" });
		expect(w.calls.pushes).toBe(1);
	});

	it("refuses registered records that are not this owner's private assignment, before touching Git", async () => {
		const refused: Partial<RepoRecord>[] = [
			{ ...legacyRecord, publicRead: true },
			{ ...legacyRecord, writerSubs: ["auth0|someone"] },
			{ ...legacyRecord, universeProjectId: "11111111-1111-4111-8111-111111111111" },
			{ ...legacyRecord, assignmentEnvironment: "production" },
			{ ...legacyRecord, ownerSub: "auth0|someone-else" },
			{ ...legacyRecord, providerId: "differentprovidr" },
		];
		for (const registered of refused) {
			const w = await world({ registered, description: undefined });
			expect((await w.provision()).status).toBe(409);
			expect(w.calls.git).toBe(0);
			expect(w.calls.puts).toBe(0);
		}
	});
});
