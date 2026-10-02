import { expect, it } from "bun:test";

import * as cliApi from "./cli-api";
import { contractDigest } from "./digest";
import * as gitGateway from "./git-gateway";
import * as sessionEvidence from "./session-evidence";

/**
 * The pinned wire contract between the EZiL CLI (and its github.ezil.work gateway) and the EZiL Works API.
 *
 * The EZiL Works repository pins the same three values. A failure means this copy changed:
 * make the identical change in that repository using the same zod version, then update both
 * constants in the same change window. Zod versions can validate `iso.datetime()` differently,
 * so the version affects wire compatibility.
 *
 * What this does NOT do: compare the two repositories. Each side checks only its own copy against its own constant,
 * so a change re-pinned on one side alone passes here. Cross-repository compatibility is proven at runtime instead:
 * the deployed gateway parses every production authorize answer with the strict schema, and the EZiL CLI live E2E
 * parses the real /cli answers with cli-api.ts. Re-pinning without the matching change on the other side is a review
 * failure this test cannot catch. Refinements (`.refine`) and pure type changes are invisible to the digest.
 */
export const EZIL_CLI_CONTRACT_DIGESTS = {
	gitGateway: "21fb1e2edba04e02e04a5442bef5e34a7ba6159b03917fc8127e1e1f929776b1",
	sessionEvidence: "0913dfeb44dd3fd95b40e262475a6f8faad982a127be6840d039f40535b3ca98",
	cliApi: "27ac2e3a9d2d4a12e9b836a79f91e56cd1aa521c8dda0dc58ce0db88d758cfb3",
} as const;

it("matches the digests EZiL Works pins", () => {
	expect({
		gitGateway: contractDigest(gitGateway),
		sessionEvidence: contractDigest(sessionEvidence),
		cliApi: contractDigest(cliApi),
	}).toEqual(EZIL_CLI_CONTRACT_DIGESTS);
});
