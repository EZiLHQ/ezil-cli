import { GIT_GATEWAY_SIGNATURE_HEADER, GIT_GATEWAY_TIMESTAMP_HEADER } from "@ezil/cli-contract/git-gateway";

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(value: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** The same scheme as valuator-events → /internal/repository-push-events: hex HMAC-SHA256 over `${stamp}.${body}`. */
export async function signedHeaders(secret: string, body: string, now: number): Promise<Record<string, string>> {
	const stamp = String(now);
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${stamp}.${body}`)));
	return { "content-type": "application/json", [GIT_GATEWAY_TIMESTAMP_HEADER]: stamp, [GIT_GATEWAY_SIGNATURE_HEADER]: signature };
}
