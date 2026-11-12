/**
 * AUTH/ACCOUNT ROUTE HELPERS (per-user accounts, Phase 2, 2026-11-12).
 *
 * Small, server-only helpers shared by the auth and account route handlers.
 * They deliberately avoid the src/server barrel: in multiuser mode that
 * barrel's global store composition is unavailable by design.
 */

import { parseDeploymentMode } from "../runtime/deployment-mode.ts";
import { loadMultiuserConfig, type MultiuserConfig } from "../runtime/multiuser-config.ts";
import { registryOptionsFromConfig, type RegistryOptions } from "./registry.ts";
import {
	requestIsSecure,
	sessionTokenFromRequest,
	verifySessionToken,
	type VerifiedSession,
} from "./session-token.ts";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...headers,
		},
	});
}

export function problem(status: number, code: string, message: string): Response {
	return json({ error: { code, message } }, status);
}

export type BodyResult =
	| { ok: true; value: unknown }
	| { ok: false; response: Response };

export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
	const declared = request.headers.get("content-length");
	if (declared && Number(declared) > maxBytes) {
		return { ok: false, response: problem(413, "body_too_large", "The request body is too large.") };
	}
	let text: string;
	try {
		text = await request.text();
	} catch {
		return { ok: false, response: problem(400, "body_unreadable", "The request body could not be read.") };
	}
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		return { ok: false, response: problem(413, "body_too_large", "The request body is too large.") };
	}
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false, response: problem(400, "body_invalid", "The request body must be valid JSON.") };
	}
}

export type MultiuserRouteContext =
	| { ok: true; config: MultiuserConfig }
	| { ok: false; response: Response };

/** Auth/account routes exist only in the explicit multiuser-web mode. */
export function requireMultiuser(): MultiuserRouteContext {
	const parsed = parseDeploymentMode();
	if (!parsed.ok) {
		return { ok: false, response: problem(503, "deployment_mode_invalid", parsed.message) };
	}
	if (parsed.selection.mode !== "multiuser-web") {
		return { ok: false, response: problem(404, "not_found", "This route exists only in multiuser mode.") };
	}
	const loaded = loadMultiuserConfig();
	if (!loaded.ok) {
		return {
			ok: false,
			response: problem(
				503,
				"auth_not_configured",
				`Authentication is not configured: ${loaded.issues.map((issue) => issue.code).join(", ")}.`,
			),
		};
	}
	return { ok: true, config: loaded.config };
}

/** Verify the app session cookie; only a session minted by the configured
 *  provider is accepted (switching providers invalidates old cookies). */
export async function readSession(request: Request, config: MultiuserConfig): Promise<VerifiedSession | null> {
	const token = sessionTokenFromRequest(request);
	if (!token) return null;
	const result = await verifySessionToken(token, config.auth.sessionSecret);
	if (!result.ok) return null;
	if (result.session.provider !== config.auth.provider) return null;
	return result.session;
}

export function registryOptionsFor(config: MultiuserConfig): RegistryOptions {
	return registryOptionsFromConfig(config);
}

export function secureCookieFor(request: Request): boolean {
	if (configIsSecureOrigin(request)) return true;
	return requestIsSecure(request);
}

function configIsSecureOrigin(request: Request): boolean {
	try {
		return new URL(request.url).protocol === "https:";
	} catch {
		return false;
	}
}
