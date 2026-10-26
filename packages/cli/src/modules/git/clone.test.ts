import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { io, memoryStore, session, useTempHome } from "../../core/testing";
import { canonicalRepository, clone as actualClone, type CloneOptions } from "./clone";

useTempHome();
const grant = { username: "ezil", password: `egg_${"a".repeat(64)}`, password_expiry_utc: 4102444800, scope: "read" };
function clone(value: Parameters<typeof actualClone>[0], repository?: string, options: CloneOptions = {}) {
	return actualClone(value, repository, options, async (url, folder) => value.run(["git", "clone", "--", url, folder]).code);
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function destination() { const root = mkdtempSync(join(tmpdir(), "ezil-open-test-")); roots.push(root); return join(root, "checkout"); }
const repo = (namespace: string, name = "website", project = "Acme Website") => ({ project, projectId: `project-${namespace}`, repository: "storage-name", access: "write", taskPublicId: null, cloneUrl: `https://github.ezil.work/${namespace}/${name}.git` });
const acme = repo("acme-3f9a1c");
const other = repo("other-1");
function git(...args: string[]) {
	const result = spawnSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}
function checkout(folder: string, url = acme.cloneUrl) {
	git("init", folder); git("-C", folder, "remote", "add", "origin", url);
	writeFileSync(join(folder, "tracked"), "original\n");
	git("-C", folder, "add", "."); git("-C", folder, "commit", "-m", "initial");
}
function signedIn(repositories = [acme]) {
	const h = io((path, body, auth) => {
		expect(auth).toBe("Bearer eca_a1");
		if (path === "/cli/git-grant") { expect(body?.["host"]).toBe("github.ezil.work"); return Response.json(grant); }
		expect(path).toBe("/cli/whoami"); expect(body).toBeNull();
		return Response.json({ account: { id: "a-1", email: "builder@test.example", role: "builder" }, session: { id: "12345678-1234-4234-8234-123456789abc", device: "laptop", os: "linux", expiresAt: "2030-01-01T00:00:00.000Z" }, repositories });
	}, memoryStore(session()));
	h.io = { ...h.io, run: cmd => {
		h.ran.push(cmd);
		if (cmd[1] === "clone") { checkout(cmd[4]!, cmd[3]!); return { code: 0, stdout: "" }; }
		const result = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
		return { code: result.status ?? 1, stdout: result.stdout };
	} };
	return h;
}
const options = (folder: string) => ({ directory: folder, json: true });
function errorCode(h: ReturnType<typeof signedIn>) { return JSON.parse(h.out.at(-1)!).error.code; }

describe("URL clone contract", () => {
	it("selects exact namespace despite duplicate basename/project and installs atomically", async () => {
		const folder = destination(), h = signedIn([other, acme]);
		expect(await clone(h.io, acme.cloneUrl, options(folder))).toBe(0);
		expect(JSON.parse(h.out[0]!)).toEqual({ canonicalUrl: acme.cloneUrl, folder, accountId: "a-1", status: "cloned" });
		expect(git("-C", folder, "remote", "get-url", "origin").trim()).toBe(acme.cloneUrl);
		expect(readdirSync(join(folder, ".."))).toEqual(["checkout"]);
	});
	for (const name of [undefined, "WEBSITE", "aCmE wEbSiTe"]) it(`retains name selection: ${name}`, async () => {
		const h = signedIn(); expect(await clone(h.io, name, options(destination()))).toBe(0);
	});
	it("rejects ambiguous names and unauthorized URLs without Git", async () => {
		for (const [name, code] of [["website", "ambiguous-repository"], [repo("denied").cloneUrl, "repository-not-authorized"]]) {
			const h = signedIn([acme, other]); expect(await clone(h.io, name, options(destination()))).toBe(2); expect(errorCode(h)).toBe(code); expect(h.ran).toEqual([]);
		}
	});
	for (const value of ["http://github.ezil.work/acme/repo.git", "https://git.ezil.work/acme/repo.git", "https://user:secret@github.ezil.work/acme/repo.git", "https://github.ezil.work/acme/repo.git?secret=1", "https://github.ezil.work/acme/repo.git#x", "https://github.ezil.work/acme/../repo.git", "https://github.ezil.work/acme/%2e%2e.git", "https://github.ezil.work/acme/repo.git/info/refs", "https://github.ezil.work/acme/repo.git.git", "git@github.ezil.work:acme/repo.git", "--upload-pack=evil", "https://github.ezil.work/acme/repo.git\n"]) it(`rejects invalid input ${JSON.stringify(value)}`, async () => {
		const h = signedIn(); expect(canonicalRepository(value)).toBeNull(); expect(await clone(h.io, value, options(destination()))).toBe(2); expect(h.ran).toEqual([]); expect(h.calls).toEqual([]);
	});
	it("returns stable auth-required for absent and revoked sessions", async () => {
		for (const h of [io(() => { throw new Error("no API"); }), io(() => Response.json({ error: "revoked" }, { status: 401 }), memoryStore(session()))]) {
			expect(await clone(h.io, acme.cloneUrl, options(destination()))).toBe(1); expect(errorCode(h)).toBe("auth-required"); expect(h.ran).toEqual([]);
		}
	});
	it("reuses dirty detached locally diverged checkout without changing any state", async () => {
		const folder = destination(); checkout(folder);
		git("-C", folder, "update-ref", "refs/remotes/origin/main", "HEAD");
		writeFileSync(join(folder, "tracked"), "local commit\n"); git("-C", folder, "commit", "-am", "local"); git("-C", folder, "checkout", "--detach");
		writeFileSync(join(folder, "tracked"), "dirty\n"); writeFileSync(join(folder, "untracked"), "keep\n");
		const before = git("-C", folder, "status", "--porcelain=v2", "--branch");
		const h = signedIn(); expect(await clone(h.io, acme.cloneUrl, options(folder))).toBe(0);
		expect(JSON.parse(h.out[0]!).status).toBe("reused"); expect(git("-C", folder, "status", "--porcelain=v2", "--branch")).toBe(before);
		expect(readFileSync(join(folder, "tracked"), "utf8")).toBe("dirty\n"); expect(h.ran.length).toBe(2);
	});
	it("denies reuse after access revocation", async () => {
		const folder = destination(); checkout(folder); const h = signedIn([]);
		expect(await clone(h.io, acme.cloneUrl, options(folder))).toBe(2); expect(h.ran).toEqual([]);
	});
	it("preserves wrong-origin and non-checkout destinations", async () => {
		for (const make of [(f: string) => checkout(f, other.cloneUrl), (f: string) => mkdirSync(f)]) {
			const folder = destination(); make(folder); writeFileSync(join(folder, "keep"), "keep"); const h = signedIn();
			expect(await clone(h.io, acme.cloneUrl, options(folder))).toBe(1); expect(errorCode(h)).toBe("destination-conflict"); expect(readFileSync(join(folder, "keep"), "utf8")).toBe("keep");
		}
	});
	it("rejects symlink destination and parent, relative path and traversal", async () => {
		const folder = destination(), target = destination(); mkdirSync(target); symlinkSync(target, folder);
		for (const path of [folder, join(folder, "nested"), "relative", `${target}/../other`]) {
			const h = signedIn(); expect(await clone(h.io, acme.cloneUrl, options(path))).not.toBe(0); expect(h.ran).toEqual([]);
		}
	});
	it("cleans a failed partial clone and permits retry", async () => {
		const folder = destination(), h = signedIn();
		h.io = { ...h.io, run: cmd => { mkdirSync(cmd[4]!); writeFileSync(join(cmd[4]!, "partial"), "partial"); return { code: 128, stdout: "secret" }; } };
		expect(await clone(h.io, acme.cloneUrl, options(folder))).toBe(1); expect(errorCode(h)).toBe("clone-failed"); expect(readdirSync(join(folder, ".."))).toEqual([]);
		expect(await clone(signedIn().io, acme.cloneUrl, options(folder))).toBe(0);
	});
	it("does not replace a destination that appears during clone", async () => {
		const folder = destination(), h = signedIn(), run = h.io.run;
		h.io = { ...h.io, run: cmd => { const result = run(cmd); mkdirSync(folder); writeFileSync(join(folder, "keep"), "keep"); return result; } };
		expect(await clone(h.io, acme.cloneUrl, options(folder))).toBe(1); expect(readFileSync(join(folder, "keep"), "utf8")).toBe("keep");
	});
	it("serializes concurrent opens into cloned then reused", async () => {
		const folder = destination(), a = signedIn(), b = signedIn();
		expect(await Promise.all([clone(a.io, acme.cloneUrl, options(folder)), clone(b.io, acme.cloneUrl, options(folder))])).toEqual([0, 0]);
		expect([JSON.parse(a.out[0]!).status, JSON.parse(b.out[0]!).status].sort()).toEqual(["cloned", "reused"]);
		expect([...a.ran, ...b.ran].filter(cmd => cmd[1] === "clone")).toHaveLength(1);
	});
});

describe("clone command dispatch", () => {
	it("accepts the OS arguments and returns one auth-required JSON document", () => {
		const folder = destination();
		const result = spawnSync(process.execPath, [join(import.meta.dir, "../../../bin/ezil.ts"), "clone", acme.cloneUrl, "--directory", folder, "--json"], {
			encoding: "utf8", env: { ...process.env, EZIL_CLI_STORE: "file", EZIL_HOME: join(folder, "absent-home") },
		});
		expect(result.status).toBe(1); expect(JSON.parse(result.stdout).error.code).toBe("auth-required"); expect(result.stderr).toBe("");
	});
	for (const args of [["--directory"], ["--directory=/tmp/a", "--directory=/tmp/b"], ["--upload-pack=evil"], ["extra"]]) it(`rejects malformed options ${args}`, () => {
		const result = spawnSync(process.execPath, [join(import.meta.dir, "../../../bin/ezil.ts"), "clone", acme.cloneUrl, ...args, "--json"], { encoding: "utf8" });
		expect(result.status).toBe(2); expect(JSON.parse(result.stdout).error.code).toBe("invalid-arguments"); expect(result.stderr).toBe("");
	});
});

describe("operation authorization", () => {
	it("refuses a listed checkout when the live grant is denied, preserving dirty state", async () => {
		const folder = destination(); checkout(folder); writeFileSync(join(folder, "tracked"), "dirty");
		const h = signedIn(), fetch = h.io.fetch;
		h.io = { ...h.io, fetch: ((input, init) => String(input).endsWith("/cli/git-grant") ? Promise.resolve(Response.json({ error: "authority_lapsed" }, { status: 403 })) : fetch(input, init)) as typeof fetch };
		expect(await clone(h.io, acme.cloneUrl, options(folder))).toBe(2);
		expect(errorCode(h)).toBe("repository-not-authorized"); expect(readFileSync(join(folder, "tracked"), "utf8")).toBe("dirty");
	});
	it("pins the A token and grant even when the stored session becomes authorized account B", async () => {
		const folder = destination(), h = signedIn(), fetch = h.io.fetch;
		h.io = { ...h.io, fetch: (async (input, init) => {
			if (String(input).endsWith("/cli/git-grant")) {
				expect(h.store.value?.accessToken).toBe("eca_b2");
				// Both identities can access this URL: a mutable lookup would silently succeed as B.
				const isA = new Headers(init?.headers).get("authorization") === "Bearer eca_a1";
				return Response.json({ ...grant, password: `egg_${(isA ? "a" : "b").repeat(64)}` });
			}
			const response = await fetch(input, init);
			h.store.write(session({ sessionId: "session-b", accessToken: "eca_b2" }));
			return response;
		}) as typeof fetch };
		let usedA = false;
		expect(await actualClone(h.io, acme.cloneUrl, options(folder), async (url, target, credential) => {
			usedA = credential.password === grant.password;
			checkout(target, url); return 0;
		})).toBe(0);
		expect(usedA).toBe(true); expect(JSON.parse(h.out[0]!).accountId).toBe("a-1");
		expect(h.out.join()).not.toContain(grant.password);
	});
	it("fails closed if A loses access after the stored session switches to authorized B", async () => {
		const folder = destination(), h = signedIn(), fetch = h.io.fetch;
		h.io = { ...h.io, fetch: (async (input, init) => {
			if (String(input).endsWith("/cli/git-grant")) {
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer eca_a1");
				return Response.json({ error: "session_revoked" }, { status: 401 });
			}
			const response = await fetch(input, init); h.store.write(session({ accessToken: "eca_b2" })); return response;
		}) as typeof fetch };
		expect(await clone(h.io, acme.cloneUrl, options(folder))).toBe(1); expect(errorCode(h)).toBe("auth-required"); expect(h.ran).toEqual([]);
	});
});

it("cleanup preserves lock/temp paths replaced by an unrelated operation", async () => {
	const folder = destination(), h = signedIn();
	let replacedTemp = "";
	const lock = join(dirname(folder), ".checkout.ezil-clone-lock");
	expect(await actualClone(h.io, acme.cloneUrl, options(folder), async (_url, target) => {
		renameSync(lock, `${lock}.original`); mkdirSync(lock); writeFileSync(join(lock, "unknown"), "keep");
		replacedTemp = dirname(target);
		renameSync(replacedTemp, `${replacedTemp}.original`); mkdirSync(replacedTemp); writeFileSync(join(replacedTemp, "unknown"), "keep");
		return 1;
	})).toBe(1);
	expect(readFileSync(join(lock, "unknown"), "utf8")).toBe("keep");
	expect(readFileSync(join(replacedTemp, "unknown"), "utf8")).toBe("keep");
});
