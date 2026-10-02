/**
 * Coding-session evidence: what a worker's own tooling reports about a session,
 * on the wire.
 *
 * The producer is a set of hooks on the worker's machine — session start, each
 * prompt, each tool call before and after, each stop, session end. They POST to
 * `/v1/sessions/:sessionId/events` in batches, and Works turns runs of those
 * events into `evidence_artifacts` rows of kind `SESSION_TRANSCRIPT`, one per
 * segment ({@link SessionEvidenceSegmentSurface}).
 *
 * ## The rung this can reach, and the rung it cannot
 *
 * {@link SESSION_EVIDENCE_RUNG} is `WORKER_RUNTIME_EVIDENCE`, and that is a
 * **ceiling**, not a default. `DONE_LADDER` glosses that rung as *"the worker
 * ran it and captured output. Their own machine, their own claim."* — which is
 * exactly what this is.
 *
 * It is worth being precise about what the hooks *do* buy, because it is more
 * than nothing and less than independence. A per-event claim is not the worker's
 * to make: the hook fires whether or not the worker wants it to, so a session
 * that ran a command and got exit 1 records exit 1, and the worker cannot
 * choose event by event what the transcript says. That is a real property and
 * it is why session evidence is worth collecting at all.
 *
 * It still is not independence. The machine is theirs, the toolchain is theirs,
 * and whether the hooks run at all is theirs. `AGENT-WORKS.md` FD-03 names the
 * gap directly: `INDEPENDENT_TEST_PASS` is *"a test that the worker did not
 * write, or a run they did not perform"*, and **the sandbox is the only
 * producer of that rung.** A session transcript showing a green suite is a
 * worker's claim that their machine went green — the adjacent rung, and the
 * exact QA collapse this product exists to catch. So nothing derived from this
 * contract may ever be recorded above `WORKER_RUNTIME_EVIDENCE`.
 *
 * ## No file contents. Anywhere.
 *
 * There is no field in this file that carries the body of a file, a diff, or a
 * patch, and this is a boundary rather than an omission to be filled in later.
 * The repositories being worked in belong to clients; a transcript that shipped
 * their source into `evidence_artifacts` would make this system a copy of code
 * it was never granted. What is carried instead is *shape*: which tool ran,
 * against which path, how many bytes came back, and what the commit ids were.
 * `post_tool.excerpt` is the one field that carries any output at all and it is
 * bounded and redacted; it exists so a failure has a readable symptom, not so a
 * reader can reconstruct a file.
 *
 * The same rule reaches prompts, which is why `prompt` carries a digest and a
 * redacted summary and no `verbatim` field. **Verbatim prompt capture is a
 * founder decision that has not been taken, and it is not in this contract.**
 * LB-7's second half — *"no default invasive surveillance"* — is untouched by
 * FD-01, and a prompt log is the most invasive thing this pipeline could
 * collect. Every schema below is strict, so a producer that adds `verbatim`
 * anyway is refused by name rather than quietly stored.
 */

import { z } from "zod";

/** The Works ladder rung this evidence reaches (`packages/contracts/src/ladder.ts` in EZiL-Works). */
type DoneRung = "WORKER_RUNTIME_EVIDENCE";

/**
 * The highest rung session evidence may ever claim.
 *
 * `satisfies DoneRung` rather than a bare string literal: the ladder is the
 * authority on how this rung is spelled, and a typo in a bare literal would be
 * a ceiling that matches no rung at all — which enforces nothing while looking
 * like it enforces something.
 */
export const SESSION_EVIDENCE_RUNG = "WORKER_RUNTIME_EVIDENCE" as const satisfies DoneRung;

/**
 * The six moments a hook fires.
 *
 * `pre_tool` and `post_tool` are two events and not one with an outcome,
 * because the difference between them is the evidence: a `pre_tool` with no
 * `post_tool` after it is a tool call that never returned, and a schema that
 * only recorded completed calls would render a hung session as a quiet one.
 */
export const SESSION_EVENT_KINDS = [
	"session_start",
	"prompt",
	"pre_tool",
	"post_tool",
	"stop",
	"session_end",
] as const;

export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

export const SessionEventKindSchema = z.enum(SESSION_EVENT_KINDS);

/**
 * A full git object id, exactly 40 lowercase hex characters.
 *
 * Deliberately **narrower** than `GitObjectIdSchema` in `orchestration.ts`,
 * which accepts 7 to 64. That one is written for ids a person may have typed or
 * abbreviated; this one is written by `git rev-parse HEAD` inside a hook, which
 * has no reason to be short. Accepting an abbreviation here would let two
 * sessions report prefixes that cannot be compared to each other or joined to a
 * contract's `base_commit` without a repository to resolve them against.
 */
const HeadShaSchema = z
	.string()
	.regex(/^[0-9a-f]{40}$/, "a head sha is the full 40 lowercase hex characters of a git object id");

