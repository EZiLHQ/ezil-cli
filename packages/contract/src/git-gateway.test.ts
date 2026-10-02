import { describe, expect, it } from "bun:test";
import { GIT_DENY_MESSAGES, GIT_DENY_REASONS, GIT_GRANT_PATTERN, GitAuthorizeAllowSchema, GitAuthorizeRequestSchema,
	parseGitRoutePath, scopeForService } from "./git-gateway";

describe("parseGitRoutePath", () => {
	it("accepts exactly the smart-HTTP paths, and the bare repo path", () => {
		expect(parseGitRoutePath("/acme-erp-3f9a1c/acme-erp.git/info/refs")).toEqual({ routeNamespace: "acme-erp-3f9a1c", routeName: "acme-erp", rest: "/info/refs" });
		expect(parseGitRoutePath("/acme-erp-3f9a1c/api.v2.git/git-upload-pack")?.routeName).toBe("api.v2");
		expect(parseGitRoutePath("/acme-erp-3f9a1c/api.git/git-receive-pack")?.rest).toBe("/git-receive-pack");
		expect(parseGitRoutePath("/acme-erp-3f9a1c/api.git")?.rest).toBe("");
	});

	it("refuses every path trick before it reaches a lookup", () => {
		for (const path of [
			"/acme/../other/api.git/info/refs", "/acme/a..b.git/info/refs", "/acme/api.git.git/info/refs",
			"/Acme/api.git/info/refs", "/acme/API.git/info/refs", "/acme/api%2Fx.git/info/refs", "/acme/api.git/objects/info/packs",
			"/acme/api.git/info/refs/", "//acme/api.git/info/refs", "/acme/api/info/refs", "/-acme/api.git/info/refs",
			"/acme/.api.git/info/refs", "/acme/api.git/HEAD", "/acme/api.git/info/refs?x", "/acme/api.git/../../etc",
		]) expect(parseGitRoutePath(path)).toBeNull();
	});
});

it("maps only receive-pack to write", () => {
	expect(scopeForService("git-upload-pack")).toBe("read");
	expect(scopeForService("git-receive-pack")).toBe("write");
});

it("accepts only a well-formed grant and a hashed IP", () => {
	const base = { grant: `egg_${"a".repeat(64)}`, routeNamespace: "acme", routeName: "api", service: "git-upload-pack",
		requestId: crypto.randomUUID(), cfRay: null, ipHash: "b".repeat(64) };
	expect(GitAuthorizeRequestSchema.safeParse(base).success).toBe(true);
	expect(GitAuthorizeRequestSchema.safeParse({ ...base, grant: "art_v1_" + "f".repeat(40) }).success).toBe(false);
	expect(GitAuthorizeRequestSchema.safeParse({ ...base, ipHash: "10.0.0.1" }).success).toBe(false);
	expect(GitAuthorizeRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
	expect(GIT_GRANT_PATTERN.test(`egg_${"A".repeat(64)}`)).toBe(false);
});

it("refuses an upstream that is not an Artifacts remote", () => {
	const allow = { decision: "allow", artifactsToken: "art_v1_x", scope: "read", expiresAt: new Date().toISOString(), operationId: null };
	expect(GitAuthorizeAllowSchema.safeParse({ ...allow, artifactsRemote: `https://${"0".repeat(32)}.artifacts.cloudflare.net/git/p-x/source.git` }).success).toBe(true);
	expect(GitAuthorizeAllowSchema.safeParse({ ...allow, artifactsRemote: "https://evil.example/git/p-x/source.git" }).success).toBe(false);
	expect(GitAuthorizeAllowSchema.safeParse({ ...allow, artifactsRemote: `http://${"0".repeat(32)}.artifacts.cloudflare.net/git/p-x/source.git` }).success).toBe(false);
});

it("has a builder-safe sentence for every deny reason", () => {
	for (const reason of GIT_DENY_REASONS) expect(GIT_DENY_MESSAGES[reason]).toMatch(/^EZiL: /);
});
