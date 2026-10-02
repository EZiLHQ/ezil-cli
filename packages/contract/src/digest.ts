import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * A canonical digest of a contract module: every export, by name, in a stable rendering.
 *
 * Zod schemas render as JSON Schema (input and output), regular expressions as source and flags, functions as whitespace-normalised
 * source, everything else as JSON. The EZiL Works repository keeps a copy of these contract files
 * and pins the same digests as `digest.test.ts` here. Changing either copy fails its local test
 * until the constant is updated (see the test for what that does not prove).
 */
export function contractDigest(module: Record<string, unknown>): string {
	const render = (value: unknown): unknown => {
		// Duck-typed, not `instanceof`: each repository resolves its own zod, and the digest must not depend on which.
		// Both directions: output-mode JSON Schema renders strict and stripping objects alike (additionalProperties
		// false); input mode tells strict, strip and loose apart, so dropping a `.strict()` changes the digest.
		if (value && typeof value === "object" && "_zod" in value) return {
			input: z.toJSONSchema(value as z.ZodType, { io: "input", unrepresentable: "any" }),
			output: z.toJSONSchema(value as z.ZodType, { unrepresentable: "any" }),
		};
		if (value instanceof RegExp) return { regexp: value.source, flags: value.flags };
		if (typeof value === "function") return { fn: value.toString().replace(/\s+/g, " ").trim() };
		return value;
	};
	const canonical = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
		return value;
	};
	const rendered = Object.fromEntries(Object.keys(module).sort().map(name => [name, canonical(render(module[name]))]));
	return createHash("sha256").update(JSON.stringify(rendered)).digest("hex");
}
