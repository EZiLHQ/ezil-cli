import { unzlibSync } from "fflate";

export const ASSIGNMENT_REF = "refs/heads/main";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const zero = "0".repeat(40);
const AUTHOR = "EZiL OS <noreply@ezil.work> 0 +0000";
const MAX_REPLY = 65_536;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const all = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		all.set(part, offset);
		offset += part.length;
	}
	return all;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const sha1 = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
const pkt = (line: string) => {
	const payload = encoder.encode(line);
	return concat(encoder.encode((payload.length + 4).toString(16).padStart(4, "0")), payload);
};

const TYPES = { commit: 1, tree: 2, blob: 3 } as const;
type Kind = keyof typeof TYPES;
type GitObject = { kind: Kind; contents: Uint8Array<ArrayBuffer>; sha: Uint8Array<ArrayBuffer> };
async function gitObject(kind: Kind, contents: Uint8Array<ArrayBuffer>): Promise<GitObject> {
	const sha = await sha1(concat(encoder.encode(`${kind} ${contents.length}\0`), contents));
	return { kind, contents, sha };
}
const entry = (mode: string, path: string, object: GitObject) => concat(encoder.encode(`${mode} ${path}\0`), object.sha);

async function bootstrap(repoURL: string, attemptId: string) {
	const notice = "Do not edit, modify, or delete this assignment marker. EZiL Code records disclosed assignment activity and shows recording status. Interruptions may affect submission.";
	const marker = JSON.stringify({ schema: "ezil.assignment/v2", recorder: "assignment-recorder-v1", repositoryUrl: repoURL,
		consentVersion: 3, notice, preload: { protocol: "ezil.assignment-open/v1", trigger: "repo-open", host: "127.0.0.1", port: 5679 } });
	const markerBlob = await gitObject("blob", encoder.encode(marker + "\n"));
	const readmeBlob = await gitObject("blob", encoder.encode("# EZiL assignment\n\nThis repository holds an EZiL assignment. Keep `.ezil/assignment.json` unchanged.\n"));
	const directory = await gitObject("tree", entry("100644", "assignment.json", markerBlob));
	const root = await gitObject("tree", concat(entry("40000", ".ezil", directory), entry("100644", "README.md", readmeBlob)));
	const commit = await gitObject("commit", encoder.encode(
		`tree ${hex(root.sha)}\nauthor ${AUTHOR}\ncommitter ${AUTHOR}\n\nInitialize EZiL assignment ${attemptId}\n`));
	return { sha: hex(commit.sha), tree: hex(root.sha), objects: [commit, root, directory, markerBlob, readmeBlob] };
}

async function pack(objects: GitObject[]) {
	const header = new Uint8Array(12);
	header.set(encoder.encode("PACK"));
	const size = new DataView(header.buffer);
	size.setUint32(4, 2);
	size.setUint32(8, objects.length);
	const compressed = await Promise.all(objects.map(async ({ kind, contents }) => {
		let length = contents.length;
		const typeAndSize = [(TYPES[kind] << 4) | (length & 0x0f)];
		for (length >>= 4; length; length >>= 7) {
			typeAndSize[typeAndSize.length - 1]! |= 0x80;
			typeAndSize.push(length & 0x7f);
		}
		const stream = new Blob([contents]).stream().pipeThrough(new CompressionStream("deflate"));
		return concat(new Uint8Array(typeAndSize), new Uint8Array(await new Response(stream).arrayBuffer()));
	}));
	const body = concat(header, ...compressed);
	return concat(body, await sha1(body));
}

async function boundedReply(response: Response) {
	const stream = response.body?.getReader();
	if (!stream) throw new Error("Git response missing");
	const data = new Uint8Array(MAX_REPLY);
	let offset = 0;
	try {
		for (;;) {
			const { done, value } = await stream.read();
			if (done) return data.subarray(0, offset);
			if (offset + value.length > MAX_REPLY) throw new Error("Git response too long");
			data.set(value, offset);
			offset += value.length;
		}
	} finally {
		void stream.cancel().catch(() => {});
		stream.releaseLock();
	}
}

function parseAdvertisement(data: Uint8Array, service: string) {
	const refs = new Map<string, string>();
	const caps = new Set<string>();
	let offset = 0;
	let sawFlush = false;
	let first = true;
	while (offset < data.length) {
		const rawLength = decoder.decode(data.subarray(offset, offset + 4));
		if (!/^[a-f0-9]{4}$/.test(rawLength)) throw new Error("Git packet length invalid");
		const length = Number.parseInt(rawLength, 16);
		if (length === 0) {
			offset += 4;
			sawFlush = true;
			continue;
		}
		if (length < 4 || offset + length > data.length) throw new Error("Git packet invalid");
		const line = decoder.decode(data.subarray(offset + 4, offset + length)).replace(/\n$/, "");
		offset += length;
		sawFlush = false;
		if (line === `# service=${service}` && first) continue;
		const [ref, capabilities, unexpected] = line.split("\0");
		const parsed = /^([a-f0-9]{40}) (\S+)$/.exec(ref ?? "");
		if (!parsed || unexpected !== undefined || (!first && capabilities !== undefined)) throw new Error("Git refs invalid");
		for (const capability of capabilities?.split(" ") ?? []) {
			if (capability.startsWith("object-format=") && capability !== "object-format=sha1") throw new Error("Git object format invalid");
			if (capability) caps.add(capability);
		}
		const oid = parsed[1]!;
		const name = parsed[2]!;
		if (!(name === "capabilities^{}" && oid === zero && first)) {
			if (oid === zero || refs.has(name)) throw new Error("Git ref invalid");
			refs.set(name, oid);
		}
		first = false;
	}
	if (!sawFlush) throw new Error("Git refs incomplete");
	return { refs, caps };
}

