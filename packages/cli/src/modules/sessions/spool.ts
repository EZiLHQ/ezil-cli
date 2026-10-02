import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Import the pinned session-event wire shape from the contract package.
// This type keeps spooled events aligned with the EZiL Works API.
// The EZiL Works repository keeps its own copy of the contract.
// Both repositories pin contract digests to detect local changes.
// The dependency is declared in `package.json` for published builds.
// See docs/ARCHITECTURE.md for the evidence pipeline.
import type { SessionEvent } from "@ezil/cli-contract/session-evidence";

import { cursorPath, spoolPath } from "../../core/paths";

/**
 * The spool: events on disk, in the order they happened, until they land.
 *
 * ## Why a file and not a request per event
 *
 * `SessionEventBatchSchema` opens with the reason -- the hooks fire far more
 * often than a request should be made, and a worker's machine may be offline
 * when they do. It has a second, harder reason on this side: a hook that made
 * an HTTP call would put the network on the critical path of every tool call in
 * somebody's editor. A hook that can hang is a hook every freelancer deletes on
 * day two, and a deleted hook produces no evidence at all.
 *
 * So the hook appends a line and exits. Sending is `ezil flush`'s problem, and
 * it runs detached.
 *
 * ## Why the cursor is a separate file
 *
 * The spool is append-only and is written by six different processes. A cursor
 * kept inside it would be a rewrite racing an append. Kept beside it, the worst
 * interleaving is a cursor that did not advance, which re-sends a batch the
 * server already has -- and the server answers `already_recorded`, which is
 * exactly what {@link SessionEventBatch.spoolSequence} exists to make possible.
 */

export interface SpoolCursor {
	/** How many lines of the spool have been filed. */
	readonly filed: number;
	/** The `spoolSequence` the next batch carries. Monotonic, never reused. */
	readonly sequence: number;
	/**
	 * How many events the sequence currently in flight carries. Zero when none is.
	 *
	 * ==========================================================================
	 * THIS IS WHAT STOPS A LOST ACK LOSING EVENTS.
	 * ==========================================================================
	 *
	 * Without it, a batch is re-cut from the LIVE spool on every attempt, and the
	 * spool grows while the attempt is in flight. The sequence that loses its
	 * answer therefore comes back a different size:
	 *
	 *   1. flush posts sequence 0 with three events; the server files them;
	 *   2. the acknowledgement is lost, so the cursor does not advance;
	 *   3. `stop` fires and two more events are appended;
	 *   4. flush re-cuts sequence 0 -- now FIVE events -- and posts it.
	 *
	 * The route derives each segment's id from `(sessionId, spoolSequence,
	 * indexInBatch)`, so segment 0's id is the one already stored: the whole
	 * batch answers `already_recorded`, the cursor advances by five, and events
	 * four and five are gone while the cursor says they were filed. Silently, and
	 * in the direction that makes a worker look idle.
	 *
	 * Recording the size before the POST pins the slice, so a retry re-cuts
	 * exactly the batch that was sent. Then `already_recorded` is true, the
	 * cursor advances by exactly what landed, and the later events go out as the
	 * next sequence.
	 *
	 * Stable segment ids let the EZiL Works API deduplicate retries. Adding a
	 * content digest to the id would let different batch sizes store the same
	 * events twice under different ids, duplicating evidence.
	 */
	readonly pending: number;
}

const EMPTY: SpoolCursor = Object.freeze({ filed: 0, sequence: 0, pending: 0 });

function ensureDirectory(file: string): void {
	mkdirSync(dirname(file), { recursive: true });
}

/**
 * Append one event.
 *
 * `appendFileSync` rather than a stream: a hook is a process that exits, and a
 * stream that has not flushed when it does is an event that never happened.
 * One `O_APPEND` write of a line under the pipe-buffer size is atomic enough
 * that two hooks firing at once interleave whole lines rather than halves.
 */
export function appendEvent(projectRoot: string, sessionId: string, event: SessionEvent): void {
	const file = spoolPath(projectRoot, sessionId);
	ensureDirectory(file);
	appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
}

/** Every event in the spool, oldest first. A line that does not parse is skipped. */
export function readSpool(projectRoot: string, sessionId: string): readonly SessionEvent[] {
	const file = spoolPath(projectRoot, sessionId);
	if (!existsSync(file)) return [];

	const events: SessionEvent[] = [];

	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			events.push(JSON.parse(line) as SessionEvent);
		} catch {
			// A half-written line from a process that died mid-append. Skipped
			// rather than fatal: one torn line must not cost the day's evidence.
		}
	}

	return events;
}

export function readCursor(projectRoot: string, sessionId: string): SpoolCursor {
	const file = cursorPath(projectRoot, sessionId);
	if (!existsSync(file)) return EMPTY;

	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return EMPTY;

		const record = parsed as Record<string, unknown>;
		const filed = typeof record["filed"] === "number" ? record["filed"] : 0;
		const sequence = typeof record["sequence"] === "number" ? record["sequence"] : 0;
		const pending = typeof record["pending"] === "number" ? record["pending"] : 0;

		return {
			filed: Math.max(0, Math.trunc(filed)),
			sequence: Math.max(0, Math.trunc(sequence)),
			pending: Math.max(0, Math.trunc(pending)),
		};
	} catch {
		return EMPTY;
	}
}

export function writeCursor(projectRoot: string, sessionId: string, cursor: SpoolCursor): void {
	const file = cursorPath(projectRoot, sessionId);
	ensureDirectory(file);
	writeFileSync(file, `${JSON.stringify(cursor)}\n`, { encoding: "utf8" });
}

/** At most this many events in one batch. `SessionEventBatchSchema` refuses more. */
export const MAX_BATCH_EVENTS = 500;

export interface PendingBatch {
	readonly spoolSequence: number;
	readonly events: readonly SessionEvent[];
	/**
	 * The cursor to write BEFORE this batch is posted.
	 *
	 * It pins the slice: written first, a retry after a lost answer re-cuts the
	 * same events rather than whatever the spool has grown to. See
	 * {@link SpoolCursor.pending}.
	 */
	readonly attemptCursor: SpoolCursor;
	/** The cursor to write once this batch has landed. */
	readonly nextCursor: SpoolCursor;
}

/**
 * Cut the unfiled tail of the spool into batches.
 *
 * The sequence advances per batch and never per attempt, so a batch that is
 * re-sent after a dropped connection carries the number it carried the first
 * time -- which is what lets the server recognise the second arrival as the
 * first rather than as a session that did everything twice.
 */
export function pendingBatches(events: readonly SessionEvent[], cursor: SpoolCursor): readonly PendingBatch[] {
	const batches: PendingBatch[] = [];

	let filed = Math.min(cursor.filed, events.length);
	let sequence = cursor.sequence;
	// Only the FIRST batch is pinned -- it is the one that may already be in
	// flight. Everything after it is cut fresh, because nothing has been sent
	// for those sequences yet.
	let pinned = Math.min(cursor.pending, events.length - filed);

	while (filed < events.length) {
		const size = Math.min(pinned > 0 ? pinned : MAX_BATCH_EVENTS, MAX_BATCH_EVENTS, events.length - filed);
		const slice = events.slice(filed, filed + size);

		batches.push({
			spoolSequence: sequence,
			events: slice,
			attemptCursor: { filed, sequence, pending: slice.length },
			nextCursor: { filed: filed + slice.length, sequence: sequence + 1, pending: 0 },
		});

		filed += slice.length;
		sequence += 1;
		pinned = 0;
	}

	return batches;
}
