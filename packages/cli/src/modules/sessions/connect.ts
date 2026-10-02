import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeCredentials, type StoredCredentials } from "../../core/credentials";
import { claudeSettingsPath } from "../../core/paths";
import { desiredHooks, mergeHooks, TOOL_MATCHER } from "./settings-merge";

/**
 * `ezil connect` -- the sign-in, the credential, the connection, the contract,
 * and the six hooks.
 *
 * The Works sign-in route POST /auth/signin proxies the Supabase password
 * grant with the publishable key held server-side. The documented path uses
 * email and password; `--token` / `EZIL_ACCESS_TOKEN` accepts an existing
 * session. See {@link resolveGrant} and `docs/ARCHITECTURE.md`.
 *
 * An unconfigured Supabase publishable key produces 501 `not_implemented`.
 * {@link signIn} reports this as a deployment problem rather than a bad password.
 *
 * ## What connecting changes on the worker's machine, and in what order
 *
 * The order is the design. **Nothing is written until there is something worth
 * writing**: a failed sign-in leaves no `~/.ezil/credentials` at all, rather
 * than an empty or stale one that the next `ezil flush` would present as a
 * live session.
 *
 *   1. Resolve the grant -- `--token`, or an email and a password through
 *      `POST /auth/signin`. A refusal here throws; it is not the soft
 *      "no contract today" shape, because a `connect` with no credential has
 *      not connected.
 *   2. `~/.ezil/credentials`, mode 0600, holding the bearer and any refresh
 *      token returned by sign-in.
 *   3. `POST /v1/builder/mcp-connection` -- the record the connection gate
 *      checks. Failure is soft, like the contract: a builder with no profile
 *      row yet still wants their hooks.
 *   4. `<project>/.claude/settings.json`, MERGED. Whatever is already in it
 *      stays; see `settings-merge.ts`.
 *
 * ## Nothing this file has is ever printed
 *
 * The password is never held past the request that spends it, never written to
 * disk, and never returned from any function here. The access and refresh
 * tokens go to a 0600 file and to no other sink. {@link connectNotice} is
 * written from `ConnectResult`, and `ConnectResult` has no field that holds any
 * of the three -- which is what `connect.test.ts` scans stdout for.
 */

export interface ConnectOptions {
	readonly apiOrigin: string;
	/**
 * An existing bearer as an alternative to signing in.
	 *
	 * Present means "use this bearer and do not ask for anything"; absent means
	 * sign in. See {@link resolveGrant}.
	 */
	readonly accessToken?: string;
	readonly projectRoot: string;
	/** Injectable, so the connect flow is testable without a server. */
	readonly fetch?: typeof globalThis.fetch;
	readonly environment?: NodeJS.ProcessEnv;
	/**
	 * How the two answers are obtained when there is no bearer.
	 *
	 * Injectable for the reason `fetch` is: a sign-in that could only be driven
	 * by a real terminal could only be proved by a person running it. Defaults
	 * to {@link terminalPrompt}, which is the only thing in this package that
	 * reads stdin outside a hook.
	 */
	readonly ask?: CredentialPrompt;
}

/**
 * One question, and whether the answer must not be echoed.
 *
 * `secret: true` is not advice: {@link terminalPrompt} turns the terminal's
 * echo off for it, so the password is not left on the worker's screen or in
 * their scrollback.
 */
export type CredentialPrompt = (question: string, secret: boolean) => Promise<string>;

/**
 * A grant, however it was obtained.
 *
 * `refreshToken` is null for `--token`, which supplies only a bearer.
 * Sign-in returns a refresh token that the EZiL Works API can exchange through
 * POST /auth/refresh.
 */
export interface Grant {
	readonly accessToken: string;
	readonly refreshToken: string | null;
	/**
	 * The Supabase auth user id -- the token's own `sub`, as `/auth/signin`
	 * reports it. `null` on the `--token` path, where nothing has told this
	 * process who the bearer belongs to and this package does not decode JWTs.
	 */
	readonly accountId: string | null;
	readonly source: "token" | "signin";
}

/**
 * A sign-in that did not produce a session.
 *
 * Thrown, not returned: every other "unavailable" in this file is soft because
 * the hooks are still worth installing without it, and a credential is not one
 * of those things. A `connect` that wrote a credentials file after this would
 * be writing a file with nothing in it that works.
 *
 * `reason` preserves the EZiL Works API's user-facing message. It never
 * carries the password, email or token: it is built from a status and message.
 */
