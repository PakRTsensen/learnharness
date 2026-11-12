/**
 * POST /api/webhooks/clerk — verified lifecycle events from Clerk.
 *
 * This is NEVER an administrator-creation or data-erasure authority. The only
 * handled event is `user.deleted`, which starts account disablement. Data is
 * retained for host recovery; the seven-day user-requested recovery flow and
 * non-content cleanup live elsewhere.
 */

import {
	disableAccountBySubject,
	json,
	problem,
	registryOptionsFor,
	requireMultiuser,
	RegistryError,
	verifyClerkWebhook,
} from "@/src/multiuser";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
	const context = requireMultiuser();
	if (!context.ok) return context.response;
	if (context.config.auth.provider !== "clerk") {
		return problem(404, "not_found", "Clerk webhooks are not used by this installation.");
	}
	if (!context.config.auth.webhookSecret) {
		return problem(503, "webhook_not_configured", "CLERK_WEBHOOK_SECRET is not configured.");
	}
	const declared = request.headers.get("content-length");
	if (declared && Number(declared) > MAX_BODY_BYTES) {
		return problem(413, "webhook_body_too_large", "The webhook payload is too large.");
	}

	let payload: string;
	try {
		payload = await request.text();
	} catch {
		return problem(400, "webhook_body_unreadable", "The webhook payload could not be read.");
	}
	const verified = verifyClerkWebhook({
		payload,
		headers: request.headers,
		secret: context.config.auth.webhookSecret,
	});
	if (!verified.ok) {
		const status = verified.code === "webhook_body_too_large" ? 413 : verified.code === "webhook_configuration_missing" ? 503 : 401;
		return problem(status, verified.code, verified.message);
	}

	let event: unknown;
	try {
		event = JSON.parse(payload);
	} catch {
		return problem(400, "webhook_body_invalid", "The webhook payload is not valid JSON.");
	}
	if (!event || typeof event !== "object" || Array.isArray(event)) {
		return problem(400, "webhook_body_invalid", "The webhook payload must be an object.");
	}
	const record = event as Record<string, unknown>;
	if (record.type !== "user.deleted") {
		// Idempotent acknowledgement for events this build does not consume.
		return json({ ok: true, handled: false });
	}
	const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
		? record.data as Record<string, unknown>
		: undefined;
	const subject = data && typeof data.id === "string" ? data.id : undefined;
	if (!subject) {
		return problem(400, "webhook_subject_missing", "The user.deleted event has no subject.");
	}

	try {
		// A missing local account is a normal no-op (the Clerk user may predate
		// this installation or never have registered here).
		disableAccountBySubject(registryOptionsFor(context.config), subject);
	} catch (error) {
		if (error instanceof RegistryError) {
			return problem(503, error.code, "The account lifecycle state could not be updated.");
		}
		throw error;
	}
	return json({ ok: true, handled: true });
}
