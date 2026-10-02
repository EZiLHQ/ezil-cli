/**
 * What the hook removes before anything leaves the machine.
 *
 * ==========================================================================
 * THIS IS THE COURTESY. THE GUARANTEE IS THE SERVER'S.
 * ==========================================================================
 *
 * The Works session-ingest route scans every string in a batch and REFUSES
 * the whole batch if a credential shape appears in it. That is the guarantee,
 * because it runs on a machine the worker does not control. This file runs on
 * the worker's laptop, where it can be edited, disabled, or simply not
 * installed -- so it is a courtesy, and it is written as one: it removes what
 * it recognises so an ordinary session never trips the server's refusal.
 *
 * The two pattern lists are deliberately separate. The EZiL Works API must
 * not depend on `@ezil/cli`: one shared implementation would let one edit
 * disable both protections. Matching test vectors keep the lists aligned.
 *
 * ## Why replacement and not refusal here
 *
 * The server refuses because a secret reaching an append-only table cannot be
 * unwritten. Nothing here is append-only -- the spool is a file on the
 * worker's own disk -- so the useful behaviour is to strip the value and let
 * the rest of the event through. A hook that refused would drop the event, and
 * a transcript with holes in it under-counts work in EZiL's evidence
 * cross-check. See `docs/ARCHITECTURE.md` for the evidence design.
 */

/** What replaces a value. Never a partial value, never a hint at length. */
export const REDACTED = "[redacted]";

/**
 * The shapes a credential takes.
 *
 * Kept in the same order and with the same names as the Works session-ingest
 * route's credential patterns, so the two lists are easy to compare.
 */
export const REDACTION_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
	{ name: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
	{ name: "github-token", pattern: /\bgh[psuor]_[A-Za-z0-9]{20,}/g },
	{ name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
	/*
	 * A PEM private key. The server matches only the BEGIN line, because that is
	 * enough to refuse; here the whole block is replaced, since leaving the body
	 * behind after removing its header would put the key in the spool with
	 * nothing to recognise it by.
	 */
	{ name: "private-key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/g },
	{ name: "dotenv-read", pattern: /\b(?:cat|less|more|head|tail|bat|xxd|od)\b[^\n]{0,80}?(?:^|[\s/])\.env\b/gm },
]);

/** Which patterns fired, by name, in list order. */
export function redactionsIn(text: string): readonly string[] {
	const hits: string[] = [];

	for (const { name, pattern } of REDACTION_PATTERNS) {
		// `lastIndex` survives a `g` regex between calls, so a shared literal
		// would skip matches. Reset before every use.
		pattern.lastIndex = 0;
		if (pattern.test(text)) hits.push(name);
	}

	return hits;
}

/**
 * Replace every credential-shaped run with {@link REDACTED}.
 *
 * Returns the text unchanged when nothing matches, which is the common case and
 * the one worth being cheap.
 */
export function redact(text: string): string {
	let out = text;

	for (const { pattern } of REDACTION_PATTERNS) {
		pattern.lastIndex = 0;
		out = out.replace(pattern, REDACTED);
	}

	return out;
}

/**
 * A redacted excerpt of at most `budget` characters from each end.
 *
 * First and last rather than the first 8 KB, because a failing command's
 * diagnosis is usually in its last lines -- a stack trace, a summary, an exit
 * message -- and its identity is usually in its first. A middle-elided excerpt
 * carries both; a head-only one carries the command echoing itself.
 *
 * Redaction is applied AFTER the cut and to each half, so a credential that
 * straddles the elision cannot be reassembled out of two surviving fragments:
 * whatever half remains is matched on its own terms, and anything that is not
 * matched was already truncated below the pattern's own length floor.
 */
export function excerptOf(text: string, budget = 4096): string {
	if (text.length <= budget * 2) return redact(text);

	const head = redact(text.slice(0, budget));
	const tail = redact(text.slice(-budget));
	const elided = text.length - budget * 2;

	return `${head}\n[... ${elided} characters elided ...]\n${tail}`;
}
