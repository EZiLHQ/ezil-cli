import { z } from "zod";

/**
 * The pinned contract between the github.ezil.work gateway Worker
 * (`apps/git-gateway`) and the Works API (`POST /internal/git/authorize`,
 * `POST /internal/git/annotate`). EZiL CLI plan, sections B and C.
 *
 * Both sides import this file. It's the only description of the wire format,
 * so a worker building one side can't invent a second version of it.
 *
 * Signing: HMAC-SHA256 over `${timestamp}.${body}` with `GIT_GATEWAY_SECRET`.
 * It's sent as hex in `x-ezil-signature`, with a 13-digit millisecond
 * `x-ezil-timestamp` that must be within 5 minutes. This is the same scheme as
 * `/internal/repository-push-events`, with a separate secret.
 */

export const GIT_GATEWAY_SIGNATURE_HEADER = "x-ezil-signature";
export const GIT_GATEWAY_TIMESTAMP_HEADER = "x-ezil-timestamp";
export const GIT_GATEWAY_MAX_SKEW_MS = 5 * 60_000;
/** The only username a git grant is sent with. The gateway ignores it, and checks only the password. */
export const GIT_GRANT_USERNAME = "ezil";
/** Plaintext grants are `egg_` + 64 hex chars, so log redaction and secret scanners can match them. */
export const GIT_GRANT_PATTERN = /^egg_[0-9a-f]{64}$/;

export const GIT_SERVICES = ["git-upload-pack", "git-receive-pack"] as const;
export const GitServiceSchema = z.enum(GIT_SERVICES);
export type GitService = z.infer<typeof GitServiceSchema>;

/** The Artifacts scope a Git service needs. Push is the only write. */
export function scopeForService(service: GitService): "read" | "write" {
	return service === "git-receive-pack" ? "write" : "read";
}

export const ROUTE_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROUTE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * `/<namespace>/<repo>.git/<rest>` → its parts, or null. Strict on purpose, so no path trick
 * reaches the lookup: no `..`, no encoded slash, no trailing `.git.git`, lowercase only.
 */
export function parseGitRoutePath(pathname: string): { routeNamespace: string; routeName: string; rest: string } | null {
	const match = /^\/([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9._-]{0,99})\.git(\/.*)?$/.exec(pathname);
	if (!match) return null;
	const [, routeNamespace, routeName, rest = ""] = match;
	if (!routeNamespace || !routeName || routeName.includes("..") || routeName.endsWith(".git")) return null;
	if (rest !== "" && !["/info/refs", "/git-upload-pack", "/git-receive-pack"].includes(rest)) return null;
	return { routeNamespace, routeName, rest };
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const RefUpdateSchema = z.object({
	ref: z.string().min(1).max(255),
	old: sha,
	new: sha,
}).strict();
export type RefUpdate = z.infer<typeof RefUpdateSchema>;

export const GitAuthorizeRequestSchema = z.object({
	grant: z.string().regex(GIT_GRANT_PATTERN),
	routeNamespace: z.string().regex(ROUTE_NAMESPACE_PATTERN),
	routeName: z.string().regex(ROUTE_NAME_PATTERN),
	service: GitServiceSchema,
	/** The gateway's own ID for this HTTP request; it's echoed into the audit row. */
	requestId: z.uuid(),
	cfRay: z.string().max(64).nullable(),
	/** SHA-256 hex of the client IP and a gateway salt; the raw IP never leaves the edge. */
	ipHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
}).strict();
export type GitAuthorizeRequest = z.infer<typeof GitAuthorizeRequestSchema>;

export const GitAuthorizeAllowSchema = z.object({
	decision: z.literal("allow"),
	/** The exact Artifacts remote to forward to. The gateway checks it against the Artifacts host pattern. */
	artifactsRemote: z.string().regex(/^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/),
	/** Never logged, never cached past `expiresAt`, never returned to the Git client. */
	artifactsToken: z.string().min(1),
	scope: z.enum(["read", "write"]),
	expiresAt: z.iso.datetime(),
	/** Public ID of the audit row for this operation, used by `annotate`. Null when reads aren't audited per call. */
	operationId: z.uuid().nullable(),
}).strict();
export type GitAuthorizeAllow = z.infer<typeof GitAuthorizeAllowSchema>;

export const GIT_DENY_REASONS = [
	"grant_invalid", "grant_expired", "grant_revoked", "session_revoked", "repository_not_found",
	"repo_not_selected", "scope_read_only", "authority_lapsed", "account_suspended",
] as const;
export const GitDenyReasonSchema = z.enum(GIT_DENY_REASONS);
export type GitDenyReason = z.infer<typeof GitDenyReasonSchema>;

/**
 * 401 means re-authenticate: the helper will mint a fresh grant. 403 means forbidden, so don't retry.
 * `message` is a fixed sentence per reason, safe to show to the builder through Git.
 */
export const GitAuthorizeDenySchema = z.object({
	decision: z.literal("deny"),
	status: z.union([z.literal(401), z.literal(403), z.literal(404)]),
	reason: GitDenyReasonSchema,
	message: z.string().max(200),
}).strict();
export type GitAuthorizeDeny = z.infer<typeof GitAuthorizeDenySchema>;

export const GitAuthorizeResponseSchema = z.discriminatedUnion("decision", [GitAuthorizeAllowSchema, GitAuthorizeDenySchema]);
export type GitAuthorizeResponse = z.infer<typeof GitAuthorizeResponseSchema>;

/** After authorizing a push, the gateway reports the ref commands it read from the receive-pack prefix. */
export const GitAnnotateRequestSchema = z.object({
	operationId: z.uuid(),
	requestId: z.uuid(),
	refUpdates: z.array(RefUpdateSchema).min(1).max(100),
}).strict();
export type GitAnnotateRequest = z.infer<typeof GitAnnotateRequestSchema>;

/** The gateway's own audit-volume rule: always audit push and every denial; audit reads once per grant. */
export const GIT_DENY_MESSAGES: Readonly<Record<GitDenyReason, string>> = {
	grant_invalid: "EZiL: your Git credential is not valid. Run `ezil auth login`.",
	grant_expired: "EZiL: your Git credential expired. Git will fetch a new one; if this repeats, run `ezil auth login`.",
	grant_revoked: "EZiL: this Git credential was revoked. Run `ezil auth login`.",
	session_revoked: "EZiL: this device was signed out. Run `ezil auth login`.",
	repository_not_found: "EZiL: repository not found, or you do not have access to it.",
	repo_not_selected: "EZiL: this repository is not selected for any of your open tasks.",
	scope_read_only: "EZiL: you have read-only access to this repository; push is not allowed.",
	authority_lapsed: "EZiL: your access to this task has ended (task closed, approval or entitlement lapsed).",
	account_suspended: "EZiL: this account is suspended.",
};
