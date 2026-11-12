/**
 * POST /api/account/deletion — user-confirmed account deletion request.
 *
 * This immediately disables and fences the account (generation bump) and
 * schedules non-content cleanup after a seven-day recovery window. A sole
 * administrator must transfer the role first.
 */

import {
	json,
	problem,
	readJsonBody,
	readSession,
	registryOptionsFor,
	requireMultiuser,
	RegistryError,
	scheduleAccountDeletion,
	toPublicAccount,
} from "@/src/multiuser";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const context = requireMultiuser();
	if (!context.ok) return context.response;
	const session = await readSession(request, context.config);
	if (!session) return problem(401, "session_required", "Sign in to delete this account.");

	const body = await readJsonBody(request, 4096);
	if (!body.ok) return body.response;
	if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
		return problem(400, "body_invalid", "Expected a JSON confirmation.");
	}
	if ((body.value as Record<string, unknown>).confirm !== "delete") {
		return problem(400, "confirmation_required", "Send {\"confirm\":\"delete\"} to confirm account deletion.");
	}

	try {
		const account = scheduleAccountDeletion(registryOptionsFor(context.config), session.subject);
		return json({ ok: true, account: toPublicAccount(account) }, 202);
	} catch (error) {
		if (error instanceof RegistryError) {
			const status =
				error.code === "transfer_admin_required" ? 409 :
				error.code === "account_disabled" ? 409 :
				error.code === "account_not_found" ? 404 : 503;
			return problem(status, error.code, error.message);
		}
		throw error;
	}
}
