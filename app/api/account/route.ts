/**
 * GET /api/account — the caller's public account metadata.
 *
 * Registration opens after the first-administrator bootstrap commits: a
 * verified identity with no local account gets one created here (idempotent,
 * serialized). Before bootstrap this returns `bootstrapRequired: true` and
 * creates nothing. No subject, UID/GID, home path, or secret is exposed.
 */

import {
	ensureAccount,
	findAccountBySubject,
	json,
	problem,
	readAccountRegistry,
	readSession,
	registryOptionsFor,
	requireMultiuser,
	RegistryError,
	toPublicAccount,
} from "@/src/multiuser";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const context = requireMultiuser();
	if (!context.ok) return context.response;
	const session = await readSession(request, context.config);
	if (!session) return problem(401, "session_required", "Sign in to view this account.");

	try {
		const registry = readAccountRegistry(context.config.paths.controllerStateDir);
		if (!registry.bootstrap) {
			return json({
				bootstrapRequired: true,
				account: null,
				provider: context.config.auth.provider,
				learningAvailable: false,
			});
		}
		const existing = findAccountBySubject(registry, session.subject);
		const account = existing ?? ensureAccount(registryOptionsFor(context.config), session.subject);
		return json({
			bootstrapRequired: false,
			account: toPublicAccount(account),
			provider: context.config.auth.provider,
			learningAvailable: false,
		});
	} catch (error) {
		if (error instanceof RegistryError) {
			const status = error.code === "account_not_active" ? 403 : 503;
			return problem(status, error.code, error.message);
		}
		throw error;
	}
}
