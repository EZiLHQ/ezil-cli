import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
	connect,
	connectNotice,
	installHooks,
	mcpTokenRefFor,
	MCP_PROVIDER,
	MCP_TOKEN_REF_RULE,
	signIn,
	SignInFailed,
	terminalPrompt,
} from "./connect";
import { credentialsMode, readCredentials } from "../../core/credentials";
import { installedCommands } from "./settings-merge";

const TOKEN = "a-bearer-that-is-never-printed";
const CONTRACT = "11111111-2222-3333-4444-555555555555";

function serving(status: number, body: unknown): { call: typeof globalThis.fetch; seen: string[] } {
	const seen: string[] = [];

	const call = (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		seen.push(`${new Headers(init?.headers).get("authorization") ?? ""} ${url}`);
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as typeof globalThis.fetch;

	return { call, seen };
}

const todaysBody = {
	contract: { publicId: CONTRACT, repository: "ezil/works", businessDate: "2026-08-19", branch: "main" },
	frozenAt: null,
	acceptedAt: null,
};

let root: string;
let home: string;
let environment: NodeJS.ProcessEnv;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ezil-connect-"));
	home = join(root, "home");
	environment = { EZIL_HOME: home };
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("connect", () => {
	it("stores the credential at 0600, resolves the day, and installs the six hooks", async () => {
		const { call, seen } = serving(200, todaysBody);
		const result = await connect({
			apiOrigin: "https://api.ezil.work",
			accessToken: TOKEN,
			projectRoot: root,
			fetch: call,
			environment,
		});

		// Two calls, both bearing the token: the day, and then `/v1/me` for the
		// account id the connection is recorded against. This stub answers the
		// contract body to everything, so `/v1/me` carries no `accountId` and the
		// connection is skipped -- which the dedicated test below asserts
		// properly, with a server that answers each path its own body.
		expect(seen).toEqual([
			`Bearer ${TOKEN} https://api.ezil.work/v1/contracts/today`,
			`Bearer ${TOKEN} https://api.ezil.work/v1/me`,
		]);

		const stored = readCredentials(environment);
		expect(stored?.accessToken).toBe(TOKEN);
		expect(stored?.apiOrigin).toBe("https://api.ezil.work");
		expect(stored?.contractPublicId).toBe(CONTRACT);
		expect(stored?.repository).toBe("ezil/works");
		// A pasted bearer includes no refresh token.
		// The sign-in path stores the refresh token returned by the API.
		// This branch uses `--token`, so the stored field must remain null
		// rather than inventing a credential the process never received.
		expect(stored?.refreshToken).toBeNull();

		// The mode is read off the file, not off the call that wrote it.
		expect(credentialsMode(environment)).toBe(0o600);

		expect(result.contract?.contractPublicId).toBe(CONTRACT);
		expect(result.added).toHaveLength(6);
		expect(installedCommands(JSON.parse(readFileSync(result.settingsFile, "utf8")))).toHaveLength(6);
	});

	it("tightens the mode of a credentials file that already existed with looser bits", async () => {
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "credentials"), "{}\n", { mode: 0o644 });

		const { call } = serving(200, todaysBody);
		await connect({ apiOrigin: "https://api.ezil.work", accessToken: TOKEN, projectRoot: root, fetch: call, environment });

		expect(credentialsMode(environment)).toBe(0o600);
	});

	it("still installs the hooks when there is no contract today, and says why", async () => {
		const { call } = serving(409, { error: "no_contract_today", message: "You have no work contract in force today." });
		const result = await connect({
			apiOrigin: "https://api.ezil.work",
			accessToken: TOKEN,
			projectRoot: root,
			fetch: call,
			environment,
		});

		expect(result.contract).toBeNull();
		expect(result.contractUnavailable).toContain("no work contract in force today");
		// The hooks go in anyway: a worker about to agree a day still wants the
		// day recorded, and a connect that failed here would leave them with
		// nothing.
		expect(result.added).toHaveLength(6);
		expect(readCredentials(environment)?.contractPublicId).toBeUndefined();
	});

	it("says the API could not be reached rather than throwing", async () => {
		const call = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;
		const result = await connect({
			apiOrigin: "https://api.ezil.work",
			accessToken: TOKEN,
			projectRoot: root,
			fetch: call,
			environment,
		});

		expect(result.contract).toBeNull();
		expect(result.contractUnavailable).toContain("could not be reached");
	});
});

