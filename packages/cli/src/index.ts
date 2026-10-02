/**
 * What `@ezil/cli` exposes to a program rather than to a shell.
 *
 * The bin is `bin/ezil.ts` and it is the whole user interface. This barrel
 * exists so the pure parts -- redaction, event building, the spool, the
 * settings merge -- are importable by a test and by anything that later wants
 * to reuse them, without going through a process.
 */
export { excerptOf, redact, redactionsIn, REDACTED, REDACTION_PATTERNS } from "./core/redact";
export {
	digestOf,
	eventFor,
	exitCodeIn,
	HOOK_KINDS,
	locate,
	outputTextIn,
	promptEvent,
	summaryOf,
	toolCommandIn,
	toolPathIn,
	type EventContext,
	type HookInput,
	type HookKind,
	type Location,
	type RepositoryBinding,
} from "./modules/sessions/events";
export {
	appendEvent,
	MAX_BATCH_EVENTS,
	pendingBatches,
	readCursor,
	readSpool,
	writeCursor,
	type PendingBatch,
	type SpoolCursor,
} from "./modules/sessions/spool";
export {
	desiredHooks,
	installedCommands,
	mergeHooks,
	TOOL_MATCHER,
	type DesiredHook,
	type HookGroup,
	type MergeResult,
} from "./modules/sessions/settings-merge";
export { connect, connectNotice, installHooks, todaysContract, type ConnectResult } from "./modules/sessions/connect";
export {
	flush,
	FLUSH_LOCK_STALE_MS,
	patternsInBatch,
	releaseFlushLock,
	spooledSessions,
	takeFlushLock,
	type BatchOutcome,
	type FlushResult,
} from "./modules/sessions/flush";
export { readBinding, writeBinding, type StoredBinding } from "./modules/sessions/binding";
export {
	bindRepository,
	hookOutcome,
	promptOutcome,
	repositoryFromRemote,
	sessionIdOf,
	logFailure,
	spawnFlush,
	type HookOutcome,
	type HookRunOptions,
} from "./modules/sessions/hook";
export {
	credentialsMode,
	CREDENTIALS_MODE,
	readCredentials,
	writeCredentials,
	type StoredCredentials,
} from "./core/credentials";
export * from "./core/paths";
export { accessToken, apiOriginOf, DEFAULT_API_ORIGIN, fileStore, keychainStore, storeFor, type CliSession, type Io, type SessionStore } from "./core/session";
export { login, logout, sessions, whoami, type SetupStep } from "./core/auth";
export { GIT_HOSTS, gitConfigCommands, gitCredential, gitSetup } from "./modules/git/credential";