export class SignInFailed extends Error {
	readonly status: number | null;
	readonly code: string | null;

	constructor(message: string, status: number | null, code: string | null) {
		super(message);
		this.name = "SignInFailed";
		this.status = status;
		this.code = code;
	}
}

/* ------------------------------------------------------------------------- *
 * Signing in -- the Works sign-in route POST /auth/signin
 * ------------------------------------------------------------------------- */

/**
 * Exchange an email and a password for a session.
 *
 * ## The password's whole life is this function
 *
 * It arrives as an argument, it is serialised into one request body, and the
 * function returns. It is not stored, not logged, not put on the {@link Grant},
 * and not carried by {@link SignInFailed} -- there is no field on either that
 * could hold it. A future edit that wanted to keep it would have to add one,
 * which is the point.
 *
 * ## Every failure has its own sentence, and none of them is "wrong password"
 * ## unless it was
 *
 * The EZiL Works API uses one message for password-grant failures to avoid
 * revealing whether an account exists. This function preserves that message
 * and distinguishes these other failures:
 *
 *   - **501 `not_implemented`** -- the deployment has no Supabase publishable
 *     key configured. Nothing about the worker's credentials. Telling them
 *     their password was wrong here would send them to reset a password that
 *     is fine.
 *   - **429 `rate_limited`** -- wait, do not retype.
 *   - **502 `auth_upstream_failed`** -- Supabase itself, not this account.
 *   - **no response at all** -- the network, and the origin is named because
 *     `--api` pointing somewhere wrong looks exactly like an outage.
 */
export async function signIn(
	apiOrigin: string,
	email: string,
	password: string,
	call: typeof globalThis.fetch,
): Promise<Grant> {
	let response: Response;

	try {
		response = await call(`${apiOrigin}/auth/signin`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ email, password }),
		});
	} catch (error: unknown) {
		throw new SignInFailed(
			`the API at ${apiOrigin} could not be reached (${error instanceof Error ? error.name : "no response"})`,
			null,
			null,
		);
	}

	const body: unknown = await response.json().catch(() => null);
	const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;

	if (!response.ok) {
		const code = typeof record?.["error"] === "string" ? String(record["error"]) : null;
		const message =
			typeof record?.["message"] === "string" ? String(record["message"]) : `the API answered HTTP ${response.status}`;

		throw new SignInFailed(message, response.status, code);
	}

	const accessToken = record?.["accessToken"];
	const refreshToken = record?.["refreshToken"];
	const accountId = record?.["accountId"];

	if (typeof accessToken !== "string" || accessToken === "") {
		throw new SignInFailed("the API answered a signin with no access token", response.status, null);
	}

	return {
		accessToken,
		refreshToken: typeof refreshToken === "string" && refreshToken !== "" ? refreshToken : null,
		accountId: typeof accountId === "string" && accountId !== "" ? accountId : null,
		source: "signin",
	};
}

/**
 * Ask for an email and a password on a terminal, with the password not echoed.
 *
 * The secret path reads bytes directly with terminal echo disabled through
 * the documented `isTTY` and `setRawMode` APIs; pipes do not echo. It avoids
 * readline for passwords because keystroke echo can bypass internal output
 * overrides. Injectable streams let tests verify the actual output.
 * The non-secret path uses `node:readline/promises`.
 *
 * Raw mode means this loop owns the keyboard for its duration, so it handles
 * the two keys a person will actually press: backspace deletes a character
 * (without it, a typo is unfixable and the sign-in fails with no visible
 * reason), and Ctrl-C refuses rather than being swallowed as a character -- in
 * raw mode nothing else will deliver SIGINT, and a prompt that cannot be
 * escaped is worse than one that echoes.
 *
 * A non-secret answer is trimmed; a secret one is not. A password with a
 * leading space is a password with one, and trimming it would sign the worker
 * in as somebody who does not exist, or fail forever with no visible reason.
 */
export function terminalPrompt(
	streams: { readonly input?: NodeJS.ReadableStream; readonly output?: NodeJS.WritableStream } = {},
): CredentialPrompt {
	const input = streams.input ?? process.stdin;
	const output = streams.output ?? process.stdout;

	return async (question: string, secret: boolean): Promise<string> => {
		if (secret) return readWithoutEcho(input, output, question);

		const { createInterface } = await import("node:readline/promises");
		const rl = createInterface({ input, output, terminal: true });

		try {
			return (await rl.question(question)).trim();
		} finally {
			rl.close();
		}
	};
}

