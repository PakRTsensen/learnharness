/**
 * CLERK IDENTITY VERIFICATION (per-user accounts, Phase 2, 2026-11-12).
 *
 * The controller verifies Clerk session tokens independently of any browser
 * middleware. It trusts only:
 *   - the configured issuer (exact match);
 *   - an asymmetric signature from the configured JWKS URL;
 *   - a `user_*` subject;
 *   - an authorized `azp` party when the token carries one.
 *
 * Configuration is read at request time, so the Docker host can rotate the
 * issuer/JWKS without rebuilding the image. No Clerk secret key or
 * NEXT_PUBLIC_* variable is required or baked into the build.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ClerkAuthConfig } from "../runtime/multiuser-config.ts";

export const CLERK_SUBJECT_PATTERN = /^user_[A-Za-z0-9_-]{1,120}$/;
const MAX_CLERK_TOKEN_LENGTH = 16_384;

export interface ClerkIdentity {
	subject: string;
	email?: string;
	name?: string;
	sessionId?: string;
}

export type ClerkVerifyFailureCode =
	| "clerk_token_malformed"
	| "clerk_token_expired"
	| "clerk_token_invalid"
	| "clerk_subject_invalid"
	| "clerk_authorized_party_invalid";

export type ClerkVerifyResult =
	| { ok: true; identity: ClerkIdentity }
	| { ok: false; code: ClerkVerifyFailureCode; message: string };

export interface ClerkVerifyOptions {
	/** Test seam: a local JWKS resolver. Production derives it from the URL. */
	jwks?: JWTVerifyGetKey;
	now?: Date;
}

const REMOTE_JWKS = new Map<string, JWTVerifyGetKey>();

function remoteJwks(url: string): JWTVerifyGetKey {
	const existing = REMOTE_JWKS.get(url);
	if (existing) return existing;
	const created = createRemoteJWKSet(new URL(url), {
		timeoutDuration: 5_000,
		cooldownDuration: 30_000,
		cacheMaxAge: 600_000,
	});
	REMOTE_JWKS.set(url, created);
	return created;
}

function validEmail(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 3 && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
		? value
		: undefined;
}

function validName(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}

/**
 * Verify a Clerk session JWT. `config` is the validated Clerk branch of the
 * multiuser configuration. Tokens are never logged.
 */
export async function verifyClerkSessionToken(
	token: string,
	config: Pick<ClerkAuthConfig, "issuer" | "jwksUrl" | "audience" | "authorizedParties">,
	options: ClerkVerifyOptions = {},
): Promise<ClerkVerifyResult> {
	if (!token || token.length > MAX_CLERK_TOKEN_LENGTH) {
		return { ok: false, code: "clerk_token_malformed", message: "The Clerk session token is malformed." };
	}
	let payload: Record<string, unknown>;
	try {
		const result = await jwtVerify(token, options.jwks ?? remoteJwks(config.jwksUrl), {
			issuer: config.issuer,
			algorithms: ["RS256", "ES256"],
			...(config.audience ? { audience: config.audience } : {}),
			currentDate: options.now ?? new Date(),
			clockTolerance: 5,
		});
		payload = result.payload as Record<string, unknown>;
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ERR_JWT_EXPIRED") {
			return { ok: false, code: "clerk_token_expired", message: "The Clerk session has expired." };
		}
		return { ok: false, code: "clerk_token_invalid", message: "The Clerk session token is invalid." };
	}

	const subject = payload.sub;
	if (typeof subject !== "string" || !CLERK_SUBJECT_PATTERN.test(subject)) {
		return { ok: false, code: "clerk_subject_invalid", message: "The Clerk subject is invalid." };
	}
	const azp = payload.azp;
	if (azp !== undefined) {
		if (typeof azp !== "string" || config.authorizedParties.length === 0 || !config.authorizedParties.includes(azp)) {
			return {
				ok: false,
				code: "clerk_authorized_party_invalid",
				message: "The Clerk session was issued for an unauthorized origin.",
			};
		}
	}

	const email = validEmail(payload.email);
	const name = validName(payload.name);
	const sessionId = typeof payload.sid === "string" && payload.sid.length <= 128 ? payload.sid : undefined;
	return {
		ok: true,
		identity: {
			subject,
			...(email ? { email } : {}),
			...(name ? { name } : {}),
			...(sessionId ? { sessionId } : {}),
		},
	};
}
