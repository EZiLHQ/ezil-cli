import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitGrantResponseSchema } from "@ezil/cli-contract/cli-api";

export type CloneGrant = ReturnType<typeof GitGrantResponseSchema.parse>;
export type CloneTransport = (url: string, destination: string, grant: CloneGrant) => Promise<number>;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// This helper contains no credentials. Its private socket is an ephemeral operation handle.
const helper = `if(process.argv[2]!=='get'){process.stdin.resume();}else{const net=require('node:net');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const s=net.connect(process.argv[1]);s.on('connect',()=>s.end(input));s.on('data',c=>process.stdout.write(c));s.on('error',()=>{process.exitCode=1});});}`;

/** A memory-only grant from the same token as whoami; never reload the mutable session store. */
export const cloneWithGrant: CloneTransport = async (url, destination, grant) => {
	const root = mkdtempSync(join(tmpdir(), "ezil-grant-")); // 0700, no secret file
	const socketPath = join(root, "credential.sock");
	const sockets = new Set<Socket>();
	const server = createServer({ allowHalfOpen: true }, socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.setTimeout(5000, () => socket.destroy());
		let input = "";
		socket.on("data", chunk => { input += chunk.toString(); if (input.length > 4096) socket.destroy(); });
		socket.on("end", () => {
			const fields = Object.fromEntries(input.split("\n").filter(Boolean).map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
			const expected = new URL(url);
			if (fields["protocol"] !== "https" || fields["host"] !== expected.host || fields["path"] !== expected.pathname.slice(1) || grant.password_expiry_utc * 1000 <= Date.now()) {
				socket.end("quit=true\n\n"); return;
			}
			socket.end(`username=${grant.username}\npassword=${grant.password}\npassword_expiry_utc=${grant.password_expiry_utc}\n\n`);
		});
	});
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
		// Ignore inherited Git config/working-tree selectors: URL rewrites or auth headers
		// must not substitute a different transport/identity for this pinned grant.
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
			!key.startsWith("GIT_CONFIG") && !key.startsWith("GIT_TRACE") && !["GIT_CURL_VERBOSE","GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_ASKPASS"].includes(key)));
		const command = `!${quote(process.versions.bun ? "node" : process.execPath)} -e ${quote(helper)} ${quote(socketPath)}`;
		return await new Promise<number>(resolve => {
			const child = spawn("git", [
				"-c", "credential.helper=", "-c", "credential.https://github.ezil.work.helper=",
				"-c", `credential.https://github.ezil.work.helper=${command}`,
				"-c", "credential.useHttpPath=true", "-c", "credential.interactive=false",
				"-c", "http.extraHeader=", "-c", "http.followRedirects=false",
				"clone", "--", url, destination,
			], { cwd: root, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0" }, stdio: "ignore" });
			child.once("error", () => resolve(127));
			child.once("close", code => resolve(code ?? 1));
		});
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
};
