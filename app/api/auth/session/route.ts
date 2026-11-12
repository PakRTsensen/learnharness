/**
 * POST /api/auth/session — the offline/local identity provider.
 *
 * Only the `local` auth provider accepts this route. It mints the same HS256
 * session cookie a verified Clerk exchange would mint, so every downstream
 * account/registry path is exercised without network access. No password is
 * involved: this is the explicit development/offline simulation, refused in
 * production unless LH_ALLOW_LOCAL_AUTH=1.
 *
 * DELETE clears the session cookie.
 */

import {
	clearSessionCookie,
	ensureAccount,
	findAccountBySubject,
	isValidLocalEmail,
	json,
	localSubjectForEmail,
	problem,
	readAccountRegistry,
	readJsonBody,
	registryOptionsFor,
	requireMultiuser,
	RegistryError,
	secureCookieFor,
	sessionCookie,
	signSessionToken,
	toPublicAccount,
} from "@/src/multiuser";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const context = requireMultiuser();
	if (!context.ok) return context.response;
	if (context.config.auth.provider !== "local") {
		return problem(400, "local_auth_disabled", "This installation uses Clerk; exchange a Clerk session token instead.");
	}

	const body = await readJsonBody(request, 4096);
	if (!body.ok) return body.response;
	if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
		return problem(400, "body_invalid", "Expected a JSON object with an email.");
	}
	const record = body.value as Record<string, unknown>;
	const email = typeof record.email === "string" ? record.email : "";
	if (!isValidLocalEmail(email)) {
		return problem(400, "email_invalid", "Enter a valid email address for the offline identity simulation.");
	}
	const name = typeof record.name === "string" && record.name.trim().length > 0
		? record.name.trim().slice(0, 128)
		: undefined;
	const subject = localSubjectForEmail(email);

	let bootstrapRequired: boolean;
	let account: ReturnType<typeof toPublicAccount> | null = null;
	try {
		const registry = readAccountRegistry(context.config.paths.controllerStateDir);
		bootstrapRequired = registry.bootstrap === null;
		if (!bootstrapRequired) {
			const existing = findAccountBySubject(registry, subject);
			if (existing && existing.lifecycle !== "active") {
				return problem(403, "account_not_active", "This account is disabled or awaiting deletion.");
			}
			const resolved = existing ?? ensureAccount(registryOptionsFor(context.config), subject);
			account = toPublicAccount(resolved);
		}
	} catch (error) {
		if (error instanceof RegistryError) {
			if (error.code === "bootstrap_required") {
				bootstrapRequired = true;
			} else {
				return problem(503, error.code, error.message);
			}
		} else {
			throw error;
		}
	}

	const token = await signSessionToken(
		{ subject, provider: "local", email, name, ttlSeconds: context.config.sessionTtlSeconds },
		context.config.auth.sessionSecret,
	);
	const response = json({
		ok: true,
		provider: "local",
		bootstrapRequired,
		account,
		redirectTo: bootstrapRequired ? "/first-admin" : "/account",
	});
	response.headers.set(
		"set-cookie",
		sessionCookie(token, {
			secure: secureCookieFor(request),
			maxAgeSeconds: context.config.sessionTtlSeconds,
		}),
	);
	return response;
}

export async function DELETE(request: Request) {
	const context = requireMultiuser();
	if (!context.ok) return context.response;
	const response = json({ ok: true });
	response.headers.set("set-cookie", clearSessionCookie({ secure: secureCookieFor(request) }));
	return response;
}
