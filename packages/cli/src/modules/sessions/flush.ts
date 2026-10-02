import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionEvent } from "@ezil/cli-contract/session-evidence";

import { readBinding } from "./binding";
import { todaysContract } from "./connect";
import { readCredentials, type StoredCredentials } from "../../core/credentials";
import { projectStateDirectory, quarantineDirectory } from "../../core/paths";
import { redactionsIn } from "../../core/redact";
import { pendingBatches, readCursor, readSpool, writeCursor, type PendingBatch } from "./spool";

/**
 * `ezil flush` -- the spool, on the wire.
 *
 * Runs detached, from `stop` and `session-end`, and from a person's own hand.
 * Never from inside a hook's critical path: see `spool.ts` on why a hook that
 * can block is a hook that gets deleted.
 *
 * ## The three answers, and what each one does to the spool
 *
 *   - **Filed** (`recorded` or `already_recorded`) -- the cursor advances. Both
 *     are success: `already_recorded` is the server recognising a batch it has,
 *     which is exactly what `spoolSequence` exists to let it do.
 *   - **A secret was refused** -- that batch is QUARANTINED and the cursor
 *     advances past it. It is not retried: the server refuses it every time by
 *     construction, so retrying is a loop, and dropping it silently would lose
 *     the events with no record that anything happened. The quarantined file
 *     stays on the worker's own disk, where the credential already was.
 *   - **Anything else** -- the cursor does NOT advance and the run stops. The
 *     spool stays. A day offline is a day of evidence that lands tomorrow, not
 *     a day that is gone.
 *
 * ## The contract is resolved per run, never read from the credential
 *
 * `connect` stores the contract it saw on the day it ran. Contracts are DAILY.
 * A worker who connects on Monday and works on Tuesday would file Tuesday's
 * transcript against Monday's contract -- and every check the route makes would
 * pass, because the account does own that contract, the repository does match,
 * and the events are clean. The row would land with Tuesday's `capturedAt`
 * under Monday's id, in an append-only table.
 *
 * So the day is resolved here, once per run, from `GET /v1/contracts/today`.
 * When it cannot be resolved NOTHING is sent and the spool is untouched: an
 * unsendable day lands tomorrow, and a day filed against the wrong contract
 * never comes back.
 *
 * ## One flush at a time, per project
 *
 * `stop` spawns a flush, and `stop` fires on every turn -- so two flushes
 * overlap the moment one is slow, which is exactly the condition a spool exists
 * for. Two of them re-cut the same sequence from a spool that grew in between,
 * the second one's larger batch answers `already_recorded` off the first
 * segment's unchanged derived id, and its cursor advances past events nobody
 * sent. {@link SpoolCursor.pending} does not help: the two processes pin
 * different slices.
 *
 * So a flush takes a directory as a lock. `mkdir` is atomic on POSIX and fails
 * with `EEXIST` rather than succeeding twice, which is the whole mechanism. A
 * flush that does not get it returns immediately and sends nothing -- the holder
 * is already sending this spool, so there is nothing to do and nothing is lost.
 *
 * A lock held longer than {@link FLUSH_LOCK_STALE_MS} is taken over, because a
 * flush killed mid-run must not wedge a worker's evidence forever. The takeover
 * is not itself atomic between two stale claimants, and it does not need to be:
 * that is precisely the case `pending` covers -- whoever sends re-cuts the
 * pinned slice, and a re-send of it answers `already_recorded`.
 *
 * ## And the repository, which the server can only half-check
 *
 * `receiveSessionEvents` compares `session_start.repository` against the
 * contract's -- and a batch with no `session_start` in it carries nothing to
 * compare, which is most batches after the first. So a session bound to the
 * wrong tree is refused once and accepted thereafter. The binding written at
 * session start is checked here, before anything is sent, which is the half the
 * server cannot do.
 */

export interface FlushOptions {
	readonly projectRoot: string;
	/** The clock, for the stale-lock test. Never `Date.now` inside the loop. */
	readonly nowMs?: number;
	readonly credentials?: StoredCredentials | null;
	readonly fetch?: typeof globalThis.fetch;
	readonly environment?: NodeJS.ProcessEnv;
	/** One session, or every spooled session when absent. */
	readonly sessionId?: string;
}

