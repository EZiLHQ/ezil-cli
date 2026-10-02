import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionEvent } from "@ezil/cli-contract/session-evidence";

import { writeBinding } from "./binding";
import type { StoredCredentials } from "../../core/credentials";
import { flush, FLUSH_LOCK_STALE_MS, patternsInBatch, spooledSessions, takeFlushLock, type FlushResult } from "./flush";
import { appendEvent, readCursor } from "./spool";

const AT = "2026-08-19T09:00:00Z";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const TODAYS_CONTRACT = "99999999-8888-7777-6666-555555555555";

/**
 * The credential as `connect` left it -- on an EARLIER day.
 *
 * `contractPublicId` here is deliberately not today's. Contracts are daily, and
 * a flush that trusted this value would file today's transcript against the
 * contract the worker connected on, with every server-side check passing.
 */
const credentials: StoredCredentials = Object.freeze({
	accessToken: "a-bearer-that-is-never-printed",
	refreshToken: null,
	apiOrigin: "https://api.ezil.work",
	contractPublicId: "11111111-2222-3333-4444-555555555555",
	repository: "ezil/works",
});

function anEvent(index: number): SessionEvent {
	return { kind: "post_tool", at: AT, outsideRepository: false, tool: `T${index}`, exitCode: 0, bytesOut: index };
}

interface Posted {
	readonly url: string;
	readonly body: Record<string, unknown>;
	readonly authorization: string | null;
}

interface Answer {
	readonly status: number;
	readonly body: unknown;
	/** Reject instead of answering, standing in for a dropped connection. */
	readonly throws?: boolean;
}

interface Server {
	readonly call: typeof globalThis.fetch;
	readonly posted: Posted[];
	readonly seen: string[];
}

/**
 * A server that answers both endpoints a flush touches.
 *
 * `GET /v1/contracts/today` is answered from `today`, and every POST is answered
 * from `answers` in order. Keeping them apart is what lets a case say "the day
 * resolves and the POST fails" without the two interfering.
 */
