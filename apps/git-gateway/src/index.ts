import { handle, type GatewayDeps, type GatewayEnv } from "./gateway";

// Per-isolate read-authorization cache (READ_CACHE_MS per entry). Never holds a denial or a push.
const cache: GatewayDeps["cache"] = new Map();

export default {
	async fetch(request: Request, env: GatewayEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
		// Prune lazily so a long-lived isolate doesn't grow without bound.
		if (cache.size > 5_000) { const now = Date.now(); for (const [key, value] of cache) if (value.until <= now) cache.delete(key); }
		return handle(request, env, { fetch: (input, init) => fetch(input, init), now: Date.now, cache,
			log: line => console.log(JSON.stringify(line)), waitUntil: promise => ctx.waitUntil(promise) });
	},
};
