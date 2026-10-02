import { describe, expect, it } from "bun:test";

import { excerptOf, redact, redactionsIn, REDACTED } from "./redact";

/**
 * The hook's redaction, held to the same vectors as the server's refusal.
 *
 * `apps/api/src/routes/sessions.test.ts` runs this same table against
 * `secretPatternsIn`. The two implementations are deliberately separate -- see
 * `redact.ts` -- and the tables being the same is what keeps them honest: a
 * pattern added on one side and not the other shows up as a vector that the
 * server refuses and the hook did not strip.
 */

const vectors: readonly { readonly name: string; readonly text: string; readonly pattern: string }[] = [
	{ name: "an OpenAI-shaped key", text: "export KEY=sk-proj-A1b2C3d4E5f6G7h8I9j0", pattern: "api-key" },
	{ name: "an Anthropic-shaped key", text: "sk-ant-api03-AbCdEfGhIjKlMnOpQrSt", pattern: "api-key" },
	{ name: "a GitHub personal token", text: "ghp_16C7e42F292c6912E7710c838347Ae178B4a", pattern: "github-token" },
	{ name: "a GitHub server token", text: "ghs_16C7e42F292c6912E7710c838347Ae178B4a", pattern: "github-token" },
	{ name: "an AWS access key id", text: "AKIAIOSFODNN7EXAMPLE", pattern: "aws-access-key-id" },
	{
		name: "a JWT",
		text: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		pattern: "jwt",
	},
	{
		name: "a PEM private key",
		text: "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----",
		pattern: "private-key",
	},
	{ name: "a wholesale dotenv read", text: "cat apps/api/.env", pattern: "dotenv-read" },
];

describe("redact", () => {
	for (const vector of vectors) {
		it(`names and removes ${vector.name}`, () => {
			expect(redactionsIn(vector.text)).toContain(vector.pattern);

			const cleaned = redact(vector.text);
			expect(cleaned).toContain(REDACTED);
			// The value itself is gone, not merely flagged.
			expect(redactionsIn(cleaned)).toEqual([]);
		});
	}

	/**
	 * The control the whole list is worth nothing without.
	 *
	 * Every string here is ordinary session text carrying a fragment of one of
	 * the shapes above. A redactor that fired on these would mangle honest work,
	 * the hook would be uninstalled, and the real rule would go with it.
	 */
	it("leaves ordinary session text exactly as it was", () => {
		const ordinary = [
			"bun run --filter '*' typecheck",
			"git commit -m 'sk is a Slovak locale, not a key'",
			"read the .env.example and copy it",
			"cp .env.example .env",
			"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
			"AKIA is a prefix; ASIAN is a word",
			"the ghost_writer module",
			"-----BEGIN CERTIFICATE-----",
			"./tools/test.sh apps/api packages/cli",
		];

		for (const text of ordinary) {
			expect(redactionsIn(text)).toEqual([]);
			expect(redact(text)).toBe(text);
		}
	});

	it("removes the whole PEM block, not only its header", () => {
		const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKsecretbody\n-----END RSA PRIVATE KEY-----";
		const cleaned = redact(`before\n${key}\nafter`);

		expect(cleaned).toContain("before");
		expect(cleaned).toContain("after");
		expect(cleaned).not.toContain("MIIBOgIBAAJBAKsecretbody");
	});

	it("replaces every occurrence, not only the first", () => {
		const twice = "sk-proj-A1b2C3d4E5f6G7h8I9j0 and sk-proj-Z9y8X7w6V5u4T3s2R1q0";
		const cleaned = redact(twice);

		expect(cleaned).toBe(`${REDACTED} and ${REDACTED}`);
	});
});

describe("excerptOf", () => {
	it("keeps a short output whole", () => {
		expect(excerptOf("120 pass, 0 fail")).toBe("120 pass, 0 fail");
	});

	it("keeps the first and the last of a long one, and says how much it dropped", () => {
		const text = `${"A".repeat(5000)}${"M".repeat(5000)}${"Z".repeat(5000)}`;
		const excerpt = excerptOf(text, 4096);

		expect(excerpt.startsWith("A".repeat(100))).toBe(true);
		expect(excerpt.endsWith("Z".repeat(100))).toBe(true);
		expect(excerpt).toContain("characters elided");
		// The middle is gone: a symptom, not a file.
		expect(excerpt).not.toContain("M".repeat(4097));
	});

	it("redacts each surviving half, so nothing is carried by the elision", () => {
		const text = `head sk-proj-A1b2C3d4E5f6G7h8I9j0 ${"x".repeat(20000)} tail ghp_16C7e42F292c6912E7710c838347Ae178B4a`;
		const excerpt = excerptOf(text, 4096);

		expect(redactionsIn(excerpt)).toEqual([]);
		expect(excerpt).toContain(REDACTED);
	});
});
