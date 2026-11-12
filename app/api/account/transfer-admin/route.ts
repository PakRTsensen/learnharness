/**
 * POST /api/account/transfer-admin — move the administrator role.
 *
 * Registry metadata only: an administrator gains no API to read another
 * account's content, invoke its work, or obtain its credentials.
 */

import {
	ACCOUNT_ID_PATTERN,
	json,
	problem,
	readJsonBody,
	readSession,
	registryOptionsFor,
	requireMultiuser,
	RegistryError,
	toPublicAccount,
	transferAdministrator,
} from "@/src/multiuser";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const context = requireMultiuser();
	if (!context.ok) return context.response;
	const session = await readSession(request, context.config);
	if (!session) return problem(401, "session_required", "Sign in to transfer the administrator role.");

	const body = await readJsonBody(request, 4096);
	if (!body.ok) return body.response;
	if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
		return problem(400, "body_invalid", "Expected a JSON object with an accountId.");
	}
	const accountId = (body.value as Record<string, unknown>).accountId;
	if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
		return problem(400, "account_id_invalid", "Enter a valid internal account id.");
	}

	try {
		const account = transferAdministrator(registryOptionsFor(context.config), session.subject, accountId);
		return json({ ok: true, account: toPublicAccount(account) });
	} catch (error) {
		if (error instanceof RegistryError) {
			const status =
				error.code === "administrator_required" ? 403 :
				error.code === "account_not_found" ? 404 :
				error.code === "target_is_administrator" ? 409 :
				error.code === "account_not_active" ? 409 : 503;
			return problem(status, error.code, error.message);
		}
		throw error;
	}
}
