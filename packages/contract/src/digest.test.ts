import { expect, it } from "bun:test";

import * as cliApi from "./cli-api";
import { contractDigest } from "./digest";
import * as gitGateway from "./git-gateway";
import * as sessionEvidence from "./session-evidence";

/**
 * The pinned wire contract between the EZiL CLI (and its github.ezil.work gateway) and the EZiL Works API.
 *
 * EZiL Works pins the same three values. A failure here means this copy changed: make the identical change in
 * EZiL-Works `packages/contracts/src/surface/` (same file, same zod version), then update the constant in both
 * repositories in the same change window. The zod version is part of the digest on purpose: two zod releases
 * validate `iso.datetime()` differently, and that is a wire difference.
 */
export const EZIL_CLI_CONTRACT_DIGESTS = {
	gitGateway: "a4ca013e9511dc9aad12d344b0a804a88a0d4dc7503206704224f0d9e3b51a44",
	sessionEvidence: "9154d50b67ce7116ce8e9528b94395a5adb38bdb3f2aca220908d66b999f5d36",
	cliApi: "5fba79cadbcab8f9f1560b754a9fff7654f896b8a5fd626b5f44c1e1aec690f7",
} as const;

it("matches the digests EZiL Works pins", () => {
	expect({
		gitGateway: contractDigest(gitGateway),
		sessionEvidence: contractDigest(sessionEvidence),
		cliApi: contractDigest(cliApi),
	}).toEqual(EZIL_CLI_CONTRACT_DIGESTS);
});
