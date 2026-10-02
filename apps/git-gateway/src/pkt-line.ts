import type { RefUpdate } from "@ezil/cli-contract/git-gateway";

/** The receive-pack command list is a few KB at most. Past this, correlation is skipped and the push still goes through. */
export const MAX_PREFIX_BYTES = 64 * 1024;

const decoder = new TextDecoder();

/**
 * Parse `<old> <new> <ref>` commands from the leading pkt-lines of a git-receive-pack request,
 * up to and including the first flush-pkt (`0000`). Returns null when the buffer doesn't yet
 * hold a complete command list, or when it isn't one.
 */
export function parseCommands(buffer: Uint8Array): { end: number; refUpdates: RefUpdate[] } | null {
	const refUpdates: RefUpdate[] = [];
	let offset = 0;
	while (offset + 4 <= buffer.length) {
		const lengthText = decoder.decode(buffer.subarray(offset, offset + 4));
		if (!/^[0-9a-f]{4}$/.test(lengthText)) return { end: -1, refUpdates: [] };
		const length = parseInt(lengthText, 16);
		if (length === 0) return { end: offset + 4, refUpdates };
		if (length < 4) return { end: -1, refUpdates: [] };
		if (offset + length > buffer.length) return null;
		let line = decoder.decode(buffer.subarray(offset + 4, offset + length));
		const nul = line.indexOf("\0");
		if (nul >= 0) line = line.slice(0, nul); // the first command carries capabilities after a NUL
		line = line.replace(/\n$/, "");
		const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S{1,255})$/.exec(line);
		// A shallow line, push-cert or anything else means this isn't a plain command list; don't guess.
		if (!match) return { end: -1, refUpdates: [] };
		refUpdates.push({ old: match[1]!, new: match[2]!, ref: match[3]! });
		offset += length;
	}
	return null;
}

/**
 * Read just the command list off the front of a request body without consuming the pack.
 * Returns the bytes read (to be replayed upstream, unchanged) and the parsed commands (or null
 * when correlation isn't possible), plus a stream that yields the prefix and then the rest.
 */
export async function splitReceivePack(body: ReadableStream<Uint8Array>): Promise<{ refUpdates: RefUpdate[] | null; stream: ReadableStream<Uint8Array> }> {
	const reader = body.getReader();
	let buffer = new Uint8Array(0);
	let refUpdates: RefUpdate[] | null = null;
	let done = false;
	while (buffer.length < MAX_PREFIX_BYTES) {
		const part = await reader.read();
		if (part.done) { done = true; break; }
		const next = new Uint8Array(buffer.length + part.value.length);
		next.set(buffer); next.set(part.value, buffer.length);
		buffer = next;
		const parsed = parseCommands(buffer);
		if (parsed === null) continue;
		if (parsed.end > 0 && parsed.refUpdates.length > 0) refUpdates = parsed.refUpdates;
		break;
	}
	const prefix = buffer;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) { if (prefix.length > 0) controller.enqueue(prefix); if (done) controller.close(); },
		async pull(controller) {
			if (done) return;
			const part = await reader.read();
			if (part.done) { done = true; controller.close(); return; }
			controller.enqueue(part.value);
		},
		cancel(reason) { return reader.cancel(reason); },
	});
	return { refUpdates, stream };
}
