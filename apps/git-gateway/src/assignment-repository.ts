import { AssignmentBootstrapConflict, ASSIGNMENT_REF, confirmAssignmentBootstrap } from "./assignment-bootstrap";
import { sha256Hex } from "./sign";
import type { RepoRecord, StandaloneEnv } from "./standalone";
import { PRODUCTION_GIT_ORIGIN, UNIVERSE_PRODUCTION_AUDIENCE } from "./universe-repository";

export const ASSIGNMENT_CREATE_PATH = "/v2/repos/universe/assignments";
const STAGING_AUDIENCE = "nIc7fjrC4sSThRImucnPKmPZzc1Rr0Oh";
const SAFE_SUBJECT = /^[^\s\x00-\x1f\x7f]{1,255}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_ID = /^[a-z0-9]{16}$/;
const TOKEN = /^[A-Za-z0-9._~+/=?-]{16,8192}$/;
const encoder = new TextEncoder();
type Environment = "staging" | "production";
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Registry = NonNullable<StandaloneEnv["STANDALONE_REPOS"]>;
type Artifacts = NonNullable<StandaloneEnv["ARTIFACTS"]>;

const reply = (status: number, error: string) =>
	Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

export async function verifyAssignmentProvisioning(request: Request, env: StandaloneEnv, rawBody: string,
	body: Record<string, unknown>, bearer: string, now: number) {
	const { attemptId, environment } = body;
	if (Object.keys(body).length !== 2 || typeof attemptId !== "string" || !UUID.test(attemptId) ||
		(environment !== "staging" && environment !== "production")) return reply(400, "Invalid assignment request");
	const secret = environment === "staging" ? env.UNIVERSE_ASSIGNMENT_PROVISION_STAGING_SECRET :
		env.UNIVERSE_ASSIGNMENT_PROVISION_PRODUCTION_SECRET;
	if (!secret || encoder.encode(secret).length < 32) return reply(404, "Not found");
	const timestamp = request.headers.get("x-ezil-assignment-provision-timestamp") ?? "";
	const signature = request.headers.get("x-ezil-assignment-provision-signature") ?? "";
	if (!/^[0-9]{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 || !/^[a-f0-9]{64}$/.test(signature))
		return reply(403, "Assignment service authorization required");
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	const bytes = Uint8Array.from(signature.match(/../g)!, byte => Number.parseInt(byte, 16));
	const message = `${timestamp}.POST ${ASSIGNMENT_CREATE_PATH}.${await sha256Hex(bearer)}.${rawBody}`;
	if (!(await crypto.subtle.verify("HMAC", key, bytes, encoder.encode(message))))
		return reply(403, "Assignment service authorization required");
	return { attemptId, environment: environment as Environment, audience: environment === "staging" ? STAGING_AUDIENCE : UNIVERSE_PRODUCTION_AUDIENCE };
}

/** Diagnostics only: a phase name, booleans and sanitized provider error identity. Never tokens or bodies. */
function provisionFailed(phase: string, detail: Record<string, boolean | number | string> = {}, error?: unknown) {
	let errorName = "none", errorCode = "none", message = "none";
	try {
		if (error && typeof error === "object") {
			const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
			if (typeof candidate.name === "string") errorName = candidate.name.replace(/[^A-Za-z]/g, "").slice(0, 40);
			if (typeof candidate.code === "string") errorCode = candidate.code.replace(/[^A-Z_]/g, "").slice(0, 40);
			if (typeof candidate.message === "string" && /^(Git [A-Za-z ]+|Git service refused [a-z/-]+ [0-9]{3} [A-Za-z0-9/+.-]*)$/.test(candidate.message))
				message = candidate.message;
			else if (errorName === "TypeError" && typeof candidate.message === "string")
				message = candidate.message.replace(/https?:\/\/\S+/g, "<url>").replace(/[^A-Za-z0-9 .,:'"()<>_-]/g, "").slice(0, 200);
		}
	} catch { /* An exception accessor is not a diagnostic source. */ }
	console.warn(JSON.stringify({ event: "assignment_provision_failed", phase, ...detail, errorName, errorCode, message }));
}

function providerError(error: unknown, code: string) {
	return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

export async function provisionAssignmentRepository(registry: Registry, artifacts: Artifacts,
	ownerSub: string, attemptId: string, environment: Environment, remoteBase: string, fetcher: Fetch, clock: () => number) {
	if (!SAFE_SUBJECT.test(ownerSub)) return reply(401, "EZiL ID sign-in required");
	const name = `u-${(await sha256Hex(ownerSub)).slice(0, 16)}-a-${attemptId}`;
	const repoURL = `${PRODUCTION_GIT_ORIGIN}/default/${name}.git`;
	const remote = `${remoteBase}${name}.git`;
	const description = `ezil-universe-assignment:${await sha256Hex(JSON.stringify([environment, ownerSub, attemptId]))}`;
	const repoKey = `repo:default/${name}`;
	const conflict = () => reply(409, "Assignment repository binding unavailable");
	const matches = (data: { id: string; name: string; remote: string; defaultBranch: string }) =>
		PROVIDER_ID.test(data.id) && data.name === name && data.remote === remote && data.defaultBranch === "main";

	let phase = "registry_read";
	try {
		const raw = await registry.get(repoKey);
		const record = raw === null ? undefined : JSON.parse(raw) as RepoRecord;
		const registered = raw !== null;
		if (registered && (!record || record.ownerSub !== ownerSub || record.publicRead !== false ||
			!PROVIDER_ID.test(record.providerId) || record.universeProjectId !== undefined || record.writerSubs !== undefined ||
			(record.assignmentEnvironment !== undefined && record.assignmentEnvironment !== environment))) return conflict();
		let created = false;
		// The provider description gives a failed request durable provenance without publishing an unverified repository.
		if (!registered) {
			phase = "artifacts_create";
			try {
				const data = await artifacts.create(name, { setDefaultBranch: "main", readOnly: false, description });
				if (!matches(data) || data.description !== description) {
					provisionFailed("create_mismatch", { matches: matches(data), descriptionEchoed: data.description === description,
						descriptionType: data.description === undefined ? "undefined" : data.description === null ? "null" : typeof data.description });
					return reply(503, "Repository creation unavailable");
				}
				created = true;
			} catch (error) {
				if (!providerError(error, "ALREADY_EXISTS")) throw error;
			}
		}
		phase = "artifacts_info";
		using repo = await artifacts.get(name);
		const info = await repo.info();
		if (!matches(info) || info.readOnly || (registered && info.id !== record?.providerId)) return conflict();
		// An orphan: the former OS create (`/v2/repos`) made this repository but never registered it.
		// Only the caller can own it, because `/v2/repos` prefixes every name with the creator's own
		// subject hash, and `name` above is derived from the verified caller. It carries no description
		// and is registered in the legacy shape, so later calls take the legacy path below.
		const orphan = !registered && !created && (info.description === undefined || info.description === null || info.description === "");
		if (!orphan && (!registered || record?.assignmentEnvironment !== undefined) && info.description !== description) return conflict();
		if (registered && record?.assignmentEnvironment === undefined &&
			info.description?.startsWith("ezil-universe-assignment:") && info.description !== description) return conflict();
		phase = "native_token";
		const native = await repo.createToken("write", 90);
		const now = clock();
		const expiry = Date.parse(native.expiresAt);
		if (native.scope !== "write" || !TOKEN.test(native.plaintext) || !Number.isFinite(expiry) ||
			expiry <= now || expiry > now + 100_000) {
			provisionFailed("native_token_invalid", { scopeOk: native.scope === "write", tokenShapeOk: TOKEN.test(native.plaintext),
				expiryFinite: Number.isFinite(expiry), expiryDeltaMs: Number.isFinite(expiry) ? expiry - now : -1 });
			return reply(503, "Repository creation unavailable");
		}
		phase = "bootstrap";
		const baseSha = await confirmAssignmentBootstrap(repoURL, remote, attemptId, native.plaintext, fetcher);
		phase = "registry_write";
		if (!registered) {
			const stored: RepoRecord = orphan ? { providerId: info.id, ownerSub, publicRead: false }
				: { providerId: info.id, ownerSub, publicRead: false, assignmentEnvironment: environment };
			await registry.put(repoKey, JSON.stringify(stored));
		}
		return Response.json({ attemptId, repoURL, providerId: info.id, ref: ASSIGNMENT_REF, baseSha },
			{ status: created ? 201 : 200, headers: { "cache-control": "no-store" } });
	} catch (error) {
		if (error instanceof AssignmentBootstrapConflict) {
			provisionFailed("bootstrap_conflict");
			return conflict();
		}
		provisionFailed(phase, {}, error);
		return reply(503, "Repository creation unavailable");
	}
}
