import { describe, expect, it } from "bun:test";

import { io, memoryStore, session, useTempHome } from "../../core/testing";
import { clone } from "./clone";

useTempHome();

const repo = (namespace: string, name: string, project: string) => ({ project, projectId: `project-${namespace}`, repository: "storage-name",
	access: "write", taskPublicId: null, cloneUrl: `https://github.ezil.work/${namespace}/${name}.git` });
const acme = repo("acme-3f9a1c", "website", "Acme Website");
const other = repo("other-1", "mobile", "Other App");
function signedIn(repositories: ReturnType<typeof repo>[]) {
	return io((path, body, auth) => {
		expect(path).toBe("/cli/whoami");
		expect(body).toBeNull();
		expect(auth).toBe("Bearer eca_a1");
		return Response.json({ account: { id: "a-1", email: "builder@test.example", role: "builder" },
			session: { id: "12345678-1234-4234-8234-123456789abc", device: "laptop", os: "linux", expiresAt: "2030-01-01T00:00:00.000Z" }, repositories });
	}, memoryStore(session()));
}

describe("ezil clone", () => {
	it("clones the only repository and prints the folder and next step", async () => {
		const h = signedIn([acme]);
		expect(await clone(h.io)).toBe(0);
		expect(h.ran).toEqual([["git", "clone", acme.cloneUrl]]);
		expect(h.out).toEqual(["Cloned into website.", "Next: cd website && git push"]);
	});
	for (const name of ["WEBSITE", "website.git", "WEBSITE.GiT", "aCmE wEbSiTe"]) {
		it(`matches ${name} case-insensitively by route or project name`, async () => {
			const h = signedIn([acme, other]);
			expect(await clone(h.io, name)).toBe(0);
			expect(h.ran).toEqual([["git", "clone", acme.cloneUrl]]);
		});
	}
	for (const name of ["acme-3f9a1c/website", "AcMe-3F9A1C/WeBsItE", "acme-3f9a1c/website.git", "ACME-3F9A1C/WEBSITE.GiT"]) {
		it(`matches the full path ${name} even when route and project names are ambiguous`, async () => {
			const duplicate = repo("other-2", "website", "Acme Website");
			const h = signedIn([duplicate, acme, other]);
			expect(await clone(h.io, name)).toBe(0);
			expect(h.ran).toEqual([["git", "clone", acme.cloneUrl]]);
			expect(h.out).toEqual(["Cloned into website.", "Next: cd website && git push"]);
		});
	}
	for (const name of [undefined, "website", "Acme Website", "missing", "missing/website", "other-2/mobile"]) {
		it(`lists repositories and exits 2 for ${name ?? "no argument"} without a unique match`, async () => {
			const duplicate = repo("other-2", "website", "Acme Website");
			const h = signedIn([acme, duplicate, other]);
			expect(await clone(h.io, name)).toBe(2);
			expect(h.ran).toEqual([]);
			expect(h.out).toEqual([
				`  acme-3f9a1c/website  (Acme Website)  ${acme.cloneUrl}`,
				`  other-2/website  (Acme Website)  ${duplicate.cloneUrl}`,
				`  other-1/mobile  (Other App)  ${other.cloneUrl}`,
			]);
		});
	}
	it("lists an empty account without prompting", async () => {
		const h = signedIn([]);
		expect(await clone(h.io)).toBe(2);
		expect(h.out).toEqual(["No repositories yet."]);
		expect(h.ran).toEqual([]);
	});
	it("requires a session before calling the API or Git", async () => {
		const h = io(() => { throw new Error("Must not call the API"); });
		expect(await clone(h.io)).toBe(1);
		expect(h.err).toEqual(["Not signed in. Run `ezil auth login`."]);
		expect(h.calls).toEqual([]);
		expect(h.ran).toEqual([]);
	});
	it("reports a failed git clone without printing a success or next step", async () => {
		const h = signedIn([acme]);
		h.io = { ...h.io, run: () => ({ code: 128, stdout: "" }) };
		expect(await clone(h.io)).toBe(1);
		expect(h.out).toEqual([]);
		expect(h.err.join("")).toContain("Could not clone");
	});
});