/**
 * The digest of the prompt, as 64 lowercase hex characters.
 *
 * The same encoding rule as `ContentSha256Schema`, and for the same reason it
 * refuses uppercase rather than normalising it: a producer that hashed
 * differently from everyone else is a fact worth surfacing, and a digest that
 * only ever compares unequal is the failure this refusal exists to make loud.
 *
 * It is a digest and not the text because a digest answers the one question
 * that matters without carrying the prompt: *was this the same prompt as that
 * one.* Repetition, retries and a loop are all visible from digests alone.
 */
const PromptDigestSchema = z
	.string()
	.regex(/^[0-9a-f]{64}$/, "a prompt digest is 64 lowercase hex characters: the 32 bytes of a SHA-256 digest");

/**
 * When the event happened, as a UTC instant with its `Z`.
 *
 * Deliberately unlike `capturedAt` on `EvidenceArtifactSchema`, which is a local
 * datetime because it lands in a `timestamp without time zone` column that the
 * whole schema treats as UTC by convention. This one is produced on a worker's
 * own machine in a zone Works does not know, so a datetime with no offset would
 * be an instant nobody can place — and the ordering of a session's events is
 * the only thing that makes a transcript a transcript.
 */
const InstantSchema = z.iso.datetime({ offset: false });

/** Fields every event carries, whatever kind it is. */
const eventCommon = {
	at: InstantSchema,

	/**
	 * True when the tool acted outside the repository under contract.
	 *
	 * The event is still recorded — a session that spent forty minutes
	 * elsewhere is a fact about the day — but it is recorded **without a path
	 * and without a command**, and that is enforced below rather than left to
	 * the producer. Outside the repository is the worker's own machine and the
	 * worker's own life; a path there is surveillance of a person rather than
	 * evidence about work, which is the half of LB-7 FD-01 does not touch.
	 */
	outsideRepository: z.boolean().default(false),
};

/**
 * A redacted, bounded summary of what was asked.
 *
 * The bound is on the wire and not only in the producer, because "the hook
 * redacts it" is a property of a program on someone else's machine. 512
 * characters is enough for a sentence about the work and too little for a
 * pasted file, which is the distinction being drawn.
 */
const SummarySchema = z.string().max(512, "a prompt summary is a redacted sentence, not the prompt");

const SessionStartSchema = z.strictObject({
	...eventCommon,
	kind: z.literal("session_start"),
	repository: z.string().trim().min(1),
	headSha: HeadShaSchema,
	branch: z.string().trim().min(1),
	/** Which model the session ran on. Part of what makes a transcript replayable. */
	modelId: z.string().trim().min(1),
});

const PromptEventSchema = z.strictObject({
	...eventCommon,
	kind: z.literal("prompt"),
	digestSha256: PromptDigestSchema,
	summary: SummarySchema,
	/*
	 * There is no `verbatim` field, and `strictObject` is what makes that a
	 * refusal rather than a preference. See this file's header: verbatim prompt
	 * capture is a founder decision that has not been taken.
	 */
});

const PreToolSchema = z.strictObject({
	...eventCommon,
	kind: z.literal("pre_tool"),
	/** The tool about to run, by name — `Bash`, `Edit`, `Read`. */
	tool: z.string().trim().min(1),
	/** Redacted by the hook before it is sent. Absent for tools that run no command. */
	command: z.string().max(2048).optional(),
	/** Repository-relative. Absent when the tool names no file. */
	path: z.string().max(1024).optional(),
});

const PostToolSchema = z.strictObject({
	...eventCommon,
	kind: z.literal("post_tool"),
	tool: z.string().trim().min(1),
	/**
	 * The process's exit status, or `null` when it was killed before it produced
	 * one. Null rather than a stand-in code, exactly as `ValidationCheckSchema`
	 * argues: a report that invents `124` for a killed process is
	 * indistinguishable from one where the command genuinely exited 124.
	 */
	exitCode: z.number().int().nullable(),
	/**
	 * How much came back. A number, not the bytes.
	 *
	 * `.int()` bounds it to the safe-integer range, which is the same reasoning
	 * `EvidenceArtifactSchema.byteSize` gives: past 2^53 a JSON number is no
	 * longer the number that was sent.
	 */
	bytesOut: z.number().int().min(0),
	path: z.string().max(1024).optional(),
	/**
	 * A bounded, redacted excerpt of the output — at most 8 KiB.
	 *
	 * Present so a failure has a readable symptom. Absent by default, and never
	 * large enough to reconstruct a file: see the header. The bound is in
	 * characters, which is at most the byte count for anything ASCII and less
	 * for anything else, so it can only ever be stricter than 8 KiB on the wire.
	 */
	excerpt: z.string().max(8192, "an excerpt is a symptom, not a file: 8 KiB at most").optional(),
});

/**
 * The worker stopped the agent.
 *
 * Deliberately empty apart from the common fields. It is on the list because
 * *when someone interrupted* is evidence about a session and a kind that
 * carried a reason would invite the producer to write one, which is a sentence
 * from the worker's machine about the worker's own judgement.
 */
const StopSchema = z.strictObject({
	...eventCommon,
	kind: z.literal("stop"),
});

