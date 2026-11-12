/**
 * POST /api/auth/clerk — exchange a Clerk session token for the app session.
 *
 * The controller verifies the Clerk token against the runtime issuer/JWKS
 * configuration. The Clerk token is never stored: only this installation's
 * short-lived HS256 cookie is returned. A same-origin Clerk cookie may be
 * supplied instead of a POSTed token when the deployment shares a custom
 * domain with Clerk.
 */

import {
	ensureAccount,
	findAccountBySubject,
	json,
	problem,
	readAccountRegistry,
	readJsonBody,
	registryOptionsFor,
	requireMultiuser,
	RegistryError,
	secureCookieFor,
	sessionCookie,
	sessionTokenFromRequest,
	signSessionToken,
	toPublicAccount,
	verifyClerkSessionToken,
} from "@/src/multiuser";

export const dynamic = "force-dynamic";

async function bodyToken(request: Request): Promise<string | undefined> {
	const body = await readJsonBody(request, 32 * 1024);
	if (!body.ok) return undefined;
	if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) return undefined;
	const token = (body.value as Record<string, unknown>).token;
	return typeof token === "string" ? token : undefined;
}

export async function POST(request: Request) {
	const context = requireMultiuser();
	if (!context.ok) return context.response;
	if (context.config.auth.provider !== "clerk") {
		return problem(400, "clerk_disabled", "This installation uses the offline local identity provider.");
	}

	const token = sessionTokenFromRequest(request, context.config.auth.sessionCookie) ?? await bodyToken(request);
	if (!token) {
		return problem(401, "clerk_token_missing", "Supply a Clerk session token.");
	}
	const verified = await verifyClerkSessionToken(token, context.config.auth);
	if (!verified.ok) {
		return problem(401, verified.code, verified.message);
	}

	let bootstrapRequired: boolean;
	let account: ReturnType<typeof toPublicAccount> | null = null;
	try {
		const registry = readAccountRegistry(context.config.paths.controllerStateDir);
		bootstrapRequired = registry.bootstrap === null;
		if (!bootstrapRequired) {
			const existing = findAccountBySubject(registry, verified.identity.subject);
			if (existing && existing.lifecycle !== "active") {
				return problem(403, "account_not_active", "This account is disabled or awaiting deletion.");
			}
			const resolved = existing ?? ensureAccount(registryOptionsFor(context.config), verified.identity.subject);
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

	const session = await signSessionToken(
		{
			subject: verified.identity.subject,
			provider: "clerk",
			email: verified.identity.email,
			name: verified.identity.name,
			ttlSeconds: context.config.sessionTtlSeconds,
		},
		context.config.auth.sessionSecret,
	);
	const response = json({
		ok: true,
		provider: "clerk",
		bootstrapRequired,
		account,
		redirectTo: bootstrapRequired ? "/first-admin" : "/account",
	});
	response.headers.set(
		"set-cookie",
		sessionCookie(session, {
			secure: secureCookieFor(request),
			maxAgeSeconds: context.config.sessionTtlSeconds,
		}),
	);
	return response;
}