function serving(answers: readonly Answer[], today: Answer = { status: 200, body: todaysBody() }): Server {
	const posted: Posted[] = [];
	const seen: string[] = [];
	let index = 0;

	const call = (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		seen.push(url);

		if (url.endsWith("/v1/contracts/today")) {
			if (today.throws === true) throw new TypeError("fetch failed");
			return new Response(JSON.stringify(today.body), {
				status: today.status,
				headers: { "content-type": "application/json" },
			});
		}

		const headers = new Headers(init?.headers);
		posted.push({
			url,
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			authorization: headers.get("authorization"),
		});

		const answer = answers[Math.min(index++, answers.length - 1)] ?? { status: 201, body: { status: "recorded" } };
		if (answer.throws === true) throw new TypeError("fetch failed");

		return new Response(JSON.stringify(answer.body), {
			status: answer.status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof globalThis.fetch;

	return { call, posted, seen };
}

function todaysBody(repository = "ezil/works"): unknown {
	return {
		contract: { publicId: TODAYS_CONTRACT, repository, businessDate: "2026-08-19" },
		frozenAt: null,
		acceptedAt: null,
	};
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ezil-flush-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("flush", () => {
	it("posts the spool to the session's own path with the bearer, and advances the cursor", async () => {
		for (let index = 0; index < 3; index++) appendEvent(root, "sess-1", anEvent(index));

		const server = serving([{ status: 201, body: { status: "recorded", segmentsFiled: 1 } }]);
		const result = await flush({ projectRoot: root, credentials, fetch: server.call });

		expect(server.posted).toHaveLength(1);
		expect(server.posted[0]?.url).toBe("https://api.ezil.work/v1/sessions/sess-1/events");
		expect(server.posted[0]?.authorization).toBe(`Bearer ${credentials.accessToken}`);
		expect(server.posted[0]?.body["spoolSequence"]).toBe(0);
		expect((server.posted[0]?.body["events"] as unknown[]).length).toBe(3);

		expect(result.outcomes).toEqual([{ kind: "filed", sessionId: "sess-1", spoolSequence: 0, status: "recorded" }]);
		expect(readCursor(root, "sess-1")).toEqual({ filed: 3, sequence: 1, pending: 0 });
		expect(result.remaining).toBe(0);
	});

	/**
	 * The stale-contract case.
	 *
	 * Every check the route makes would pass against the stored id -- the account
	 * owns that contract, its repository matches, the events are clean -- so
	 * nothing downstream would ever notice a Tuesday transcript filed under
	 * Monday's day, in an append-only table.
	 */
	it("files against TODAY's contract, not the one connect happened to see", async () => {
		appendEvent(root, "sess-1", anEvent(0));

		const server = serving([{ status: 201, body: { status: "recorded" } }]);
		await flush({ projectRoot: root, credentials, fetch: server.call });

		expect(server.seen[0]).toBe("https://api.ezil.work/v1/contracts/today");
		expect(server.posted[0]?.body["contractPublicId"]).toBe(TODAYS_CONTRACT);
		expect(server.posted[0]?.body["contractPublicId"]).not.toBe(credentials.contractPublicId);
	});

	it("sends nothing at all when today's contract cannot be resolved, and loses nothing", async () => {
		for (let index = 0; index < 2; index++) appendEvent(root, "sess-1", anEvent(index));

		const server = serving([{ status: 201, body: {} }], {
			status: 409,
			body: { error: "no_contract_today", message: "You have no work contract in force today." },
		});
		const result = await flush({ projectRoot: root, credentials, fetch: server.call });

		expect(server.posted).toEqual([]);
		expect(result.outcomes[0]?.kind).toBe("no-contract");
		expect(readCursor(root, "sess-1")).toEqual({ filed: 0, sequence: 0, pending: 0 });
		expect(result.remaining).toBe(2);
	});

	/**
	 * The half the server cannot check: a batch with no `session_start` in it
	 * carries no repository to compare, and after the first batch most do not.
	 */
	it("refuses to send a session that ran in a tree today's contract does not name", async () => {
		appendEvent(root, "sess-elsewhere", anEvent(0));
		writeBinding(root, "sess-elsewhere", {
			repository: "someone/else",
			root,
			headSha: HEAD,
			branch: "main",
			startedAtMs: 0,
		});

		const server = serving([{ status: 201, body: { status: "recorded" } }]);
		const result = await flush({ projectRoot: root, credentials, fetch: server.call });

		expect(server.posted).toEqual([]);
		const outcome = result.outcomes[0];
		expect(outcome?.kind).toBe("wrong-repository");
		if (outcome?.kind !== "wrong-repository") throw new Error("not wrong-repository");
		expect(outcome.detail).toContain("someone/else");
		expect(outcome.detail).toContain("ezil/works");

		// The positive control: the same session bound to the contracted tree is
		// sent. Without it this passes against a flush that sends nothing at all.
		writeBinding(root, "sess-elsewhere", { repository: "ezil/works", root, headSha: HEAD, branch: "main", startedAtMs: 0 });
		const second = await flush({ projectRoot: root, credentials, fetch: server.call });
		expect(second.outcomes[0]?.kind).toBe("filed");
	});

	it("treats already_recorded as filed, because that is what a resend is", async () => {
		appendEvent(root, "sess-1", anEvent(0));

		const server = serving([{ status: 200, body: { status: "already_recorded" } }]);
		const result = await flush({ projectRoot: root, credentials, fetch: server.call });

		expect(result.outcomes[0]?.kind).toBe("filed");
		expect(readCursor(root, "sess-1").filed).toBe(1);
	});

	it("leaves the spool alone when the network fails, so a day offline lands tomorrow", async () => {
		for (let index = 0; index < 2; index++) appendEvent(root, "sess-1", anEvent(index));

		const failing = serving([{ status: 0, body: null, throws: true }]);
		const result = await flush({ projectRoot: root, credentials, fetch: failing.call });

		expect(result.outcomes[0]?.kind).toBe("failed");
		expect(readCursor(root, "sess-1").filed).toBe(0);
		expect(result.remaining).toBe(2);

		// The positive control: the same spool lands as soon as the server answers.
		const working = serving([{ status: 201, body: { status: "recorded" } }]);
		const retry = await flush({ projectRoot: root, credentials, fetch: working.call });
		expect(retry.outcomes[0]?.kind).toBe("filed");
		expect(readCursor(root, "sess-1").filed).toBe(2);
	});

	/**
	 * The lost acknowledgement, end to end.
	 *
	 * The server filed sequence 0 and the answer never arrived. Two more events
	 * spool before the retry. A flush that re-cut from the live spool would post
	 * FIVE events as sequence 0, the route would answer `already_recorded`
	 * because segment 0's derived id is unchanged, and the cursor would advance
	 * past two events nobody ever sent.
	 */
	it("re-sends exactly the batch that was in flight, not whatever the spool has grown to", async () => {
		for (let index = 0; index < 3; index++) appendEvent(root, "sess-1", anEvent(index));

		const dropped = serving([{ status: 0, body: null, throws: true }]);
		await flush({ projectRoot: root, credentials, fetch: dropped.call });
		expect(readCursor(root, "sess-1")).toEqual({ filed: 0, sequence: 0, pending: 3 });

		appendEvent(root, "sess-1", anEvent(3));
		appendEvent(root, "sess-1", anEvent(4));

		const server = serving([{ status: 200, body: { status: "already_recorded" } }, { status: 201, body: { status: "recorded" } }]);
		const result = await flush({ projectRoot: root, credentials, fetch: server.call });

		expect((server.posted[0]?.body["events"] as unknown[]).length).toBe(3);
		expect(server.posted[0]?.body["spoolSequence"]).toBe(0);
		// The two that arrived meanwhile go out as their own run rather than
		// being swallowed by the first one's `already_recorded`.
		expect((server.posted[1]?.body["events"] as unknown[]).length).toBe(2);
		expect(server.posted[1]?.body["spoolSequence"]).toBe(1);

		expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(["filed", "filed"]);
		expect(readCursor(root, "sess-1")).toEqual({ filed: 5, sequence: 2, pending: 0 });
		expect(result.remaining).toBe(0);
	});

	/**
	 * The concurrent-flush case, which is `pending` defeated by a second process.
	 *
	 * `stop` spawns a flush on EVERY turn, so two overlap the moment one is slow.
	 * They pin different slices -- A pins three, B re-cuts five from the grown
	 * spool -- and B's larger batch answers `already_recorded` off segment 0's
	 * unchanged derived id, then advances the cursor past two events nobody sent.
	 *
	 * Driven as a property rather than as a race: the second flush is invoked
	 * from inside the first one's `fetch`, which is the interleaving that loses
	 * the events, made deterministic.
	 */
	it("sends nothing while another flush holds the lock", async () => {
		for (let index = 0; index < 3; index++) appendEvent(root, "sess-1", anEvent(index));

		const inner = serving([{ status: 200, body: { status: "already_recorded" } }]);
		// Collected into a const array rather than read off a `let`: TypeScript
		// does not track an assignment made inside the closure, and the variable
		// narrows to `null` at the assertion below.
		const innerOutcomes: string[] = [];
		let innerRan = false;

		const outer = serving([{ status: 201, body: { status: "recorded" } }]);
		const interleaving = (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

			if (!url.endsWith("/v1/contracts/today") && !innerRan) {
				// The spool grows while the first request is in flight, exactly as
				// it does when another turn ends mid-flush.
				appendEvent(root, "sess-1", anEvent(3));
				appendEvent(root, "sess-1", anEvent(4));
				innerRan = true;
				const nested: FlushResult = await flush({ projectRoot: root, credentials, fetch: inner.call });
				innerOutcomes.push(...nested.outcomes.map((outcome) => outcome.kind));
			}

			return outer.call(input, init);
		}) as typeof globalThis.fetch;

		const result = await flush({ projectRoot: root, credentials, fetch: interleaving });

		// The second run sent nothing at all -- not a smaller batch, nothing.
		expect(inner.posted).toEqual([]);
		expect(innerOutcomes).toEqual(["already-running"]);

		// And the first run filed exactly the three it pinned, so the two events
		// that arrived meanwhile are still spooled rather than skipped over.
		expect((outer.posted[0]?.body["events"] as unknown[]).length).toBe(3);
		expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(["filed"]);
		expect(readCursor(root, "sess-1")).toEqual({ filed: 3, sequence: 1, pending: 0 });
		expect(result.remaining).toBe(2);
	});

	it("releases the lock even when the run fails, so the next flush is not wedged", async () => {
		appendEvent(root, "sess-1", anEvent(0));

		const failing = serving([{ status: 0, body: null, throws: true }]);
		await flush({ projectRoot: root, credentials, fetch: failing.call });

		// The positive control for the lock: it is gone, so this succeeds.
		expect(takeFlushLock(root, Date.now())).toBe(true);
	});

	it("takes over a lock old enough to belong to a dead process", () => {
		const started = 1_800_000_000_000;

		expect(takeFlushLock(root, started)).toBe(true);
		expect(takeFlushLock(root, started + 1000)).toBe(false);
		expect(takeFlushLock(root, started + FLUSH_LOCK_STALE_MS + 1000)).toBe(true);
	});

	/**
	 * Before the day was resolved before the first POST, an expired bearer
	 * reported as "no contract today" -- which tells a worker to agree a day they
	 * have already agreed, and never mentions the one thing that would fix it.
	 */
	it("says the bearer was refused, not that there is no contract, when the day fetch answers 401", async () => {
		appendEvent(root, "sess-1", anEvent(0));

		const server = serving([{ status: 201, body: {} }], { status: 401, body: { error: "unauthorized" } });
		const result = await flush({ projectRoot: root, credentials, fetch: server.call });

		const outcome = result.outcomes[0];
		expect(outcome?.kind).toBe("unauthorised");
		if (outcome?.kind !== "unauthorised") throw new Error("not unauthorised");
		expect(outcome.sessionId).toBeNull();
		expect(outcome.detail).toContain("ezil connect");

		// The positive control: a 409 is still reported as no contract today.
		const noDay = serving([{ status: 201, body: {} }], {
			status: 409,
			body: { error: "no_contract_today", message: "You have no work contract in force today." },
		});
		const second = await flush({ projectRoot: root, credentials, fetch: noDay.call });
		expect(second.outcomes[0]?.kind).toBe("no-contract");

		expect(server.posted).toEqual([]);
		expect(readCursor(root, "sess-1").filed).toBe(0);
	});

	it("leaves the spool alone on a server fault, which is NOT a secret refusal", async () => {
		appendEvent(root, "sess-1", anEvent(0));

		// 500 with no `secret_withheld` code: a database briefly down. Quarantining
		// on the status alone would throw away a day's work for an outage.
		const server = serving([{ status: 500, body: { error: "internal", message: "no" } }]);
		const result = await flush({ projectRoot: root, credentials, fetch: server.call });

		expect(result.outcomes[0]?.kind).toBe("failed");
		expect(readCursor(root, "sess-1").filed).toBe(0);
		expect(existsSync(join(root, ".ezil", "quarantine"))).toBe(false);
	});

	it("quarantines a batch the server refused as carrying a credential, and names the pattern", async () => {
		appendEvent(root, "sess-1", {
			kind: "post_tool",
			at: AT,
			outsideRepository: false,
			tool: "Bash",
			exitCode: 0,
			bytesOut: 20,
			excerpt: "AKIAIOSFODNN7EXAMPLE",
		});

		const server = serving([{ status: 500, body: { error: "secret_withheld", message: "refused" } }]);
		const result = await flush({ projectRoot: root, credentials, fetch: server.call });

		const outcome = result.outcomes[0];
		expect(outcome?.kind).toBe("quarantined");
		if (outcome?.kind !== "quarantined") throw new Error("not quarantined");

		expect(outcome.patterns).toEqual(["aws-access-key-id"]);
		expect(existsSync(outcome.file)).toBe(true);
		expect(JSON.parse(readFileSync(outcome.file, "utf8"))["spoolSequence"]).toBe(0);

		// The cursor advanced past it: the server refuses it every time by
		// construction, so retrying is a loop.
		expect(readCursor(root, "sess-1").filed).toBe(1);
	});

	it("stops on a refused bearer and says there is no refresh route to try", async () => {
		appendEvent(root, "sess-1", anEvent(0));

		const server = serving([{ status: 401, body: { error: "unauthorized" } }]);
		const result = await flush({ projectRoot: root, credentials, fetch: server.call });

		const outcome = result.outcomes[0];
		expect(outcome?.kind).toBe("unauthorised");
		if (outcome?.kind !== "unauthorised") throw new Error("not unauthorised");
		expect(outcome.detail).toContain("ezil connect");
		expect(readCursor(root, "sess-1").filed).toBe(0);
	});

	it("sends each session's spool separately, under its own sequence", async () => {
		appendEvent(root, "sess-a", anEvent(0));
		appendEvent(root, "sess-b", anEvent(1));

		const server = serving([{ status: 201, body: { status: "recorded" } }]);
		await flush({ projectRoot: root, credentials, fetch: server.call });

		expect(server.posted.map((post) => post.url)).toEqual([
			"https://api.ezil.work/v1/sessions/sess-a/events",
			"https://api.ezil.work/v1/sessions/sess-b/events",
		]);
		expect(server.posted.every((post) => post.body["spoolSequence"] === 0)).toBe(true);
	});

	it("does nothing at all when nothing is connected", async () => {
		appendEvent(root, "sess-1", anEvent(0));

		const server = serving([{ status: 201, body: {} }]);
		const result = await flush({
			projectRoot: root,
			credentials: null,
			fetch: server.call,
			environment: { EZIL_HOME: join(root, "home") },
		});

		expect(server.posted).toEqual([]);
		expect(result.outcomes).toEqual([]);
	});
});

describe("spooledSessions", () => {
	it("lists the sessions with a spool, and nothing when there are none", () => {
		expect(spooledSessions(root)).toEqual([]);
		appendEvent(root, "sess-b", anEvent(0));
		appendEvent(root, "sess-a", anEvent(0));
		expect(spooledSessions(root)).toEqual(["sess-a", "sess-b"]);
	});
});

describe("patternsInBatch", () => {
	it("names what fired, and nothing for an ordinary batch", () => {
		expect(patternsInBatch([anEvent(0)])).toEqual([]);
		expect(
			patternsInBatch([
				{ kind: "pre_tool", at: AT, outsideRepository: false, tool: "Bash", command: "cat .env" },
			]),
		).toEqual(["dotenv-read"]);
	});
});