const SessionEndSchema = z.strictObject({
	...eventCommon,
	kind: z.literal("session_end"),
	headSha: HeadShaSchema,
	/**
	 * Whether the working tree still had uncommitted changes when the session
	 * ended.
	 *
	 * On the contract because `COMMITTED` is a rung: a session that ends dirty
	 * did not leave its work anywhere anybody else can look at it, and that is
	 * the difference between two rungs rather than a detail.
	 */
	dirty: z.boolean(),
	elapsedMs: z.number().int().min(0),
});

/**
 * One event, discriminated on `kind`.
 *
 * A discriminated union rather than one object with every field optional, so
 * that a `post_tool` missing its `exitCode` is refused as a bad `post_tool`
 * instead of parsing as an event that happens to say very little. Every member
 * is strict: an unknown key is a producer sending something this contract did
 * not agree to receive, and silently dropping it is how a `verbatim` field
 * arrives in production without a decision having been taken.
 */
export const SessionEventSchema = z
	.discriminatedUnion("kind", [
		SessionStartSchema,
		PromptEventSchema,
		PreToolSchema,
		PostToolSchema,
		StopSchema,
		SessionEndSchema,
	])
	.superRefine((event, ctx) => {
		/*
		 * Outside the repository, a path or a command is a fact about the
		 * worker's machine rather than about the work. The hook is supposed to
		 * omit them; this refuses the batch if it did not, because a rule that
		 * lives only in the producer is a rule that holds until someone edits
		 * the producer.
		 */
		if (!event.outsideRepository) return;

		for (const field of ["command", "path"] as const) {
			if (field in event && (event as Record<string, unknown>)[field] !== undefined) {
				ctx.addIssue({
					code: "custom",
					path: [field],
					message:
						`an event marked outsideRepository must carry no ${field}: outside the repository is the ` +
						"worker's own machine, and a path there is surveillance rather than evidence",
				});
			}
		}
	});

export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * A session id, as a path-safe token.
 *
 * It appears in a URL path segment (`/v1/sessions/:sessionId/events`) and in the
 * storage key of every segment derived from it, so the same rule
 * `orchestration.ts` states for a run id applies for the same reason: a value
 * that cannot be a path segment cannot be either of the two things this id is
 * used as. It is minted by the hook rather than by Works, so its format is
 * constrained and not invented here.
 */
const SessionIdSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
		"a session id is a path-safe token: letters, digits, dot, dash, underscore",
	);

/**
 * What one POST carries.
 *
 * ## Why a batch, and why it is bounded at both ends
 *
 * The hooks fire far more often than a request should be made, and a worker's
 * machine may be offline when they do, so events are spooled locally and sent
 * in runs. One event per request would make a session's evidence depend on the
 * network being up at each of several hundred instants.
 *
 * At least one, for the reason `EvidencePackageSchema` refuses an empty
 * envelope: "handed in nothing" and "handed in an empty envelope" must not be
 * the same record. At most 500, because a batch is also the unit of retry and a
 * body that cannot be re-sent within a request's budget is a batch that can
 * never land.
 */
export const SessionEventBatchSchema = z.strictObject({
	sessionId: SessionIdSchema,

	/** The day's contract these events are evidence about. */
	contractPublicId: z.uuid(),

	events: z.array(SessionEventSchema).min(1).max(500),

	/**
	 * Which run of the spool this is, counting from 0.
	 *
	 * The hook resends a batch it did not get an answer for, so the same events
	 * arrive twice as a matter of course. The sequence is what makes the second
	 * arrival recognisable as the first one rather than as a session that did
	 * everything twice — which would be a fabricated fact about a person's day,
	 * assembled out of nothing worse than a dropped connection.
	 */
	spoolSequence: z.number().int().min(0),
});

export type SessionEventBatch = z.infer<typeof SessionEventBatchSchema>;

/**
 * One `evidence_artifacts` row of kind `SESSION_TRANSCRIPT`, as a reader sees it.
 *
 * A session becomes several segments rather than one artefact, because an
 * artefact is append-only and a session is still happening: a single row per
 * session could only be written once the session ended, so a day's evidence
 * would be invisible until the worker stopped for the night — and a session
 * that never ends cleanly would leave nothing at all.
 *
 * The counts are here so a reader can see the shape of a segment without
 * fetching it, and so a segment carrying nothing is visible as that. The bytes
 * behind `storageKey` are the events; there are still no file contents in them.
 */
export interface SessionEvidenceSegmentSurface {
	readonly artifactPublicId: string;
	readonly contractPublicId: string;
	/** Position within the session, from 0. Consecutive, so a gap is visible. */
	readonly segmentIndex: number;
	/** The first and last event in the segment, as UTC instants. */
	readonly fromAt: string;
	readonly toAt: string;
	readonly eventCount: number;
	readonly promptCount: number;
	readonly toolCount: number;
	/**
	 * The commits this segment produced, full 40-character ids.
	 *
	 * The join to `GIT_COMMIT` evidence and to the contract's own
	 * `base_commit`: without it, a transcript and the code it produced are two
	 * records nobody can put together.
	 */
	readonly commitShas: readonly string[];
	readonly storageKey: string;
}