export class AssignmentBootstrapConflict extends Error {}

/** The former OS bootstrap used an attempt-time date. Confirm the exact same root tree without rewriting it. */
async function matchesLegacyBootstrappedHead(response: Uint8Array<ArrayBuffer>, head: string, tree: string, attemptId: string) {
	if (decoder.decode(response.subarray(0, 8)) !== "0008NAK\n") return false;
	const body = response.subarray(8);
	if (body.length < 33 || decoder.decode(body.subarray(0, 4)) !== "PACK") return false;
	const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
	if (![2, 3].includes(header.getUint32(4)) || header.getUint32(8) !== 5 ||
		hex(await sha1(body.subarray(0, -20))) !== hex(body.subarray(-20))) return false;
	let next = body[12]!;
	if (((next >> 4) & 7) !== TYPES.commit) return false;
	let size = next & 15;
	let offset = 13;
	if (next & 128) {
		next = body[offset++]!;
		size += (next & 127) << 4;
		if (next & 128) return false;
	}
	if (size === 0 || size > 1024) return false;
	try {
		const content = unzlibSync(body.subarray(offset, -20), { out: new Uint8Array(size) });
		if (content.length !== size || hex((await gitObject("commit", new Uint8Array(content))).sha) !== head) return false;
		const lines = decoder.decode(content).split("\n");
		const author = /^author (EZiL OS <noreply@ezil[.]work> [0-9]{1,13} [+]0000)$/.exec(lines[1] ?? "");
		return lines.length === 6 && lines[0] === `tree ${tree}` && author !== null &&
			lines[2] === `committer ${author[1]}` && lines[3] === "" &&
			lines[4] === `Initialize EZiL assignment ${attemptId}` && lines[5] === "";
	} catch {
		return false;
	}
}

/** Read back provider state even when a create-only push reports an ambiguous result. */
export async function confirmAssignmentBootstrap(repoURL: string, remote: string, attemptId: string, token: string, fetcher: Fetch) {
	const initial = await bootstrap(repoURL, attemptId);
	const signal = AbortSignal.timeout(20_000);
	const headers = { authorization: `Bearer ${token}` };
	async function git(path: string, expected: string, init: RequestInit = {}) {
		const response = await fetcher(`${remote}/${path}`, { ...init, signal, redirect: "manual",
			headers: { ...headers, ...init.headers } });
		const type = response.headers.get("content-type")?.split(";")[0]?.trim();
		if (response.status !== 200 || type !== expected) {
			void response.body?.cancel().catch(() => {});
			const safeType = (type ?? "none").replace(/[^a-z0-9/+.-]/gi, "").slice(0, 80);
			throw new Error(`Git service refused ${path.split("?")[0]} ${response.status} ${safeType}`);
		}
		return boundedReply(response);
	}
	const advertise = async (service: "git-receive-pack" | "git-upload-pack") =>
		parseAdvertisement(await git(`info/refs?service=${service}`, `application/x-${service}-advertisement`), service);
	const before = await advertise("git-receive-pack");
	if (before.refs.size === 0) {
		const capability = before.caps.has("report-status") ? "\0report-status" : "";
		const command = pkt(`${zero} ${initial.sha} ${ASSIGNMENT_REF}${capability}\n`);
		const body = concat(command, encoder.encode("0000"), await pack(initial.objects));
		try {
			await git("git-receive-pack", "application/x-git-receive-pack-result", {
				method: "POST", body, headers: { "content-type": "application/x-git-receive-pack-request" },
			});
		} catch {
			// A timeout can follow a committed push. A concurrent request can also seed the same commit.
		}
	}
	const { refs } = await advertise("git-upload-pack");
	const head = refs.get(ASSIGNMENT_REF);
	if (!head) {
		if (refs.size) throw new AssignmentBootstrapConflict();
		throw new Error("Git ref not yet visible");
	}
	if ([...refs].some(([key, oid]) => (key !== "HEAD" && key !== ASSIGNMENT_REF) || oid !== head))
		throw new AssignmentBootstrapConflict();
	if (head !== initial.sha) {
		const request = concat(pkt(`want ${head}\n`), encoder.encode("0000"), pkt("done\n"));
		const response = await git("git-upload-pack", "application/x-git-upload-pack-result", {
			method: "POST", body: request, headers: { "content-type": "application/x-git-upload-pack-request" },
		});
		if (!(await matchesLegacyBootstrappedHead(response, head, initial.tree, attemptId))) throw new AssignmentBootstrapConflict();
	}
	return head;
}
