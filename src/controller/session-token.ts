/**
 * APPLICATION SESSION TOKENS (per-user accounts, Phase 2, 2026-11-12).
 *
 * The browser holds one HttpOnly, SameSite=Lax session cookie. It is always a
 * short-lived HS256 JWT signed by a runtime secret:
 *
 *   local provider  — the offline simulation mints it directly after the
 *                     sign-in form submits an email/name; no network.
 *   Clerk provider  — /api/auth/clerk exchanges a Clerk session token that
 *                     the controller verified against runtime issuer/JWKS
 *                     configuration, then mints this cookie.
 *
 * The Clerk token is never stored in the cookie or in browser state. No
 * secret is baked into the build.
 */

import { SignJWT, jwtVerify } from "jose";
import { ACCOUNT_SUBJECT_PATTERN } from "../accounts/contracts.ts";

export const SESSION_COOKIE_NAME = "lh_session";
const SESSION_ISSUER = "learnharness";
const SESSION_AUDIENCE = "learnharness-web";
const MAX_SESSION_TOKEN_LENGTH = 8192;

export type SessionProvider = "local" | "clerk";

export interface VerifiedSession {
	subject: string;
	provider: SessionProvider;
	email?: string;
	name?: string;
	issuedAt: number;
	expiresAt: number;
}

export type SessionFailureCode =
	| "session_missing"
	| "session_malformed"
	| "session_expired"
	| "session_invalid";

export type SessionVerifyResult =
	| { ok: true; session: VerifiedSession }
	| { ok: false; code: SessionFailureCode; message: string };

function key(secret: string): Uint8Array {
	if (secret.length < 32 || secret.length > 512) {
		throw new Error("Session secret must be 32-512 characters.");
	}
	return new TextEncoder().encode(secret);
}

function optionalClaim(payload: Record<string, unknown>, name: string, max: number): string | undefined | null {
	const value = payload[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
	return value;
}

export interface SignSessionInput {
	subject: string;
	provider: SessionProvider;
	email?: string;
	name?: string;
	ttlSeconds: number;
	now?: Date;
}

export async function signSessionToken(input: SignSessionInput, secret: string): Promise<string> {
	if (!ACCOUNT_SUBJECT_PATTERN.test(input.subject)) throw new Error("Invalid session subject.");
	if (input.provider !== "local" && input.provider !== "clerk") throw new Error("Invalid session provider.");
	if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 604_800) {
		throw new Error("Invalid session lifetime.");
	}
	const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
	const claims: Record<string, unknown> = { provider: input.provider };
	if (input.email) claims.email = input.email;
	if (input.name) claims.name = input.name;
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setSubject(input.subject)
		.setIssuer(SESSION_ISSUER)
		.setAudience(SESSION_AUDIENCE)
		.setIssuedAt(nowSeconds)
		.setExpirationTime(nowSeconds + input.ttlSeconds)
		.setJti(crypto.randomUUID())
		.sign(key(secret));
}

export async function verifySessionToken(
	token: string,
	secret: string,
	now: Date = new Date(),
): Promise<SessionVerifyResult> {
	if (!token) return { ok: false, code: "session_missing", message: "No session is present." };
	if (token.length > MAX_SESSION_TOKEN_LENGTH) {
		return { ok: false, code: "session_malformed", message: "The session token is malformed." };
	}
	let payload: Record<string, unknown>;
	try {
		const result = await jwtVerify(token, key(secret), {
			issuer: SESSION_ISSUER,
			audience: SESSION_AUDIENCE,
			algorithms: ["HS256"],
			currentDate: now,
			clockTolerance: 5,
		});
		payload = result.payload as Record<string, unknown>;
	} catch (error) {
		const code = (error as { code?: string }).code;
		return code === "ERR_JWT_EXPIRED"
			? { ok: false, code: "session_expired", message: "The session has expired." }
			: { ok: false, code: "session_invalid", message: "The session token is invalid." };
	}

	const subject = payload.sub;
	if (typeof subject !== "string" || !ACCOUNT_SUBJECT_PATTERN.test(subject)) {
		return { ok: false, code: "session_invalid", message: "The session subject is invalid." };
	}
	const provider = payload.provider;
	if (provider !== "local" && provider !== "clerk") {
		return { ok: false, code: "session_invalid", message: "The session provider is invalid." };
	}
	const email = optionalClaim(payload, "email", 254);
	const name = optionalClaim(payload, "name", 128);
	if (email === null || name === null) {
		return { ok: false, code: "session_invalid", message: "The session claims are invalid." };
	}
	const iat = payload.iat;
	const exp = payload.exp;
	if (typeof iat !== "number" || typeof exp !== "number") {
		return { ok: false, code: "session_invalid", message: "The session timestamps are missing." };
	}
	return {
		ok: true,
		session: {
			subject,
			provider,
			...(email ? { email } : {}),
			...(name ? { name } : {}),
			issuedAt: iat * 1000,
			expiresAt: exp * 1000,
		},
	};
}

/** A session cookie is safe to serialize only when it cannot inject an
 *  attribute separator or header newline. */
function assertCookieSafe(token: string): void {
	if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw new Error("Session token cannot be represented as a cookie.");
}

export function sessionCookie(
	token: string,
	options: { secure: boolean; maxAgeSeconds: number; name?: string },
): string {
	assertCookieSafe(token);
	const name = options.name ?? SESSION_COOKIE_NAME;
	const secure = options.secure ? "; Secure" : "";
	return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${options.maxAgeSeconds}${secure}`;
}

export function clearSessionCookie(options: { secure: boolean; name?: string }): string {
	const name = options.name ?? SESSION_COOKIE_NAME;
	return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options.secure ? "; Secure" : ""}`;
}

function cookieValue(header: string | null, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		if (part.slice(0, index).trim() !== name) continue;
		const raw = part.slice(index + 1).trim();
		if (!raw) return undefined;
		try { return decodeURIComponent(raw); } catch { return raw; }
	}
	return undefined;
}

/** Read the app session from the cookie (primary) or an Authorization bearer
 *  token (script/API clients). Only this app's HS256 token is accepted; a
 *  Clerk session token must be exchanged first. */
export function sessionTokenFromRequest(
	request: Request,
	name: string = SESSION_COOKIE_NAME,
): string | undefined {
	const cookie = cookieValue(request.headers.get("cookie"), name);
	if (cookie) return cookie;
	const authorization = request.headers.get("authorization");
	if (!authorization) return undefined;
	const match = /^Bearer\s+([A-Za-z0-9._~-]{1,8192})$/i.exec(authorization.trim());
	return match?.[1];
}

/** Secure cookies behind a TLS-terminating proxy. Never trust a cookie value
 *  alone; the host sets LH_APP_ORIGIN/LH_ALLOWED_HOSTS as well. */
export function requestIsSecure(request: Request): boolean {
	try {
		if (new URL(request.url).protocol === "https:") return true;
	} catch { /* fall through */ }
	return request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}
