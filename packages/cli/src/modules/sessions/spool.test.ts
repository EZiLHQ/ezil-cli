import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionEvent } from "@ezil/cli-contract/session-evidence";

import { spoolPath } from "../../core/paths";
import { appendEvent, MAX_BATCH_EVENTS, pendingBatches, readCursor, readSpool, writeCursor } from "./spool";

const AT = "2026-08-19T09:00:00Z";

function anEvent(index: number): SessionEvent {
	return { kind: "post_tool", at: AT, outsideRepository: false, tool: `T${index}`, exitCode: 0, bytesOut: index };
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ezil-spool-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("the spool", () => {
	it("appends one line per event, in order, and reads them back", () => {
		appendEvent(root, "s1", anEvent(1));
		appendEvent(root, "s1", anEvent(2));

		const lines = readFileSync(spoolPath(root, "s1"), "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);

		const events = readSpool(root, "s1");
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual(anEvent(1));
		expect(events[1]).toEqual(anEvent(2));
	});

	it("keeps two sessions apart", () => {
		appendEvent(root, "s1", anEvent(1));
		appendEvent(root, "s2", anEvent(2));

		expect(readSpool(root, "s1")).toHaveLength(1);
		expect(readSpool(root, "s2")).toHaveLength(1);
	});

	it("is empty for a session that has never spooled", () => {
		expect(readSpool(root, "never")).toEqual([]);
	});

	/**
	 * A hook is a process that can die mid-append. One torn line must not cost
	 * the day: it is skipped, and everything on either side of it survives.
	 */
	it("skips a torn line rather than losing the file", () => {
		appendEvent(root, "s1", anEvent(1));
		const file = spoolPath(root, "s1");
		writeFileSync(file, `${readFileSync(file, "utf8")}{"kind":"post_to\n${JSON.stringify(anEvent(3))}\n`);

		const events = readSpool(root, "s1");
		expect(events).toHaveLength(2);
		expect(events[1]).toEqual(anEvent(3));
	});
});

describe("the cursor", () => {
	it("starts at nothing filed and sequence zero", () => {
		expect(readCursor(root, "s1")).toEqual({ filed: 0, sequence: 0, pending: 0 });
	});

	it("round-trips", () => {
		writeCursor(root, "s1", { filed: 7, sequence: 2, pending: 0 });
		expect(readCursor(root, "s1")).toEqual({ filed: 7, sequence: 2, pending: 0 });
	});

	it("treats an unreadable cursor as nothing filed, rather than throwing", () => {
		mkdirSync(join(root, ".ezil", "cursor"), { recursive: true });
		writeFileSync(join(root, ".ezil", "cursor", "s1.json"), "{not json");
		expect(readCursor(root, "s1")).toEqual({ filed: 0, sequence: 0, pending: 0 });
	});
});

describe("pendingBatches", () => {
	it("cuts the unfiled tail into batches of at most 500", () => {
		const events = Array.from({ length: 1201 }, (_, index) => anEvent(index));
		const batches = pendingBatches(events, { filed: 0, sequence: 0, pending: 0 });

		expect(batches.map((batch) => batch.events.length)).toEqual([MAX_BATCH_EVENTS, MAX_BATCH_EVENTS, 201]);
		// Monotonic, from zero, and one number per batch.
		expect(batches.map((batch) => batch.spoolSequence)).toEqual([0, 1, 2]);
		expect(batches[2]?.nextCursor).toEqual({ filed: 1201, sequence: 3, pending: 0 });
	});

	it("starts from where the cursor left off, and keeps counting sequences", () => {
		const events = Array.from({ length: 10 }, (_, index) => anEvent(index));
		const batches = pendingBatches(events, { filed: 4, sequence: 3, pending: 0 });

		expect(batches).toHaveLength(1);
		expect(batches[0]?.events).toHaveLength(6);
		expect(batches[0]?.events[0]).toEqual(anEvent(4));
		// The next batch is run 3, not run 0: the sequence is per session, and a
		// resend must present the number it presented the first time.
		expect(batches[0]?.spoolSequence).toBe(3);
		expect(batches[0]?.nextCursor).toEqual({ filed: 10, sequence: 4, pending: 0 });
	});

	it("re-derives the SAME batch for an unadvanced cursor, which is what a resend is", () => {
		const events = Array.from({ length: 3 }, (_, index) => anEvent(index));
		const first = pendingBatches(events, { filed: 0, sequence: 0, pending: 0 });
		const retry = pendingBatches(events, { filed: 0, sequence: 0, pending: 0 });

		expect(retry[0]?.spoolSequence).toBe(first[0]?.spoolSequence);
		expect(retry[0]?.events).toEqual(first[0]?.events ?? []);
	});


	/**
	 * The lost-acknowledgement case, which is the whole reason `pending` exists.
	 *
	 * A batch re-cut from the LIVE spool comes back a different size after the
	 * hooks have kept firing, and the route -- which derives a segment's id from
	 * `(session, sequence, index)` -- answers `already_recorded` for the whole
	 * of it. The cursor then advances past events that were never sent, and says
	 * they were filed. See `SpoolCursor.pending`.
	 */
	it("re-cuts EXACTLY the pinned slice after a lost answer, even once the spool has grown", () => {
		const inFlight = Array.from({ length: 3 }, (_, index) => anEvent(index));
		const grown = [...inFlight, anEvent(3), anEvent(4)];

		const attempted = pendingBatches(inFlight, { filed: 0, sequence: 0, pending: 0 })[0];
		expect(attempted?.attemptCursor).toEqual({ filed: 0, sequence: 0, pending: 3 });

		const retried = pendingBatches(grown, attempted?.attemptCursor ?? { filed: 0, sequence: 0, pending: 0 });

		expect(retried[0]?.spoolSequence).toBe(0);
		expect(retried[0]?.events).toEqual(inFlight);
		// And the two that arrived meanwhile go out as the NEXT sequence, rather
		// than being swallowed by the first one's `already_recorded`.
		expect(retried[1]?.spoolSequence).toBe(1);
		expect(retried[1]?.events).toEqual([anEvent(3), anEvent(4)]);
	});

	it("pins only the batch in flight, and cuts everything after it fresh", () => {
		const events = Array.from({ length: 10 }, (_, index) => anEvent(index));
		const batches = pendingBatches(events, { filed: 0, sequence: 5, pending: 2 });

		expect(batches.map((batch) => batch.events.length)).toEqual([2, 8]);
		expect(batches.map((batch) => batch.spoolSequence)).toEqual([5, 6]);
	});

	it("never pins beyond what the spool holds", () => {
		const batches = pendingBatches([anEvent(0)], { filed: 0, sequence: 0, pending: 9 });
		expect(batches).toHaveLength(1);
		expect(batches[0]?.events).toHaveLength(1);
	});

	it("has nothing pending when everything is filed", () => {
		const events = Array.from({ length: 3 }, (_, index) => anEvent(index));
		expect(pendingBatches(events, { filed: 3, sequence: 1, pending: 0 })).toEqual([]);
	});

	it("does not go backwards when the cursor is ahead of the spool", () => {
		expect(pendingBatches([anEvent(0)], { filed: 9, sequence: 4, pending: 0 })).toEqual([]);
	});
});