export type BatchOutcome =
	| { readonly kind: "filed"; readonly sessionId: string; readonly spoolSequence: number; readonly status: string }
	/** Today's contract could not be resolved. Nothing was sent and nothing was lost. */
	| { readonly kind: "no-contract"; readonly detail: string }
	/** The session ran in a tree today's contract does not name. */
	| { readonly kind: "wrong-repository"; readonly sessionId: string; readonly detail: string }
	| { readonly kind: "quarantined"; readonly sessionId: string; readonly spoolSequence: number; readonly file: string; readonly patterns: readonly string[] }
	| {
			readonly kind: "unauthorised";
			/** Null when the bearer was refused before any session was reached. */
			readonly sessionId: string | null;
			readonly spoolSequence: number | null;
			readonly detail: string;
	  }
	/** Another flush holds this project's lock and is already sending this spool. */
	| { readonly kind: "already-running"; readonly detail: string }
	| { readonly kind: "failed"; readonly sessionId: string; readonly spoolSequence: number; readonly detail: string };

export interface FlushResult {
	readonly outcomes: readonly BatchOutcome[];
	/** Events still in the spool, unfiled, when the run ended. */
	readonly remaining: number;
}

/**
 * How long a lock may be held before it is assumed to belong to a dead process.
 *
 * Two minutes. Long enough that an ordinary slow flush is never taken over --
 * a batch is at most 500 events and the request budget is a request's -- and
 * short enough that a worker whose machine was killed mid-flush is sending again
 * within one session.
 */
export const FLUSH_LOCK_STALE_MS = 120_000;

const NO_LOCK = "the lock could not be taken";

/**
 * Take the project's flush lock, or report that somebody else has it.
 *
 * `mkdir` and not a file: creating a directory that exists fails, atomically,
 * where "check then write" has a window between the two halves that is exactly
 * the race this is here to close.
 */
export function takeFlushLock(projectRoot: string, nowMs: number): boolean {
	const directory = projectStateDirectory(projectRoot);
	const lock = join(directory, "flush.lock");

	mkdirSync(directory, { recursive: true });

	try {
		mkdirSync(lock);
		// Stamped with the CALLER's clock rather than the filesystem's, so the
		// age below is measured against the same clock that will read it.
		utimesSync(lock, new Date(nowMs), new Date(nowMs));
		return true;
	} catch {
		// Held. Taken over only when it is old enough to be a corpse.
		try {
			if (nowMs - statSync(lock).mtimeMs <= FLUSH_LOCK_STALE_MS) return false;
			utimesSync(lock, new Date(nowMs), new Date(nowMs));
			return true;
		} catch {
			return false;
		}
	}
}

export function releaseFlushLock(projectRoot: string): void {
	try {
		rmSync(join(projectStateDirectory(projectRoot), "flush.lock"), { recursive: true, force: true });
	} catch {
		// A lock that cannot be removed goes stale and is taken over. Nothing is
		// lost, and there is nowhere useful to report this from.
	}
}

/** Every session with a spool in this project. */
export function spooledSessions(projectRoot: string): readonly string[] {
	const directory = join(projectStateDirectory(projectRoot), "spool");

	try {
		return readdirSync(directory)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => name.slice(0, -".jsonl".length))
			.sort();
	} catch {
		return [];
	}
}

/**
 * The refusal code, if the answer carried one.
 *
 * `secret_withheld` is `SecretWouldHaveBeenRecorded`'s code and it is matched
 * by that string rather than by the status, because the status is 500 and a 500
 * is also what an unrecognised server fault answers. Quarantining on the status
 * would quarantine a day's work because a database was briefly down.
 */
function refusalCode(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const error = (body as Record<string, unknown>)["error"];
	return typeof error === "string" ? error : null;
}

/** Which of this package's patterns fire on a batch. For the log line, never for a decision. */
export function patternsInBatch(events: readonly SessionEvent[]): readonly string[] {
	const hits = new Set<string>();
	for (const name of redactionsIn(JSON.stringify(events))) hits.add(name);
	return [...hits].sort();
}

