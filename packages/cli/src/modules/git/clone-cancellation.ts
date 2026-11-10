/** Signal handlers live only for the CLI clone operation, never for library callers. */
export async function withCloneSignals(run: (signal: AbortSignal) => Promise<number>): Promise<number> {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.on("SIGTERM", cancel);
	process.on("SIGINT", cancel);
	try { return await run(controller.signal); }
	finally { process.off("SIGTERM", cancel); process.off("SIGINT", cancel); }
}
