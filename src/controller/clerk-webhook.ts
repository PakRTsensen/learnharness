/**
 * CLERK WEBHOOK VERIFICATION (per-user accounts, Phase 2, 2026-11-12).
 *
 * Clerk webhooks are signed with the Svix scheme. Verification is local:
 *
 *   signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   signature     = base64(HMAC-SHA256(base64decode(whsec_...), signedContent))
 *
 * A verified `user.deleted` event starts account disablement only; it never
 * erases data and is never an administrator-creation authority. Timestamp
 * tolerance bounds replay of a captured request.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export type WebhookFailureCode =
	| "webhook_configuration_missing"
	| "webhook_body_too_large"
	| "webhook_signature_missing"
	| "webhook_timestamp_invalid"
	| "webhook_signature_invalid";

export type WebhookResult = { ok: true } | { ok: false; code: WebhookFailureCode; message: string };

function decodeSecret(secret: string): Buffer | undefined {
	if (!secret.startsWith("whsec_") || secret.length <= "whsec_".length) return undefined;
	try {
		const decoded = Buffer.from(secret.slice("whsec_".length), "base64");
		return decoded.length > 0 ? decoded : undefined;
	} catch {
		return undefined;
	}
}

export function verifyClerkWebhook(input: {
	payload: string;
	headers: Headers;
	secret: string | undefined;
	now?: Date;
}): WebhookResult {
	if (!input.secret) {
		return { ok: false, code: "webhook_configuration_missing", message: "The Clerk webhook secret is not configured." };
	}
	if (Buffer.byteLength(input.payload, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
		return { ok: false, code: "webhook_body_too_large", message: "The webhook payload is too large." };
	}
	const id = input.headers.get("svix-id");
	const timestamp = input.headers.get("svix-timestamp");
	const signatures = input.headers.get("svix-signature");
	if (!id || !timestamp || !signatures) {
		return { ok: false, code: "webhook_signature_missing", message: "The webhook signature headers are missing." };
	}
	const seconds = Number(timestamp);
	const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
	if (!Number.isSafeInteger(seconds) || Math.abs(now - seconds) > TIMESTAMP_TOLERANCE_SECONDS) {
		return { ok: false, code: "webhook_timestamp_invalid", message: "The webhook timestamp is outside the accepted window." };
	}
	const key = decodeSecret(input.secret);
	if (!key) {
		return { ok: false, code: "webhook_configuration_missing", message: "The Clerk webhook secret is invalid." };
	}
	const expected = createHmac("sha256", key)
		.update(`${id}.${timestamp}.${input.payload}`, "utf8")
		.digest();

	for (const entry of signatures.split(" ")) {
		const comma = entry.indexOf(",");
		if (comma < 0) continue;
		const version = entry.slice(0, comma);
		const value = entry.slice(comma + 1);
		if (version !== "v1" || !value) continue;
		let supplied: Buffer;
		try {
			supplied = Buffer.from(value, "base64");
		} catch {
			continue;
		}
		if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return { ok: true };
	}
	return { ok: false, code: "webhook_signature_invalid", message: "The webhook signature is invalid." };
}