function quarantine(projectRoot: string, sessionId: string, batch: PendingBatch): string {
	const directory = quarantineDirectory(projectRoot);
	mkdirSync(directory, { recursive: true });

	const file = join(directory, `${sessionId}.${batch.spoolSequence}.json`);
	writeFileSync(
		file,
		`${JSON.stringify({ sessionId, spoolSequence: batch.spoolSequence, events: batch.events }, null, 2)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);

	return file;
}

export async function flush(options: FlushOptions): Promise<FlushResult> {
	const call = options.fetch ?? globalThis.fetch;
	const credentials = options.credentials ?? readCredentials(options.environment ?? process.env);
	const outcomes: BatchOutcome[] = [];

	if (credentials === null) {
		return { outcomes, remaining: 0 };
	}

	const sessions = options.sessionId === undefined ? spooledSessions(options.projectRoot) : [options.sessionId];

	/** Everything spooled and not yet filed, for a run that sends nothing. */
	const unfiled = (): number =>
		sessions.reduce((total, sessionId) => {
			const events = readSpool(options.projectRoot, sessionId);
			return total + Math.max(0, events.length - readCursor(options.projectRoot, sessionId).filed);
		}, 0);

	// One flush at a time, per project. See the header: two overlapping runs
	// re-cut the same sequence from a spool that grew between them, and the
	// second one's cursor advances past events nobody sent.
	if (!takeFlushLock(options.projectRoot, options.nowMs ?? Date.now())) {
		outcomes.push({ kind: "already-running", detail: `${NO_LOCK}: another flush is sending this spool` });
		return { outcomes, remaining: unfiled() };
	}

	try {
		// The day, resolved now. See the header: the credential's copy is the day
		// `connect` ran on, and filing against it would be a fabricated fact about
		// somebody's work in a table nothing can correct.
		const today = await todaysContract(credentials.apiOrigin, credentials.accessToken, call);

		if ("reason" in today) {
			// A refused bearer is not "no contract today", and the two need
			// different sentences: one says agree your day, the other says connect
			// again. Before the day was resolved here, an expired token reported as
			// the first.
			if (today.status === 401 || today.status === 403) {
				outcomes.push({
					kind: "unauthorised",
					sessionId: null,
					spoolSequence: null,
					detail: "the bearer was refused and there is no refresh route to try: run `ezil connect` again",
				});
			} else {
				outcomes.push({ kind: "no-contract", detail: `today's contract could not be resolved: ${today.reason}` });
			}

			return { outcomes, remaining: unfiled() };
		}

		const { contractPublicId, repository } = today.contract;
		let remaining = 0;

		for (const sessionId of sessions) {
			const events = readSpool(options.projectRoot, sessionId);
			let cursor = readCursor(options.projectRoot, sessionId);

			const binding = readBinding(options.projectRoot, sessionId);
			if (binding !== null && binding.repository !== repository) {
				outcomes.push({
					kind: "wrong-repository",
					sessionId,
					detail: `it ran in ${binding.repository} and today's contract is for ${repository}`,
				});
				remaining += Math.max(0, events.length - cursor.filed);
				continue;
			}

			for (const batch of pendingBatches(events, cursor)) {
				// The slice is pinned BEFORE the request, so a retry after a lost
				// answer re-cuts exactly what was sent. See `SpoolCursor.pending`.
				writeCursor(options.projectRoot, sessionId, batch.attemptCursor);

				const body = {
					sessionId,
					contractPublicId,
					events: batch.events,
					spoolSequence: batch.spoolSequence,
				};

				let response: Response;
				try {
					response = await call(`${credentials.apiOrigin}/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
						method: "POST",
						headers: {
							authorization: `Bearer ${credentials.accessToken}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
					});
				} catch (error: unknown) {
					cursor = batch.attemptCursor;
					outcomes.push({
						kind: "failed",
						sessionId,
						spoolSequence: batch.spoolSequence,
						detail: error instanceof Error ? error.message : "no response",
					});
					break;
				}

				const answer: unknown = await response.json().catch(() => null);

				if (response.ok) {
					cursor = batch.nextCursor;
					writeCursor(options.projectRoot, sessionId, cursor);
					outcomes.push({
						kind: "filed",
						sessionId,
						spoolSequence: batch.spoolSequence,
						status: String((answer as Record<string, unknown> | null)?.["status"] ?? "recorded"),
					});
					continue;
				}

				if (refusalCode(answer) === "secret_withheld") {
					const file = quarantine(options.projectRoot, sessionId, batch);
					cursor = batch.nextCursor;
					writeCursor(options.projectRoot, sessionId, cursor);
					outcomes.push({
						kind: "quarantined",
						sessionId,
						spoolSequence: batch.spoolSequence,
						file,
						patterns: patternsInBatch(batch.events),
					});
					continue;
				}

				cursor = batch.attemptCursor;

				if (response.status === 401 || response.status === 403) {
					outcomes.push({
						kind: "unauthorised",
						sessionId,
						spoolSequence: batch.spoolSequence,
						detail: "the bearer was refused and there is no refresh route to try: run `ezil connect` again",
					});
					break;
				}

				outcomes.push({
					kind: "failed",
					sessionId,
					spoolSequence: batch.spoolSequence,
					detail: `HTTP ${response.status}`,
				});
				break;
			}

			// Re-read rather than reusing the snapshot above: hooks append while a
			// flush is in flight, and a count taken before the request would say
			// nothing is waiting when something is.
			remaining += Math.max(0, readSpool(options.projectRoot, sessionId).length - cursor.filed);
		}

		return { outcomes, remaining };
	} finally {
		releaseFlushLock(options.projectRoot);
	}
}
