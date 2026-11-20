import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StandaloneGrant } from "./private-grant-v2";

export type CloneGrant = StandaloneGrant;
export type CloneTransport = (url: string, destination: string, grant: CloneGrant, signal?: AbortSignal, authoritativeRef?: string) => Promise<number | "unborn">;
export const CLONE_GIT_TERM_GRACE_MS = 500;
export class CloneRecoveryRequired extends Error {
	constructor() { super("Repository open interrupted; recovery required after forced Git termination."); }
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// This helper contains no credentials. Its private socket is an ephemeral operation handle.
const helper = `if(process.argv[2]!=='get'){process.stdin.resume();}else{const net=require('node:net');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const s=net.connect(process.argv[1]);s.on('connect',()=>s.end(input));s.on('data',c=>process.stdout.write(c));s.on('error',()=>{process.exitCode=1});});}`;

/** An operation-scoped memory-only grant. No mutable session store is consulted. */
export const cloneWithGrant: CloneTransport = async (url, destination, grant, signal, authoritativeRef) => {
	signal?.throwIfAborted();
	const root = mkdtempSync(join(tmpdir(), "ezil-grant-")); // 0700, no secret file
	const ownedRoot = lstatSync(root);
	const socketPath = join(root, "credential.sock");
	const sockets = new Set<Socket>();
	let forced = false;
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
			!key.startsWith("GIT_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
		signal?.throwIfAborted();
		const command = `!${quote(process.versions.bun ? "node" : process.execPath)} -e ${quote(helper)} ${quote(socketPath)}`;
		const runGit = (args: string[], inspectStdout = false): Promise<{ code: number; hasOutput: boolean }> => {
			signal?.throwIfAborted();
			return new Promise((resolve, reject) => {
				let hasOutput = false;
				const child = spawn("git", [
					"-c", "credential.helper=", "-c", "credential.https://github.ezil.work.helper=",
					"-c", `credential.https://github.ezil.work.helper=${command}`,
					"-c", "credential.useHttpPath=true", "-c", "credential.interactive=false",
					"-c", "http.extraHeader=", "-c", "http.followRedirects=false",
					"-c", "core.hooksPath=/dev/null", ...args,
				], {
					cwd: root,
					env: { ...env, HOME: root, XDG_CONFIG_HOME: root, CURL_HOME: root, NETRC: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0" },
					stdio: ["ignore", inspectStdout ? "pipe" : "ignore", "ignore"],
				});
				child.stdout?.on("data", () => { hasOutput = true; });
				// No detached subgroup: OS owns the complete operation process group.
				// Await close even after cancellation, so cleanup cannot race a live Git child.
				let escalation: ReturnType<typeof setTimeout> | undefined;
				const cancel = () => {
					child.kill("SIGTERM");
					escalation = setTimeout(() => {
						// Only this still-owned child; OS subreaper owns orphan descendants.
						forced = true;
						child.kill("SIGKILL");
					}, CLONE_GIT_TERM_GRACE_MS);
				};
				signal?.addEventListener("abort", cancel, { once: true });
				if (signal?.aborted) cancel();
				child.once("error", () => { /* close follows spawn errors too */ });
				child.once("close", code => {
					signal?.removeEventListener("abort", cancel);
					if (escalation) clearTimeout(escalation);
					if (forced) { reject(new CloneRecoveryRequired()); return; }
					resolve({ code: code ?? 1, hasOutput });
				});
			});
		};

		const clone = await runGit([
			"clone", "--template=",
			...(authoritativeRef ? ["--no-tags", "--single-branch", `--branch=${authoritativeRef.slice("refs/heads/".length)}`] : []),
			"--", url, destination,
		]);
		if (clone.code === 0 || authoritativeRef !== "refs/heads/main") return clone.code;

		// A provider can declare main before the first push. Prove the entire
		// authorized remote is empty, rather than treating a missing branch or
		// a failed ref request as an empty repository.
		const remoteIsEmpty = async () => {
			if (grant.password_expiry_utc * 1000 <= Date.now()) return false;
			const refs = await runGit(["ls-remote", "--symref", "--", url], true);
			return refs.code === 0 && !refs.hasOutput && grant.password_expiry_utc * 1000 > Date.now();
		};
		if (!await remoteIsEmpty()) return clone.code;
		try { mkdirSync(destination, { mode: 0o700 }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return clone.code;
			throw error;
		}
		const initialize = [
			["init", "--initial-branch=main", "--template=", "--", destination],
			["-C", destination, "remote", "add", "--no-tags", "-t", "main", "origin", url],
			["-C", destination, "config", "--local", "branch.main.remote", "origin"],
			["-C", destination, "config", "--local", "branch.main.merge", authoritativeRef],
		];
		for (const args of initialize) {
			if ((await runGit(args)).code !== 0) return clone.code;
		}
		return await remoteIsEmpty() ? "unborn" : clone.code;
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
		try {
			const stat = lstatSync(root);
			if (!forced && !stat.isSymbolicLink() && stat.dev === ownedRoot.dev && stat.ino === ownedRoot.ino) rmSync(root, { recursive: true, force: true });
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
};