/**
 * One line off `input`, with nothing of it written to `output`.
 *
 * See {@link terminalPrompt}'s header for why this does not go through
 * readline. The stream is left as it was found: raw mode is restored to its
 * previous value and the listener is removed, so a `connect` that prompts does
 * not leave the worker's terminal in a state their shell did not put it in.
 */
function readWithoutEcho(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
	question: string,
): Promise<string> {
	output.write(question);

	const tty = input as NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => void };
	const controllable = tty.isTTY === true && typeof tty.setRawMode === "function";
	const wasRaw = tty.isRaw === true;

	if (controllable) tty.setRawMode?.(true);

	return new Promise<string>((resolve, reject) => {
		let value = "";

		const restore = (): void => {
			input.removeListener("data", onData);
			if (controllable) tty.setRawMode?.(wasRaw);
			// The newline the person typed was never echoed, so the cursor is
			// still on the question's line. This is that newline.
			output.write("\n");
			input.pause();
		};

		const onData = (chunk: Buffer | string): void => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");

			for (const character of text) {
				if (character === "\n" || character === "\r") {
					restore();
					resolve(value);

					return;
				}

				// Ctrl-C. In raw mode the terminal does not turn this into a
				// signal, so a prompt that treated it as a character could not be
				// escaped at all.
				if (character === "\u0003") {
					restore();
					reject(new SignInFailed("the sign-in was cancelled", null, null));

					return;
				}

				// Backspace / delete. Without it a typo is unfixable and the
				// sign-in fails with nothing on screen to explain why.
				if (character === "\u007f" || character === "\b") {
					value = value.slice(0, -1);
					continue;
				}

				value += character;
			}
		};

		input.on("data", onData);
	});
}

/**
 * The bearer this run will use, and where it came from.
 *
 * Three sources, in this order, and the order is the deliberate part:
 *
 *   1. `accessToken` on the options -- `--token` on the command line. An
 *      explicit instruction beats everything.
 *   2. `EZIL_ACCESS_TOKEN` in the environment. Same thing, less visible.
 *   3. An email and a password: `EZIL_EMAIL` / `EZIL_PASSWORD` when they are
 *      set (a CI runner, a provisioning script -- somewhere with no terminal
 *      to type into), otherwise asked for.
 *
 * The environment is read for the password rather than only a prompt because
 * the alternative is worse in practice: a non-interactive runner with no way to
 * answer would otherwise have `--token` as its only path, and a long-lived
 * pasted bearer in a CI variable is a strictly larger secret than an account
 * password with a rate limit and a refresh cycle behind it.
 */
export async function resolveGrant(options: ConnectOptions): Promise<Grant> {
	const environment = options.environment ?? process.env;
	const call = options.fetch ?? globalThis.fetch;

	const explicit = options.accessToken ?? environment["EZIL_ACCESS_TOKEN"];
	if (explicit !== undefined && explicit !== "") {
		return { accessToken: explicit, refreshToken: null, accountId: null, source: "token" };
	}

	const ask = options.ask ?? terminalPrompt();

	const email = environment["EZIL_EMAIL"] ?? (await ask("EZiL email: ", false));
	if (email.trim() === "") throw new SignInFailed("no email was given", null, null);

	const password = environment["EZIL_PASSWORD"] ?? (await ask("Password (not shown): ", true));
	if (password === "") throw new SignInFailed("no password was given", null, null);

	return signIn(options.apiOrigin, email.trim(), password, call);
}

/* ------------------------------------------------------------------------- *
 * The MCP connection -- the same identity reference as the Works web client
 * ------------------------------------------------------------------------- */

/** What `builder_profiles.mcp_provider` records for a connection made this way. */
export const MCP_PROVIDER = "mcp.ezil.work";

/**
 * ==========================================================================
 * THE RULE: the connection's `tokenRef` is the Supabase auth user id.
 * ==========================================================================
 *
 * The reference is the verified auth user's `sub`, already stored as
 * `accounts.auth_user_id`. It identifies the account without copying the
 * access token or a hash of that credential.
 *
 * The EZiL Works repository keeps a separate copy of this derivation for its
 * web client. Keeping the copies separate avoids browser-only environment
 * dependencies in the CLI and a server dependency on `@ezil/cli`.
 * The same named rule and test vector keep their outputs aligned; see
 * `connect.test.ts`'s `SHARED_SUB` and `docs/ARCHITECTURE.md`.
 */
export const MCP_TOKEN_REF_RULE = "supabase-auth-user-id";

