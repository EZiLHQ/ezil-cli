import { sha256Hex } from "./sign";
import type { RepoRecord, StandaloneEnv } from "./standalone";

export const UNIVERSE_REPOSITORY_PATH = "/v2/repos/universe";
export const UNIVERSE_REPOSITORY_NAMESPACE = "universe-builder-production";
// Public Auth0 application identifier for the production Universe web application.
export const UNIVERSE_PRODUCTION_AUDIENCE = "2tVk0vvzQvm964BtGuXzQxpjlo2JCoCl";
export const PRODUCTION_GIT_ORIGIN = "https://github.ezil.work";
export const PRODUCTION_WORKS_ORIGIN = "https://api.ezil.work";

const ISSUER = "https://id.ezil.work/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT = /^[^\s\x00-\x1f\x7f]{1,255}$/u;
const PROVIDER_ID = /^[a-z0-9]{16}$/;

type Registry = NonNullable<StandaloneEnv["STANDALONE_REPOS"]>;
type Artifacts = NonNullable<StandaloneEnv["BUILDER_ARTIFACTS"]>;

export const isUniverseRepositoryName = (name: string) => /^up-[a-f0-9]{48}$/.test(name);
const nameFor = async (subject: string, projectId: string) =>
	`up-${(await sha256Hex(JSON.stringify([ISSUER, subject, projectId]))).slice(0, 48)}`;

const descriptionFor = async (subject: string, projectId: string) =>
	`ezil-universe-project:${await sha256Hex(JSON.stringify([ISSUER, subject, projectId, "native-repository-binding-v1"]))}`;

export async function universeRepositoryDescription(row: RepoRecord, name: string): Promise<string | null> {
	if (row.publicRead || !SUBJECT.test(row.ownerSub) ||
		typeof row.universeProjectId !== "string" || !UUID.test(row.universeProjectId) ||
		await nameFor(row.ownerSub, row.universeProjectId) !== name) return null;
	return descriptionFor(row.ownerSub, row.universeProjectId);
}

const reply = (status: number, error: string) =>
	Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

function record(raw: string): Record<string, unknown> {
	const candidate: unknown = JSON.parse(raw);
	if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid repository record");
	return candidate as Record<string, unknown>;
}

function providerError(error: unknown, code: string): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

async function repositoryInfo(artifacts: Artifacts, name: string) {
	try {
		using repository = await artifacts.get(name);
		return await repository.info();
	} catch (error) {
		if (providerError(error, "NOT_FOUND")) return null;
		throw error;
	}
}

/** The route receives the already verified production Universe subject, never a body-supplied owner. */
export async function provisionUniverseRepository(
	registry: Registry, artifacts: Artifacts, ownerSub: string, body: Record<string, unknown>, remoteBase: string,
): Promise<Response> {
	const projectId = body["projectId"];
	if (Object.keys(body).length !== 1 || typeof projectId !== "string" || !UUID.test(projectId))
		return reply(400, "Invalid project ID");
	if (!SUBJECT.test(ownerSub)) return reply(401, "EZiL ID sign-in required");

	// Regular user creation always has a u- prefix, so it cannot reserve this physical name.
	const name = await nameFor(ownerSub, projectId);
	const repoURL = `${PRODUCTION_GIT_ORIGIN}/default/${name}.git`;
	const remote = `${remoteBase}${name}.git`;
	const description = await descriptionFor(ownerSub, projectId);
	const ref = "refs/heads/main";
	const binding = { ownerSub, universeProjectId: projectId, publicRead: false };
	const repoKey = `repo:default/${name}`;
	// Workers KV limits writes per key. Keep the durable intent separate from the readable registry.
	const claimKey = `universe-project:${name}`;
	const owns = (row: Record<string, unknown>) => row["ownerSub"] === ownerSub &&
		row["universeProjectId"] === projectId && row["publicRead"] === false;
	const matchesProvider = (info: { id: string; name: string; remote: string; defaultBranch: string; description?: string | null }) =>
		PROVIDER_ID.test(info.id) && info.name === name && info.remote === remote &&
		info.defaultBranch === "main" && info.description === description;
	const answer = (providerId: string, status: number) =>
		Response.json({ projectId, repoURL, ref, providerId }, { status, headers: { "cache-control": "no-store" } });
	const conflict = () => reply(409, "Repository binding unavailable");

	try {
		const registered = await registry.get(repoKey);
		if (registered !== null) {
			const existing = record(registered);
			if (!owns(existing)) return conflict();
			const info = await repositoryInfo(artifacts, name);
			if (!info || !matchesProvider(info) || info.readOnly || info.id !== existing["providerId"]) return conflict();
			return answer(info.id, 200);
		}

		const rawClaim = await registry.get(claimKey);
		if (rawClaim === null) {
			// An unregistered pre-existing repository may belong to another provisioner. Never claim it.
			if (await repositoryInfo(artifacts, name) !== null) return conflict();
			await registry.put(claimKey, JSON.stringify(binding));
		} else if (!owns(record(rawClaim))) return conflict();

		let providerId: string;
		let status = 201;
		try {
			const created = await artifacts.create(name, { setDefaultBranch: "main", readOnly: false, description });
			if (!matchesProvider(created)) return reply(502, "Invalid Artifacts response");
			providerId = created.id;
		} catch (error) {
			if (!providerError(error, "ALREADY_EXISTS")) throw error;
			// Recovery requires the previously recorded owner/project intent and the provider’s matching provenance marker.
			const claim = await registry.get(claimKey);
			if (claim === null) return reply(503, "Repository creation unavailable");
			if (!owns(record(claim))) return conflict();
			const info = await repositoryInfo(artifacts, name);
			if (!info || !matchesProvider(info) || info.readOnly) return conflict();
			providerId = info.id;
			status = 200;
		}
		await registry.put(repoKey, JSON.stringify({ ...binding, providerId }));
		return answer(providerId, status);
	} catch {
		return reply(503, "Repository creation unavailable");
	}
}
