import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Pins where the production Git base URL is decided. DNS alone is not enough: the Worker's custom domains,
 * the CI smoke target and the CLI's host list must all agree that github.ezil.work is the one production
 * host, git.ezil.work a compatibility alias, and git-staging.ezil.work staging only.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
// The config has only whole-line comments, so removing those makes it plain JSON.
const wrangler = JSON.parse(read("../wrangler.jsonc").split("\n").filter(line => !line.trim().startsWith("//")).join("\n")) as {
	name: string; routes?: { pattern: string; custom_domain?: boolean }[]; workers_dev?: boolean; preview_urls?: boolean;
	env?: Record<string, { routes?: { pattern: string; custom_domain?: boolean }[]; workers_dev?: boolean }>;
};
const ci = read("../../../.github/workflows/ci.yml");

describe("Worker routes", () => {
	it("serve production on github.ezil.work first, with git.ezil.work as the only alias, both as Custom Domains", () => {
		expect(wrangler.name).toBe("ezil-git-gateway");
		expect(wrangler.routes).toEqual([{ pattern: "github.ezil.work", custom_domain: true }, { pattern: "git.ezil.work", custom_domain: true }]);
	});
	it("keep staging on git-staging.ezil.work alone, so staging can never serve a production address", () => {
		expect(Object.keys(wrangler.env ?? {})).toEqual(["staging"]);
		expect(wrangler.env!["staging"]!.routes).toEqual([{ pattern: "git-staging.ezil.work", custom_domain: true }]);
	});
	it("expose no workers.dev address anywhere", () => {
		expect(wrangler.workers_dev).not.toBe(true);
		expect(wrangler.preview_urls).not.toBe(true);
		expect(wrangler.env!["staging"]!.workers_dev).not.toBe(true);
		expect(read("../wrangler.jsonc")).not.toContain("workers.dev");
	});
});

describe("CI", () => {
	const targets = [...ci.matchAll(/EZIL_LIVE_GATEWAY(?::\s*|=)(\S+)/g)].map(m => m[1]);
	it("runs the live Git smoke against git-staging before deploying, and against github.ezil.work after; never git.ezil.work", () => {
		expect(targets.slice(0, 2)).toEqual(["git-staging.ezil.work", "github.ezil.work"]);
		expect(targets.filter(t => t === "git.ezil.work")).toEqual([]);
	});
	it("probes the production deploy on github.ezil.work and the compatibility host, and rolls back to a probe of the canonical host", () => {
		expect(ci).toContain("probe.sh https://github.ezil.work\n");
		expect(ci).toContain("probe.sh https://git.ezil.work\n");
		expect(ci).toContain("probe.sh https://github.ezil.work any");
		expect(ci).toContain("probe.sh https://git-staging.ezil.work\n");
	});
});

describe("documentation", () => {
	it("never mentions git.ezil.work without calling it the alias", () => {
		for (const file of ["../../../README.md", "../README.md", "../../../docs/ARCHITECTURE.md", "../../../docs/OPERATIONS.md"]) {
			const doc = read(file);
			for (const line of doc.split("\n").filter(l => l.includes("git.ezil.work")))
				expect({ file, line, calledAlias: /alias/i.test(line) }).toEqual({ file, line, calledAlias: true });
		}
	});
});