export function mcpTokenRefFor(authUserId: string): string {
	const reference = authUserId.trim();
	if (reference === "") throw new SignInFailed("the session carried no account id to reference", null, null);

	return reference;
}

/**
 * Who the bearer belongs to, according to `GET /v1/me`.
 *
 * ## Why this exists at all
 * Sign-in returns the account id directly. A pasted bearer has no attached
 * identity, so `--token` asks the EZiL Works API through GET /v1/me.
 * Its `accountId` is the verified Supabase `sub`. The CLI has no verification
 * key and does not trust a local JWT decode to identify the account.
 *
 * Soft, like its two neighbours: a bearer that `/v1/me` refuses is still worth
 * installing hooks for, and the reason is carried rather than thrown.
 */
export async function accountIdFromMe(
	apiOrigin: string,
	accessToken: string,
	call: typeof globalThis.fetch,
): Promise<{ readonly accountId: string } | { readonly reason: string }> {
	let response: Response;

	try {
		response = await call(`${apiOrigin}/v1/me`, {
			headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
		});
	} catch (error: unknown) {
		return {
			reason: `the API at ${apiOrigin} could not be reached (${error instanceof Error ? error.name : "no response"})`,
		};
	}

	const body: unknown = await response.json().catch(() => null);
	const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;

	if (!response.ok) {
		const message = typeof record?.["message"] === "string" ? String(record["message"]) : `HTTP ${response.status}`;

		return { reason: message };
	}

	const accountId = record?.["accountId"];
	if (typeof accountId !== "string" || accountId === "") {
		return { reason: "the API answered /v1/me without an account id to reference" };
	}

	return { accountId };
}

/**
 * Record the connection -- `POST /v1/builder/mcp-connection`./**
 * Record the connection -- `POST /v1/builder/mcp-connection`.
 *
 * Soft, like {@link todaysContract} and for the same reason: a worker whose
 * builder profile does not exist yet (404 `builder_profile_missing`), or who is
 * signed in as a creator, still wants the hooks installed and the spool
 * running. Returning the reason rather than throwing is what lets `connect`
 * say which of the four things it did and which it could not.
 *
 * The `authUserId` it is given comes from the sign-in on the documented path
 * and from {@link accountIdFromMe} on the `--token` one. It is never invented
 * and never decoded out of the bearer: a `tokenRef` this package guessed would
 * be a reference to nothing, in a column that must never hold one.
 */
export async function recordMcpConnection(
	apiOrigin: string,
	accessToken: string,
	authUserId: string,
	call: typeof globalThis.fetch,
): Promise<{ readonly provider: string } | { readonly reason: string }> {
	let response: Response;

	try {
		response = await call(`${apiOrigin}/v1/builder/mcp-connection`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({ provider: MCP_PROVIDER, tokenRef: mcpTokenRefFor(authUserId) }),
		});
	} catch (error: unknown) {
		return {
			reason: `the API at ${apiOrigin} could not be reached (${error instanceof Error ? error.name : "no response"})`,
		};
	}

	if (!response.ok) {
		const detail: unknown = await response.json().catch(() => null);
		const message =
			typeof detail === "object" && detail !== null && typeof (detail as Record<string, unknown>)["message"] === "string"
				? String((detail as Record<string, unknown>)["message"])
				: `HTTP ${response.status}`;

		return { reason: message };
	}

	return { provider: MCP_PROVIDER };
}

export interface TodaysContract {
	readonly contractPublicId: string;
	readonly repository: string;
	readonly businessDate: string;
}

export interface ConnectResult {
	readonly credentialsFile: string;
	readonly settingsFile: string;
	readonly contract: TodaysContract | null;
	readonly added: readonly string[];
	readonly alreadyPresent: readonly string[];
	/** Why there is no contract, when there is none. Never a silent null. */
	readonly contractUnavailable: string | null;
	/**
	 * How the bearer was obtained. Never the bearer, and never the password:
	 * this is the only thing about the grant that leaves {@link connect}.
	 */
	readonly signedInAs: Grant["source"];
	/** The provider recorded on `builder_profiles`, or null if nothing was. */
	readonly mcpProvider: string | null;
	/** Why the connection was not recorded, when it was not. Never a silent null. */
	readonly mcpConnectionUnavailable: string | null;
}

/**
 * The day's contract, or the reason there is not one.
 *
 * A refusal is returned rather than thrown: a worker with no contract agreed
 * yet still wants the hooks installed, and a `connect` that failed on
 * `no_contract_today` would leave them with nothing recording the day they are
 * about to agree to.
 */