describe("installHooks", () => {
	it("merges into an existing settings file and keeps the rest of it", () => {
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(
			join(root, ".claude", "settings.json"),
			JSON.stringify({ env: { A: "1" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }),
		);

		const result = installHooks(root);
		const settings = JSON.parse(readFileSync(result.file, "utf8")) as Record<string, unknown>;

		expect(settings["env"]).toEqual({ A: "1" });
		expect(installedCommands(settings)).toContain("say done");
		expect(installedCommands(settings)).toContain("ezil hook stop");
	});

	it("does not lose an existing file that fails to parse -- it merges as though empty", () => {
		mkdirSync(join(root, ".claude"), { recursive: true });
		writeFileSync(join(root, ".claude", "settings.json"), "{ not json");

		const result = installHooks(root);
		expect(result.added).toHaveLength(6);
	});
});

describe("connectNotice", () => {
	it("states what is sent and what is not, and never the credential", async () => {
		const { call } = serving(200, todaysBody);
		const result = await connect({
			apiOrigin: "https://api.ezil.work",
			accessToken: TOKEN,
			projectRoot: root,
			fetch: call,
			environment,
		});

		const notice = connectNotice(result);

		expect(notice).toContain("WHAT IS SENT");
		expect(notice).toContain("WHAT IS NOT SENT");
		expect(notice).toContain("SHA-256 digest");
		expect(notice).toContain("path only");
		expect(notice).toContain("There is no verbatim field");
		expect(notice).toContain("file contents, diffs or patches");
		expect(notice).toContain(CONTRACT);
		expect(notice).toContain("keychain is a follow-up");
		expect(notice).toContain(".gitignore");

		// The one thing a connect notice must never carry.
		expect(notice).not.toContain(TOKEN);
	});
});

/* ------------------------------------------------------------------------- *
 * `ezil connect` signs in
 * ------------------------------------------------------------------------- */

/**
 * The EZiL Works repository tests its own `mcpTokenRefFor` against these
 * same vectors. The CLI and web client keep separate implementations to
 * avoid browser environment dependencies and a server dependency on the CLI.
 * The named rule (`MCP_TOKEN_REF_RULE`) and shared vectors keep both
 * derivations of the connection's `tokenRef` aligned.
 */
const SHARED_SUB = "6f1c9e2a-4b8d-4a71-9f30-2c5e7d81b4aa";
const SHARED_REFERENCE = "6f1c9e2a-4b8d-4a71-9f30-2c5e7d81b4aa";
const SHARED_BEARER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2ZjFjOWUyYSJ9.bm90LWEtc2lnbmF0dXJl";

/* Three distinct sentinels: nothing that leaves this command may carry any of
   them. Words that appear in no source file in this package. */
const REFRESH_SENTINEL = "refresh-token-mongoose-9931";
const PASSWORD_SENTINEL = "correct-horse-battery-kingfisher";
const EMAIL = "builder@ezil.work";

interface Call {
	readonly method: string;
	readonly path: string;
	readonly body: string | null;
	readonly authorization: string;
}

/** One answer per path, and every request recorded whole. */
function servingByPath(answers: Readonly<Record<string, { status: number; body: unknown }>>): {
	call: typeof globalThis.fetch;
	calls: Call[];
} {
	const calls: Call[] = [];

	const call = (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const path = new URL(url).pathname;

		calls.push({
			method: init?.method ?? "GET",
			path,
			body: typeof init?.body === "string" ? init.body : null,
			authorization: new Headers(init?.headers).get("authorization") ?? "",
		});

		const answer = answers[path] ?? { status: 500, body: { error: "not_stubbed", message: `no stub for ${path}` } };

		return new Response(JSON.stringify(answer.body), {
			status: answer.status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof globalThis.fetch;

	return { call, calls };
}

const SESSION = {
	accessToken: SHARED_BEARER,
	refreshToken: REFRESH_SENTINEL,
	expiresIn: 3600,
	tokenType: "bearer",
	accountId: SHARED_SUB,
	role: "builder",
};

function signedInServer(overrides: Readonly<Record<string, { status: number; body: unknown }>> = {}): {
	call: typeof globalThis.fetch;
	calls: Call[];
} {
	return servingByPath({
		"/auth/signin": { status: 200, body: SESSION },
		"/v1/contracts/today": { status: 200, body: todaysBody },
		"/v1/builder/mcp-connection": { status: 200, body: { accountId: "907", mcpConnected: true } },
		...overrides,
	});
}

/** Answers the two questions from a script, and records what it was asked. */
function scriptedPrompt(answers: readonly string[]): {
	ask: (question: string, secret: boolean) => Promise<string>;
	asked: { question: string; secret: boolean }[];
} {
	const asked: { question: string; secret: boolean }[] = [];
	let index = 0;

	return {
		ask: (question: string, secret: boolean): Promise<string> => {
			asked.push({ question, secret });
			const answer = answers[index] ?? "";
			index += 1;

			return Promise.resolve(answer);
		},
		asked,
	};
}

describe("connect signs in with an email and a password", () => {
	it("posts the grant, stores both tokens at 0600, records the connection, installs the hooks", async () => {
		const { call, calls } = signedInServer();
		const { ask, asked } = scriptedPrompt([EMAIL, PASSWORD_SENTINEL]);

		const result = await connect({
			apiOrigin: "https://api.ezil.work",
			projectRoot: root,
			fetch: call,
			environment,
			ask,
		});

		// The password is asked for with echo off. A prompt that did not say so
		// is a password on the person's screen and in their scrollback.
		expect(asked.map((entry) => entry.secret)).toEqual([false, true]);

		// The order is the design: sign in, resolve the day, record the
		// connection. Nothing is written before the first resolves.
		expect(calls.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
			"POST /auth/signin",
			"GET /v1/contracts/today",
			"POST /v1/builder/mcp-connection",
		]);

		expect(JSON.parse(String(calls[0]?.body))).toEqual({ email: EMAIL, password: PASSWORD_SENTINEL });
		// The signin is the one call with no bearer -- nobody has one yet.
		expect(calls[0]?.authorization).toBe("");
		expect(calls[1]?.authorization).toBe(`Bearer ${SHARED_BEARER}`);

		// The connection's reference is the identity, and the provider is the host.
		expect(JSON.parse(String(calls[2]?.body))).toEqual({ provider: "mcp.ezil.work", tokenRef: SHARED_REFERENCE });

		const stored = readCredentials(environment);
		expect(stored?.accessToken).toBe(SHARED_BEARER);
		// Preserve the refresh token returned by the Works sign-in route.
		expect(stored?.refreshToken).toBe(REFRESH_SENTINEL);
		expect(credentialsMode(environment)).toBe(0o600);

		expect(result.signedInAs).toBe("signin");
		expect(result.mcpProvider).toBe(MCP_PROVIDER);
		expect(result.mcpConnectionUnavailable).toBeNull();
		expect(result.added).toHaveLength(6);
	});

	it("takes the two answers from the environment when there is no terminal to ask", async () => {
		const { call, calls } = signedInServer();
		const { ask, asked } = scriptedPrompt(["should-not-be-asked", "should-not-be-asked"]);

		await connect({
			apiOrigin: "https://api.ezil.work",
			projectRoot: root,
			fetch: call,
			environment: { ...environment, EZIL_EMAIL: EMAIL, EZIL_PASSWORD: PASSWORD_SENTINEL },
			ask,
		});

		expect(asked).toEqual([]);
		expect(JSON.parse(String(calls[0]?.body))).toEqual({ email: EMAIL, password: PASSWORD_SENTINEL });
	});

	it("never writes the password anywhere, and never sends it anywhere but the signin", async () => {
		const { call, calls } = signedInServer();
		const { ask } = scriptedPrompt([EMAIL, PASSWORD_SENTINEL]);

		await connect({ apiOrigin: "https://api.ezil.work", projectRoot: root, fetch: call, environment, ask });

		// Every request after the signin, whole -- not the fields this test
		// happens to know the names of.
		for (const entry of calls.slice(1)) {
			expect(String(entry.body ?? "")).not.toContain(PASSWORD_SENTINEL);
		}

		// And the file on disk, read as raw text rather than through the parser,
		// so a password in an unexpected key would still be caught.
		expect(readFileSync(join(home, "credentials"), "utf8")).not.toContain(PASSWORD_SENTINEL);
	});
});

describe("a sign-in that fails leaves no credential behind", () => {
	async function attempt(
		answers: Readonly<Record<string, { status: number; body: unknown }>>,
	): Promise<SignInFailed> {
		const { call } = signedInServer(answers);
		const { ask } = scriptedPrompt([EMAIL, PASSWORD_SENTINEL]);

		try {
			await connect({ apiOrigin: "https://api.ezil.work", projectRoot: root, fetch: call, environment, ask });
		} catch (error: unknown) {
			if (error instanceof SignInFailed) return error;
			throw error;
		}

		throw new Error("the sign-in was expected to fail and did not.");
	}

	it("refuses a wrong password by the API's own sentence, and writes nothing at all", async () => {
		const failure = await attempt({
			"/auth/signin": {
				status: 401,
				body: { error: "invalid_credentials", message: "That email and password do not match an account." },
			},
		});

		expect(failure.code).toBe("invalid_credentials");
		expect(failure.message).toBe("That email and password do not match an account.");

		// The assertion that separates "it threw" from "it threw before writing":
		// no file, not an empty one and not a stale one.
		expect(readCredentials(environment)).toBeNull();
		expect(credentialsMode(environment)).toBeNull();
	});

	it("says the server is unconfigured rather than blaming the password, when it is", async () => {
		const failure = await attempt({
			"/auth/signin": {
				status: 501,
				body: { error: "not_implemented", message: "The publishable key is not configured on this server." },
			},
		});

		// The distinction that matters: a worker told their password is wrong
		// here would go and reset a password that is fine.
		expect(failure.code).toBe("not_implemented");
		expect(failure.status).toBe(501);
		expect(failure.message).toContain("not configured on this server");
		expect(failure.message).not.toContain("do not match");
		expect(readCredentials(environment)).toBeNull();
	});

	it("says the API could not be reached, and still writes nothing", async () => {
		const call = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;
		const { ask } = scriptedPrompt([EMAIL, PASSWORD_SENTINEL]);

		await expect(
			connect({ apiOrigin: "https://api.ezil.work", projectRoot: root, fetch: call, environment, ask }),
		).rejects.toThrow("could not be reached");

		expect(readCredentials(environment)).toBeNull();
		expect(credentialsMode(environment)).toBeNull();
		// The hooks are not installed either: this failure is before all of that.
		expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false);
	});

	it("carries no credential on the failure it throws", async () => {
		const failure = await attempt({
			"/auth/signin": { status: 401, body: { error: "invalid_credentials", message: "No." } },
		});

		// A refusal is a thing that gets logged. It must not be a second copy of
		// the secret that produced it.
		const serialised = JSON.stringify({ message: failure.message, status: failure.status, code: failure.code });
		expect(serialised).not.toContain(PASSWORD_SENTINEL);
		expect(serialised).not.toContain(EMAIL);
	});

	it("refuses before asking the network when an answer is empty, paired with a real one succeeding", async () => {
		const { call, calls } = signedInServer();
		const { ask } = scriptedPrompt(["", PASSWORD_SENTINEL]);

		await expect(
			connect({ apiOrigin: "https://api.ezil.work", projectRoot: root, fetch: call, environment, ask }),
		).rejects.toThrow("no email was given");
		expect(calls).toEqual([]);

		// The positive control: the same flow with an email answers 200.
		const second = scriptedPrompt([EMAIL, PASSWORD_SENTINEL]);
		const result = await connect({
			apiOrigin: "https://api.ezil.work",
			projectRoot: root,
			fetch: call,
			environment,
			ask: second.ask,
		});
		expect(result.signedInAs).toBe("signin");
	});
});

describe("the reference the connection is recorded against", () => {
	it("derives it from the identity and never from the credential", () => {
		expect(MCP_TOKEN_REF_RULE).toBe("supabase-auth-user-id");
		expect(mcpTokenRefFor(SHARED_SUB)).toBe(SHARED_REFERENCE);

		// The assertion with teeth: a derivation that hashed, truncated or
		// prefixed the token would still satisfy "both sides agree"; it does not
		// satisfy this.
		expect(mcpTokenRefFor(SHARED_SUB)).not.toContain(SHARED_BEARER);
		expect(SHARED_BEARER).not.toContain(mcpTokenRefFor(SHARED_SUB));
	});

	it("refuses to invent one, paired with trimming a real one", () => {
		expect(() => mcpTokenRefFor("")).toThrow("no account id");
		expect(mcpTokenRefFor(`  ${SHARED_SUB}  `)).toBe(SHARED_REFERENCE);
	});

	it("still installs the hooks when the connection is refused, and says why", async () => {
		const { call } = signedInServer({
			"/v1/builder/mcp-connection": {
				status: 404,
				body: { error: "builder_profile_missing", message: "No profile exists yet. POST /v1/builder/profile first." },
			},
		});
		const { ask } = scriptedPrompt([EMAIL, PASSWORD_SENTINEL]);

		const result = await connect({ apiOrigin: "https://api.ezil.work", projectRoot: root, fetch: call, environment, ask });

		expect(result.mcpProvider).toBeNull();
		expect(result.mcpConnectionUnavailable).toContain("No profile exists yet");
		// The credential and the hooks are still worth having.
		expect(readCredentials(environment)?.accessToken).toBe(SHARED_BEARER);
		expect(result.added).toHaveLength(6);
	});

	/**
	 * The `--token` path asks the EZiL Works API for the bearer owner's identity
	 * through GET /v1/me. Its `accountId` is the verified Supabase `sub`, so the
	 * connection uses the server's verified identity without decoding the JWT.
	 */
	it("asks /v1/me for the reference on the --token path rather than decoding the bearer", async () => {
		const { call, calls } = signedInServer({
			"/v1/me": { status: 200, body: { accountId: SHARED_SUB, email: EMAIL, role: "builder", onboarded: true } },
		});

		const result = await connect({
			apiOrigin: "https://api.ezil.work",
			accessToken: TOKEN,
			projectRoot: root,
			fetch: call,
			environment,
		});

		// No signin -- a token was given -- and the reference came from the API.
		expect(calls.map((entry) => entry.path)).toEqual([
			"/v1/contracts/today",
			"/v1/me",
			"/v1/builder/mcp-connection",
		]);
		expect(JSON.parse(String(calls[2]?.body))).toEqual({ provider: "mcp.ezil.work", tokenRef: SHARED_REFERENCE });

		// The bearer never appears in a body, only in the header.
		for (const entry of calls) expect(String(entry.body ?? "")).not.toContain(TOKEN);

		expect(result.signedInAs).toBe("token");
		expect(result.mcpProvider).toBe(MCP_PROVIDER);
		expect(result.mcpConnectionUnavailable).toBeNull();
	});

	it("skips the connection, saying why, when /v1/me will not name the bearer", async () => {
		const { call, calls } = signedInServer({
			"/v1/me": {
				status: 403,
				body: { error: "account_missing", message: "This sign-in is valid but has no EZiL account." },
			},
		});

		const result = await connect({
			apiOrigin: "https://api.ezil.work",
			accessToken: TOKEN,
			projectRoot: root,
			fetch: call,
			environment,
		});

		// Nothing is posted against a reference nobody could produce -- the
		// paired half of the test above, without which "it records" would be
		// satisfied by a command that records whatever it likes.
		expect(calls.map((entry) => entry.path)).toEqual(["/v1/contracts/today", "/v1/me"]);
		expect(result.mcpProvider).toBeNull();
		expect(result.mcpConnectionUnavailable).toContain("has no EZiL account");
		// And the credential and hooks still land: this is a soft failure.
		expect(readCredentials(environment)?.accessToken).toBe(TOKEN);
		expect(result.added).toHaveLength(6);
	});

	it("takes the bearer from EZIL_ACCESS_TOKEN without asking anything", async () => {
		const { call, calls } = signedInServer();
		const { ask, asked } = scriptedPrompt([EMAIL, PASSWORD_SENTINEL]);

		const result = await connect({
			apiOrigin: "https://api.ezil.work",
			projectRoot: root,
			fetch: call,
			environment: { ...environment, EZIL_ACCESS_TOKEN: TOKEN },
			ask,
		});

		expect(asked).toEqual([]);
		// No `/auth/signin`: the environment's bearer is used as given.
		expect(calls.map((entry) => entry.path)).not.toContain("/auth/signin");
		expect(calls[0]?.path).toBe("/v1/contracts/today");
		expect(result.signedInAs).toBe("token");
	});
});

describe("signIn on its own", () => {
	it("refuses a body with no access token in it rather than storing an empty one", async () => {
		const { call } = servingByPath({ "/auth/signin": { status: 200, body: { refreshToken: REFRESH_SENTINEL } } });

		await expect(signIn("https://api.ezil.work", EMAIL, PASSWORD_SENTINEL, call)).rejects.toThrow(
			"no access token",
		);
	});

	it("keeps a session with no refresh token as null rather than as an empty string", async () => {
		const { call } = servingByPath({
			"/auth/signin": { status: 200, body: { accessToken: SHARED_BEARER, refreshToken: "", accountId: SHARED_SUB } },
		});

		const grant = await signIn("https://api.ezil.work", EMAIL, PASSWORD_SENTINEL, call);
		expect(grant.refreshToken).toBeNull();
		expect(grant.accountId).toBe(SHARED_SUB);
	});
});

describe("nothing this command prints is a secret", () => {
	it("scans the whole notice for the bearer, the refresh token and the password", async () => {
		const { call } = signedInServer();
		const { ask } = scriptedPrompt([EMAIL, PASSWORD_SENTINEL]);

		const result = await connect({ apiOrigin: "https://api.ezil.work", projectRoot: root, fetch: call, environment, ask });
		const notice = connectNotice(result);

		// A connect notice must never carry the bearer, refresh token or password.
		// Check all three credentials returned or consumed by sign-in.
		expect(notice).not.toContain(SHARED_BEARER);
		expect(notice).not.toContain(REFRESH_SENTINEL);
		expect(notice).not.toContain(PASSWORD_SENTINEL);

		// Positive control: the notice is not empty and does say the useful
		// things, so "contains no secret" is not satisfied by saying nothing.
		expect(notice).toContain("Connected.");
		expect(notice).toContain("with your email and password");
		expect(notice).toContain("mcp.ezil.work");
		expect(notice).toContain("WHAT IS STORED ABOUT THIS CONNECTION");

		// And the whole result object, not just what the notice chose to print:
		// a field holding a token is one paste away from being printed later.
		expect(JSON.stringify(result)).not.toContain(SHARED_BEARER);
		expect(JSON.stringify(result)).not.toContain(REFRESH_SENTINEL);
		expect(JSON.stringify(result)).not.toContain(PASSWORD_SENTINEL);
	});
});

/**
 * The one path every other test in this file injects past.
 *
 * `terminalPrompt()` is the default `ask`, and its whole job is to keep the
 * password off the worker's screen. It does that by overriding readline's
 * `_writeToOutput`, which is an INTERNAL with no published contract — so
 * "the comment says the echo is off" is not evidence that it is. If the
 * override does not fire the way this file assumes (a prompt delivered in
 * pieces, a Node version that refreshes the line differently), the password
 * echoes, which is exactly the failure the code claims to prevent.
 *
 * Driven over two `PassThrough` streams rather than a real terminal, so this is
 * a test and not a demonstration. `terminal: true` is what makes readline echo
 * at all — without it there is nothing to suppress and the test would pass
 * against a `terminalPrompt` that did no muting whatsoever.
 */
describe("terminalPrompt keeps the password off the screen", () => {
	function overStreams(typed: string): { input: PassThrough; output: PassThrough; written: string[] } {
		const input = new PassThrough();
		const output = new PassThrough();
		const written: string[] = [];

		output.on("data", (chunk: Buffer | string) => {
			written.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		});

		// Written after the prompt has had a turn to be issued.
		setTimeout(() => input.write(`${typed}\n`), 5);

		return { input, output, written };
	}

	it("echoes the question and never the secret answer", async () => {
		const { input, output, written } = overStreams(PASSWORD_SENTINEL);

		const answer = await terminalPrompt({ input, output })("Password (not shown): ", true);

		expect(answer).toBe(PASSWORD_SENTINEL);

		const screen = written.join("");
		// The question has to reach the person, or they are staring at a blank
		// line with no idea what is wanted.
		expect(screen).toContain("Password (not shown): ");
		// And the answer must not. This is the assertion the whole function is for.
		expect(screen).not.toContain(PASSWORD_SENTINEL);
	});

	it("does echo an answer that is not a secret, which is what proves the muting is real", async () => {
		// The positive control. Without it, a `terminalPrompt` that suppressed
		// ALL output — or a stream that never received anything — would pass the
		// assertion above for free.
		const { input, output, written } = overStreams(EMAIL);

		const answer = await terminalPrompt({ input, output })("EZiL email: ", false);

		expect(answer).toBe(EMAIL);
		expect(written.join("")).toContain(EMAIL);
	});

	it("trims a non-secret answer and leaves a password exactly as typed", async () => {
		const spaced = overStreams(`  ${EMAIL}  `);
		expect(await terminalPrompt({ input: spaced.input, output: spaced.output })("EZiL email: ", false)).toBe(EMAIL);

		// A password with a leading or trailing space is a password with one:
		// trimming it would silently sign the worker in as somebody who does not
		// exist, or fail forever with no visible reason.
		const padded = overStreams(`  ${PASSWORD_SENTINEL}  `);
		expect(await terminalPrompt({ input: padded.input, output: padded.output })("Password: ", true)).toBe(
			`  ${PASSWORD_SENTINEL}  `,
		);
	});
});

/* ------------------------------------------------------------------------- *
 * The command, not the library
 * ------------------------------------------------------------------------- */

/**
 * Run the real binary against a local HTTP server to verify that command
 * dispatch reaches sign-in without a pre-existing bearer. Library tests alone
 * cannot prove that the command exposes the same behavior.
 *
 * `bin/ezil.ts` executes `main()` at import time, so a subprocess exercises
 * the entry point and captures its exit code, stdout and stderr.
 *
 * The environment is built from nothing rather than spread from `process.env`,
 * so a developer with `EZIL_ACCESS_TOKEN` exported in their shell cannot make
 * this test take the escape hatch and pass without proving anything.
 */
describe("`ezil connect` reaches the sign-in from a shell", () => {
	const BIN = join(import.meta.dir, "..", "..", "..", "bin", "ezil.ts");

	function stubApi(): { origin: string; stop: () => void; seen: string[] } {
		const seen: string[] = [];

		const server = Bun.serve({
			port: 0,
			async fetch(request: Request): Promise<Response> {
				const path = new URL(request.url).pathname;
				seen.push(path);

				if (path === "/auth/signin") {
					const body = (await request.json()) as { email?: string; password?: string };

					// The command's own end of the grant, checked here rather than
					// trusted: if the bin stopped passing the environment through,
					// this answers 401 and the assertions below go red.
					if (body.email !== EMAIL || body.password !== PASSWORD_SENTINEL) {
						return Response.json({ error: "invalid_credentials", message: "No." }, { status: 401 });
					}

					return Response.json(SESSION);
				}

				if (path === "/v1/contracts/today") return Response.json(todaysBody);
				if (path === "/v1/builder/mcp-connection") return Response.json({ accountId: "907", mcpConnected: true });

				return Response.json({ error: "not_stubbed", message: path }, { status: 500 });
			},
		});

		return {
			origin: `http://127.0.0.1:${String(server.port)}`,
			stop: () => {
				server.stop(true);
			},
			seen,
		};
	}

	/**
	 * `Bun.spawn`, awaited -- never `Bun.spawnSync`.
	 *
	 * Measured: the synchronous version deadlocks. `stubApi()`'s server runs on
	 * this process's event loop, `spawnSync` blocks that loop until the child
	 * exits, and the child is waiting on a request the blocked loop can never
	 * answer. Both sides then sit there until the 60 s test timeout -- three
	 * tests, three minutes, and a failure that reads like the command hanging
	 * rather than the harness deadlocking.
	 */
	async function runBin(
		args: readonly string[],
		env: Readonly<Record<string, string>>,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const child = Bun.spawn({
			cmd: ["bun", "run", BIN, ...args],
			cwd: root,
			// Built from nothing: no EZIL_ACCESS_TOKEN can leak in from the
			// machine running this. PATH is needed to find `bun` itself.
			env: { PATH: process.env["PATH"] ?? "", HOME: home, EZIL_HOME: home, ...env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		return { exitCode, stdout, stderr };
	}

	it("signs in and connects with no bearer anywhere, instead of exiting 2", async () => {
		const api = stubApi();

		try {
			const run = await runBin(["connect"], {
				EZIL_API_ORIGIN: api.origin,
				EZIL_EMAIL: EMAIL,
				EZIL_PASSWORD: PASSWORD_SENTINEL,
			});

			const stdout = run.stdout;
			const stderr = run.stderr;

			// The assertion the early exit made impossible.
			expect({ exitCode: run.exitCode, connected: stdout.includes("Connected.") }).toEqual({
				exitCode: 0,
				connected: true,
			});

			// It really signed in -- not "it exited 0 having done nothing".
			expect(api.seen).toContain("/auth/signin");
			expect(api.seen).toContain("/v1/builder/mcp-connection");
			expect(stdout).toContain("with your email and password");
			expect(stdout).toContain("mcp.ezil.work recorded against your account");

			// The command must not claim that the Works sign-in route is absent.
			// Its output must reflect the successful POST /auth/signin request.
			expect(stderr).not.toContain("has no sign-in route");

			// No credential may appear on either process output stream.
			// Scan actual stdout and stderr to cover the command entry point
			// as well as the library's returned notice.
			for (const stream of [stdout, stderr]) {
				expect(stream).not.toContain(SHARED_BEARER);
				expect(stream).not.toContain(REFRESH_SENTINEL);
				expect(stream).not.toContain(PASSWORD_SENTINEL);
			}

			// And the two files a connect is for actually landed.
			expect(readCredentials({ EZIL_HOME: home })?.accessToken).toBe(SHARED_BEARER);
			expect(credentialsMode({ EZIL_HOME: home })).toBe(0o600);
			expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);
		} finally {
			api.stop();
		}
	});

	/**
	 * The positive control for the test above.
	 *
	 * `exit 0` and `exit 2` are the only two things that test reads, so a bin
	 * that returned 0 for everything would satisfy it. This is the case that
	 * still must not succeed: wrong credentials reach `/auth/signin`, are
	 * refused, and the command fails with nothing written.
	 */
	it("still fails, and writes no credential, when the password is wrong", async () => {
		const api = stubApi();

		try {
			const run = await runBin(["connect"], {
				EZIL_API_ORIGIN: api.origin,
				EZIL_EMAIL: EMAIL,
				EZIL_PASSWORD: "not-the-password",
			});

			expect(run.exitCode).not.toBe(0);
			expect(api.seen).toContain("/auth/signin");
			// It got as far as the grant and no further.
			expect(api.seen).not.toContain("/v1/builder/mcp-connection");
			expect(readCredentials({ EZIL_HOME: home })).toBeNull();
		} finally {
			api.stop();
		}
	});

	it("still takes --token, which is the escape hatch the usage text names", async () => {
		const api = stubApi();

		try {
			const run = await runBin(["connect", "--token", TOKEN], { EZIL_API_ORIGIN: api.origin });

			expect(run.exitCode).toBe(0);
			// No sign-in: an explicit token beats everything, exactly as before.
			expect(api.seen).not.toContain("/auth/signin");
			expect(run.stdout).toContain("with a bearer you supplied");
			expect(readCredentials({ EZIL_HOME: home })?.accessToken).toBe(TOKEN);
		} finally {
			api.stop();
		}
	});
});
