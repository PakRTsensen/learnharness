/**
 * POST /api/account/recovery — recover a user-requested deletion inside the
 * seven-day window. Identity-provider disablement cannot be recovered this
 * way; that path needs host recovery.
 */

import {
	json,
	problem,
	readSession,
	recoverAccount,
	registryOptionsFor,
	requireMultiuser,
	RegistryError,
	toPublicAccount,
} from "@/src/multiuser";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const context = requireMultiuser();
	if (!context.ok) return context.response;
	const session = await readSession(request, context.config);
	if (!session) return problem(401, "session_required", "Sign in to recover this account.");

	try {
		const account = recoverAccount(registryOptionsFor(context.config), session.subject);
		return json({ ok: true, account: toPublicAccount(account) });
	} catch (error) {
		if (error instanceof RegistryError) {
			const status =
				error.code === "deletion_window_expired" ? 410 :
				error.code === "account_disabled" ? 409 :
				error.code === "account_not_found" ? 404 : 503;
			return problem(status, error.code, error.message);
		}
		throw error;
	}
}