export interface ContractUnavailable {
	readonly reason: string;
	/**
	 * The status the API answered with, when it answered at all.
	 *
	 * Carried because 401 is not "no contract today" -- it is an expired bearer,
	 * and the two need different sentences: one is "agree your day", the other is
	 * "connect again". `flush.ts` reads this and says the right one.
	 */
	readonly status: number | null;
}

export async function todaysContract(
	apiOrigin: string,
	accessToken: string,
	call: typeof globalThis.fetch,
): Promise<{ contract: TodaysContract } | ContractUnavailable> {
	let response: Response;
	try {
		response = await call(`${apiOrigin}/v1/contracts/today`, {
			headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
		});
	} catch (error: unknown) {
		return {
			reason: `the API at ${apiOrigin} could not be reached (${error instanceof Error ? error.name : "no response"})`,
			status: null,
		};
	}

	if (!response.ok) {
		const detail: unknown = await response.json().catch(() => null);
		const message =
			typeof detail === "object" && detail !== null && typeof (detail as Record<string, unknown>)["message"] === "string"
				? String((detail as Record<string, unknown>)["message"])
				: `HTTP ${response.status}`;
		return { reason: message, status: response.status };
	}

	const body: unknown = await response.json().catch(() => null);
	const contract = (body as Record<string, unknown> | null)?.["contract"];
	if (typeof contract !== "object" || contract === null) {
		return { reason: "the API answered without a contract", status: response.status };
	}

	const record = contract as Record<string, unknown>;
	const publicId = record["publicId"];
	const repository = record["repository"];
	const businessDate = record["businessDate"];

	if (typeof publicId !== "string" || typeof repository !== "string") {
		return { reason: "the API's contract carried no public id or repository", status: response.status };
	}

	return {
		contract: {
			contractPublicId: publicId,
			repository,
			businessDate: typeof businessDate === "string" ? businessDate : "",
		},
	};
}

