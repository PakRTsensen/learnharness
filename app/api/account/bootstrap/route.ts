/**
 * POST /api/account/bootstrap — host-authorized first-administrator commit.
 *
 * The host-issued secret is verified in constant time and consumed by one
 * serialized registry transaction. Public registration stays closed until the
 * transaction succeeds; failed provisioning commits nothing and can be
 * retried while no account exists.
 */

import {
	bootstrapFirstAdministrator,
	json,
	problem,
	readBootstrapSecret,
	readJsonBody,
	readSession,
	registryOptionsFor,
	requireMultiuser,
	toPublicAccount,
} from "@/src/multiuser";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const context = requireMultiuser();
	if (!context.ok) return context.response;
	const session = await readSession(request, context.config);
	if (!session) return problem(401, "session_required", "Sign in before completing first-administrator setup.");

	const body = await readJsonBody(request, 4096);
	if (!body.ok) return body.response;
	if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
		return problem(400, "body_invalid", "Expected a JSON object with the bootstrap secret.");
	}
	const providedSecret = (body.value as Record<string, unknown>).secret;
	if (typeof providedSecret !== "string" || providedSecret.length === 0) {
		return problem(400, "secret_missing", "Enter the host-issued bootstrap secret.");
	}

	const configured = readBootstrapSecret();
	const result = bootstrapFirstAdministrator(registryOptionsFor(context.config), {
		subject: session.subject,
		providedSecret,
		configuredSecret: configured.ok ? configured.secret : undefined,
	});
	if (result.ok) {
		return json({
			ok: true,
			bootstrapRequired: false,
			account: toPublicAccount(result.account),
		});
	}
	switch (result.code) {
		case "bootstrap_secret_invalid":
			return problem(403, result.code, "The bootstrap secret is invalid.");
		case "bootstrap_already_consumed":
			return problem(409, result.code, "The first administrator has already been committed.");
		case "bootstrap_secret_unavailable":
			return problem(503, result.code, "The host has not configured a bootstrap secret.");
		case "subject_invalid":
			return problem(400, result.code, "The authenticated identity cannot own an account.");
		default:
			return problem(503, result.code, "The first-administrator transaction could not be committed.");
	}
}
