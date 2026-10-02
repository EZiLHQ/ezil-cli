import { describe, expect, it } from "bun:test";

import { GRANT, io, memoryStore, session, useTempHome } from "../../core/testing";
import { gitCredential } from "./credential";

useTempHome();

describe("ezil git-credential", () => {
	it("answers only for github.ezil.work, with a per-repository grant and its expiry", async () => {
		const h = io((path, body, auth) => {
			expect(path).toBe("/cli/git-grant");
			expect(auth).toBe("Bearer eca_a1");
			expect(body).toEqual({ protocol: "https", host: "github.ezil.work", path: "acme-3f9a1c/acme.git" });
			return Response.json({ username: "ezil", password: GRANT, password_expiry_utc: 1_900_000_000 });
		}, memoryStore(session()));
		await gitCredential(h.io, "get", "protocol=https\nhost=github.ezil.work\npath=acme-3f9a1c/acme.git\n");
		expect(h.out).toEqual(["username=ezil", `password=${GRANT}`, "password_expiry_utc=1900000000"]);
		const other = io(() => { throw new Error("must not call"); }, memoryStore(session()));
		await gitCredential(other.io, "get", "protocol=https\nhost=github.com\npath=org/repo.git\n");
		expect(other.out).toEqual([]); expect(other.calls).toHaveLength(0);
	});
	it("stays silent on stdout and exits 0 when signed out or refused, so git can report it", async () => {
		const signedOut = io(() => { throw new Error("must not call"); });
		expect(await gitCredential(signedOut.io, "get", "protocol=https\nhost=github.ezil.work\npath=a/b.git\n")).toBe(0);
		expect(signedOut.out).toEqual([]); expect(signedOut.err.join("")).toContain("ezil auth login");
		const refused = io(() => Response.json({ error: "repository_not_found", message: "EZiL: repository not found, or you do not have access to it." }, { status: 404 }), memoryStore(session()));
		expect(await gitCredential(refused.io, "get", "protocol=https\nhost=github.ezil.work\npath=a/b.git\n")).toBe(0);
		expect(refused.out).toEqual([]); expect(refused.err.join("")).toContain("repository not found");
	});
	it("does nothing for store and erase: no grant is ever kept", async () => {
		const h = io(() => { throw new Error("must not call"); }, memoryStore(session()));
		await gitCredential(h.io, "store", `protocol=https\nhost=github.ezil.work\npassword=${GRANT}\n`);
		await gitCredential(h.io, "erase", "protocol=https\nhost=github.ezil.work\n");
		expect(h.calls).toHaveLength(0); expect(h.store.value?.accessToken).toBe("eca_a1");
	});
});