/** Merge the six hooks into the project's settings, preserving everything else. */
export function installHooks(projectRoot: string): { file: string; added: readonly string[]; alreadyPresent: readonly string[] } {
	const file = claudeSettingsPath(projectRoot);

	let existing: unknown = null;
	if (existsSync(file)) {
		try {
			existing = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			// A settings file that does not parse is not overwritten silently --
			// it is merged onto as though empty, and the caller is told what was
			// added. Refusing outright would leave a worker unable to connect
			// because of a stray comma in a file they may not know they have.
			existing = null;
		}
	}

	const merged = mergeHooks(existing, desiredHooks());

	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(merged.settings, null, 2)}\n`, { encoding: "utf8" });

	return { file, added: merged.added, alreadyPresent: merged.alreadyPresent };
}

export async function connect(options: ConnectOptions): Promise<ConnectResult> {
	const call = options.fetch ?? globalThis.fetch;

	/*
	 * FIRST, and nothing is written before it resolves.
	 *
	 * A `SignInFailed` propagates out of `connect` untouched: the caller has no
	 * credential, so there is nothing to write and nothing to install hooks
	 * for. The alternative -- catching it and carrying on -- would leave
	 * `~/.ezil/credentials` holding a token that does not work, and `ezil flush`
	 * would then present a dead session as a live one for as long as the file
	 * sat there.
	 */
	const grant = await resolveGrant(options);

	const today = await todaysContract(options.apiOrigin, grant.accessToken, call);
	const contract = "contract" in today ? today.contract : null;

	const credentials: StoredCredentials = {
		accessToken: grant.accessToken,
		// Sign-in supplies a refresh token; `--token` supplies only a bearer.
		// Store the grant unchanged so a pasted token has a null refresh token.
		// The EZiL Works API can exchange sign-in refresh tokens at
		// POST /auth/refresh. The session flush flow does not currently
		// perform that exchange automatically.
		refreshToken: grant.refreshToken,
		apiOrigin: options.apiOrigin,
		...(contract === null ? {} : { contractPublicId: contract.contractPublicId, repository: contract.repository }),
	};

	const credentialsFile = writeCredentials(credentials, options.environment ?? process.env);

	/*
	 * The connection, against a reference this process was TOLD rather than one
	 * it worked out.
	 *
	 * A sign-in reports the `sub` itself; `--token` does not, so the server that
	 * verified the bearer is asked (`GET /v1/me`). Either way the value arrives
	 * from the EZiL Works API and never from decoding the token here. If it cannot be
	 * obtained the connection is skipped with the reason said out loud, because
	 * a builder whose gate is still shut needs to know which of the four things
	 * `connect` does did not happen.
	 */
	const identity =
		grant.accountId === null
			? await accountIdFromMe(options.apiOrigin, grant.accessToken, call)
			: { accountId: grant.accountId };

	const connection =
		"reason" in identity
			? identity
			: await recordMcpConnection(options.apiOrigin, grant.accessToken, identity.accountId, call);

	const hooks = installHooks(options.projectRoot);

	return {
		credentialsFile,
		settingsFile: hooks.file,
		contract,
		added: hooks.added,
		alreadyPresent: hooks.alreadyPresent,
		contractUnavailable: "reason" in today ? today.reason : null,
		signedInAs: grant.source,
		mcpProvider: "provider" in connection ? connection.provider : null,
		mcpConnectionUnavailable: "reason" in connection ? connection.reason : null,
	};
}

/**
 * What connecting says, and it says the second half whether or not anyone asks.
 *
 * Connecting states plainly what the hooks record, as described in
 * `docs/ARCHITECTURE.md`. The notice names the collected evidence and excluded
 * content so the worker can understand what leaves their editor.
 */
export function connectNotice(result: ConnectResult): string {
	const lines: string[] = [];

	lines.push("Connected.");
	lines.push("");
	lines.push(
		`  signed in    ${result.signedInAs === "signin" ? "with your email and password" : "with a bearer you supplied (--token)"}`,
	);
	lines.push(`  credential   ${result.credentialsFile} (mode 0600; the OS keychain is a follow-up, not this)`);
	lines.push(`  hooks        ${result.settingsFile}`);

	if (result.mcpProvider !== null) {
		lines.push(`  connection   ${result.mcpProvider} recorded against your account`);
	} else {
		lines.push(`  connection   not recorded -- ${result.mcpConnectionUnavailable ?? "not resolved"}`);
		lines.push("               EZiL will not assign work until it is; the hooks below still spool.");
	}

	if (result.contract !== null) {
		lines.push(`  contract     ${result.contract.contractPublicId}`);
		lines.push(`  repository   ${result.contract.repository}`);
	} else {
		lines.push(`  contract     none today -- ${result.contractUnavailable ?? "not resolved"}`);
		lines.push("               the hooks are installed and will spool; nothing is sent until a contract exists.");
	}

	lines.push("");
	lines.push(`  installed    ${result.added.length === 0 ? "(nothing new)" : result.added.join(", ")}`);
	if (result.alreadyPresent.length > 0) {
		lines.push(`  already      ${result.alreadyPresent.join(", ")}`);
	}
	lines.push(`               PreToolUse/PostToolUse match ${TOOL_MATCHER}; other hooks in this file were left alone.`);

	lines.push("");
	lines.push("WHAT IS SENT");
	lines.push("  - when a session starts: the repository, branch, head commit and model id");
	lines.push("  - for each prompt: a SHA-256 digest, and a redacted opening of at most 512 characters");
	lines.push("  - for each tool call: the tool's name, a redacted command, and the file path -- path only");
	lines.push("  - for each result: the exit status if one was reported, the byte count, and a redacted");
	lines.push("    excerpt of at most the first and last 4 KB");
	lines.push("  - when the session ends: the head commit, whether the tree was dirty, and how long it ran");
	lines.push("");
	lines.push("WHAT IS NOT SENT");
	lines.push("  - your prompts. There is no verbatim field on the wire contract and none is built.");
	lines.push("  - file contents, diffs or patches. No field carries them.");
	lines.push("  - anything outside this repository. A tool that acts elsewhere is recorded as having done");
	lines.push("    so, with no path and no command.");
	lines.push("  - credentials. Anything shaped like an API key, a GitHub token, an AWS key, a JWT or a");
	lines.push("    private key is replaced before it reaches the spool -- and if one gets through, the");
	lines.push("    server refuses the whole batch rather than storing it.");
	lines.push("");
	lines.push("The spool is .ezil/ in this repository. Add it to .gitignore; nothing here edits your ignore file.");
	lines.push("");
	lines.push("WHAT IS STORED ABOUT THIS CONNECTION");
	lines.push("  - on your machine: the session tokens, in the 0600 file named above and nowhere else.");
	lines.push("  - on EZiL: the provider and a REFERENCE to your identity -- your Supabase account id, which");
	lines.push("    is not a credential and cannot be signed in with. Your password is never stored anywhere");
	lines.push("    by this command, and no token is ever sent to EZiL as the connection's reference.");

	return lines.join("\n");
}
