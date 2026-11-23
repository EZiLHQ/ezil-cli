import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ASSIGNMENT_CREATE_PATH, verifyAssignmentProvisioning } from "./assignment-repository";
import { sha256Hex } from "./sign";

/**
 * The wire contract shared with EZiL Universe. Universe keeps a byte-identical copy at
 * core/tests/Fixtures/git-gateway/assignment-provision.vectors.json and pins the same digest,
 * so a change on either side fails both suites until the copies agree again.
 */
const FILE = new URL("./assignment-provision.vectors.json", import.meta.url);
const DIGEST = "a58fb0ef8b35638142ab44006da3fb849350e79ac462de4c545016ce6cf47dea";
const raw = readFileSync(FILE);
const contract = JSON.parse(raw.toString("utf8"));
const v = contract.vector;
const STAGING_AUDIENCE = "nIc7fjrC4sSThRImucnPKmPZzc1Rr0Oh";

const request = (body = v.body, signature = v.signature) => new Request(contract.request.origin + contract.request.path, {
	method: "POST", body, headers: { authorization: "Bearer " + v.token, "content-type": "application/json",
		[contract.request.headers.timestampHeader]: v.timestamp, [contract.request.headers.signatureHeader]: signature },
});
const verify = (env: Record<string, string>, body = v.body, signature = v.signature, now = Number(v.timestamp)) =>
	verifyAssignmentProvisioning(request(body, signature), env, body, JSON.parse(body), v.token, now);
const sign = async (body: string) => {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(v.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const message = `${v.timestamp}.POST ${ASSIGNMENT_CREATE_PATH}.${await sha256Hex(v.token)}.${body}`;
	return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))),
		byte => byte.toString(16).padStart(2, "0")).join("");
};

it("pins the shared contract file", async () => {
	expect(await sha256Hex(raw.toString("utf8"))).toBe(DIGEST);
	expect(contract.request.path).toBe(ASSIGNMENT_CREATE_PATH);
	expect(await sha256Hex(v.token)).toBe(v.bearerSha256);
	expect(v.signingString).toBe(`${v.timestamp}.POST ${ASSIGNMENT_CREATE_PATH}.${v.bearerSha256}.${v.body}`);
	expect(await sign(v.body)).toBe(v.signature);
	expect(Object.keys(contract.reply.body).sort()).toEqual(["attemptId", "baseSha", "providerId", "ref", "repoURL"]);
});

it("accepts exactly the vector and refuses any changed byte", async () => {
	const env = { UNIVERSE_ASSIGNMENT_PROVISION_STAGING_SECRET: v.secret };
	expect(await verify(env)).toEqual({ attemptId: JSON.parse(v.body).attemptId, environment: "staging", audience: STAGING_AUDIENCE });
	const changed = v.body.replace("}", " }");
	expect((await verify(env, changed) as Response).status).toBe(403);
	expect((await verify(env, v.body, v.signature.replace(/.$/, (c: string) => c === "0" ? "1" : "0")) as Response).status).toBe(403);
	expect((await verify(env, v.body, v.signature, Number(v.timestamp) + contract.request.maxClockSkewMs + 1) as Response).status).toBe(403);
});

it("keeps staging and production keys apart in both directions", async () => {
	expect((await verify({ UNIVERSE_ASSIGNMENT_PROVISION_PRODUCTION_SECRET: v.secret }) as Response).status).toBe(404);
	const production = v.body.replace("staging", "production");
	expect((await verify({ UNIVERSE_ASSIGNMENT_PROVISION_STAGING_SECRET: v.secret }, production, await sign(production)) as Response).status).toBe(404);
	expect((await verify({ UNIVERSE_ASSIGNMENT_PROVISION_PRODUCTION_SECRET: v.secret }, production, await sign(production)) as { environment: string }).environment)
		.toBe("production");
});
