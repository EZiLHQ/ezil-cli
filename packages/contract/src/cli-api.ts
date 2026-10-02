import { z } from "zod";

/**
 * The `/cli/*` HTTP contract between the EZiL CLI (EZiLHQ/ezil-cli) and the EZiL Works API.
 *
 * The EZiL Works repository keeps the same file. Each repository pins its digest
 * (see `digest.ts`) to detect local wire-format changes. Requests are strict because
 * the API refuses unknown fields. Responses allow additions without breaking installed clients.
 */

export const CLI_OS = ["darwin", "linux", "win32", "freebsd", "other"] as const;

export const DeviceLoginRequestSchema = z.object({
	deviceLabel: z.string().trim().min(1).max(80),
	os: z.enum(CLI_OS),
	cliVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
}).strict();

export const DeviceLoginResponseSchema = z.object({
	deviceCode: z.string().regex(/^ecd_[0-9a-f]{64}$/),
	userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
	verificationUri: z.url(),
	verificationUriComplete: z.url(),
	expiresAt: z.iso.datetime(),
	interval: z.number().int().positive(),
});

/** `/cli/login/describe` and `/cli/login/approve` take a Supabase web session, not a CLI token. */
export const UserCodeRequestSchema = z.object({ userCode: z.string().regex(/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/) }).strict();

export const DescribeLoginResponseSchema = z.object({
	device: z.string(),
	os: z.string(),
	cliVersion: z.string(),
	startedSecondsAgo: z.number().int().nonnegative(),
	expiresAt: z.iso.datetime(),
});

export const ApproveLoginResponseSchema = z.object({ approved: z.literal(true), device: z.string() });

export const TokenRequestSchema = z.discriminatedUnion("grant_type", [
	z.object({ grant_type: z.literal("device_code"), device_code: z.string().regex(/^ecd_[0-9a-f]{64}$/) }).strict(),
	z.object({ grant_type: z.literal("refresh_token"), refresh_token: z.string().max(200) }).strict(),
]);

export const TokenResponseSchema = z.object({
	access_token: z.string().regex(/^eca_[0-9a-f-]{36}_[0-9a-f]{64}$/),
	refresh_token: z.string().regex(/^ecr_[0-9a-f-]{36}_[0-9a-f]{64}$/),
	token_type: z.literal("Bearer"),
	expires_at: z.iso.datetime(),
	session_id: z.uuid(),
	session_expires_at: z.iso.datetime(),
});

export const WhoamiResponseSchema = z.object({
	account: z.object({ id: z.string(), email: z.string(), role: z.string() }),
	session: z.object({ id: z.uuid(), device: z.string(), os: z.string(), expiresAt: z.iso.datetime() }),
	repositories: z.array(z.object({
		project: z.string(),
		projectId: z.string(),
		repository: z.string(),
		access: z.enum(["read", "write"]),
		taskPublicId: z.string().nullable(),
		cloneUrl: z.string().regex(/^https:\/\/github\.ezil\.work\/[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9._-]{0,99}\.git$/),
	})),
});

export const GitGrantRequestSchema = z.object({ protocol: z.literal("https"), host: z.string().max(253), path: z.string().max(300) }).strict();

export const GitGrantResponseSchema = z.object({
	username: z.literal("ezil"),
	password: z.string().regex(/^egg_[0-9a-f]{64}$/),
	password_expiry_utc: z.number().int().positive(),
	scope: z.enum(["read", "write"]),
});

export const SessionsResponseSchema = z.object({
	sessions: z.array(z.object({
		publicId: z.uuid(),
		deviceLabel: z.string(),
		os: z.string(),
		lastUsedAt: z.iso.datetime(),
		revokedAt: z.iso.datetime().nullable(),
		current: z.boolean(),
	})),
});

export const RevokedResponseSchema = z.object({ revoked: z.literal(true) });

/** Every refusal: a machine code and one sentence for the person. `authorization_pending` is the device poll's "not yet". */
export const CliRefusalSchema = z.object({ error: z.string().min(1), message: z.string() });
