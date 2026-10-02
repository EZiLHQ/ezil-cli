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
	it("honours the test-host hook for loopback only: a network host never receives a grant over plain http", async () => {
		const asked: string[] = [];
		const grantFor = (testHost: string) => {
			const h = io((_path, body) => { asked.push(String(body?.["host"])); return Response.json({ username: "ezil", password: GRANT, password_expiry_utc: 1_900_000_000 }); },
				memoryStore(session()));
			h.io = { ...h.io, env: { ...h.io.env, EZIL_GIT_TEST_HOST: testHost } };
			return h;
		};
		const local = grantFor("127.0.0.1:4321");
		await gitCredential(local.io, "get", "protocol=http\nhost=127.0.0.1:4321\npath=acme-3f9a1c/acme.git\n");
		expect(local.out).toContain(`password=${GRANT}`);
		expect(asked).toEqual(["github.ezil.work"]); // the grant is requested for the real host, never the test one
		for (const [testHost, input] of [
			["evil.example.com:80", "protocol=http\nhost=evil.example.com:80\npath=acme-3f9a1c/acme.git\n"],
			["10.0.0.5:8080", "protocol=http\nhost=10.0.0.5:8080\npath=acme-3f9a1c/acme.git\n"],
			["localhost.evil.com:80", "protocol=http\nhost=localhost.evil.com:80\npath=acme-3f9a1c/acme.git\n"],
			["127.0.0.1:4321", "protocol=https\nhost=127.0.0.1:4321\npath=acme-3f9a1c/acme.git\n"],
		] as const) {
			const h = grantFor(testHost);
			await gitCredential(h.io, "get", input);
			expect({ testHost, out: h.out, calls: h.calls.length }).toEqual({ testHost, out: [], calls: 0 });
		}
	});
	it("does nothing for store and erase: no grant is ever kept", async () => {
		const h = io(() => { throw new Error("must not call"); }, memoryStore(session()));
		await gitCredential(h.io, "store", `protocol=https\nhost=github.ezil.work\npassword=${GRANT}\n`);
		await gitCredential(h.io, "erase", "protocol=https\nhost=github.ezil.work\n");
		expect(h.calls).toHaveLength(0); expect(h.store.value?.accessToken).toBe("eca_a1");
	});
});
