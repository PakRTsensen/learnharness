/**
 * REQUEST GATE — deployment-mode aware.
 *
 * single-user-web / desktop: the existing browser host + cross-site API gate,
 * byte-for-byte in effect.
 *
 * multiuser-web: an additional fail-closed auth gate. It verifies this app's
 * HS256 session cookie locally (no network), allows only the sign-in,
 * bootstrap, and account surfaces, and refuses every learning route until the
 * Phase 3 per-account worker runtime exists. No request reaches a shared
 * account store in multiuser mode.
 */

import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";
import { parseDeploymentMode } from "./src/runtime/deployment-mode.ts";
import { loadMultiuserConfig } from "./src/runtime/multiuser-config.ts";
import { sessionTokenFromRequest, verifySessionToken } from "./src/controller/session-token.ts";

const PUBLIC_API_PATHS = new Set(["/api/auth/session", "/api/auth/clerk", "/api/webhooks/clerk"]);

function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

function isPublicPath(pathname: string): boolean {
	return pathname === "/sign-in" || pathname.startsWith("/sign-in/")
		|| pathname === "/sign-up" || pathname.startsWith("/sign-up/")
		|| PUBLIC_API_PATHS.has(pathname);
}

function isAccountSurface(pathname: string): boolean {
	return pathname === "/account"
		|| pathname === "/first-admin"
		|| pathname === "/api/account"
		|| pathname.startsWith("/api/account/");
}

function jsonError(status: number, code: string, message: string): NextResponse {
	return NextResponse.json(
		{ error: { code, message } },
		{ status, headers: { "cache-control": "no-store" } },
	);
}

function learningUnavailable(api: boolean): NextResponse {
	if (api) {
		return jsonError(
			503,
			"worker_runtime_unavailable",
			"Multiuser learning routes are disabled until the per-account worker runtime is available.",
		);
	}
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Learning runtime pending</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111;color:#eee;font:14px/1.5 system-ui,sans-serif">
<main style="max-width:32rem;padding:2rem">
<h1 style="font-size:1.35rem;margin:0 0 .75rem">Learning runtime pending</h1>
<p style="margin:0 0 1rem;color:#aaa">Authentication and account lifecycle are active, but chats, graph, files, and plugins stay disabled until the per-account worker isolation phase lands. This build never falls back to shared account storage.</p>
<a style="color:#9cf" href="/account">Go to your account</a>
</main>
</body>
</html>`;
	return new NextResponse(html, {
		status: 503,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}

function signInRedirect(request: NextRequest): NextResponse {
	const url = new URL("/sign-in", request.url);
	const target = `${request.nextUrl.pathname}${request.nextUrl.search}`;
	if (target !== "/" && !target.startsWith("/sign-in")) {
		url.searchParams.set("redirect_url", target);
	}
	return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest) {
	const parsed = parseDeploymentMode();
	if (!parsed.ok) {
		return request.nextUrl.pathname.startsWith("/api")
			? jsonError(503, parsed.code, parsed.message)
			: new NextResponse(parsed.message, { status: 503, headers: { "cache-control": "no-store" } });
	}

	const pathname = request.nextUrl.pathname;
	const api = isApiPath(pathname);

	// The historical host/cross-site defenses remain in every mode.
	if (api) {
		const refusal = apiRequestRefusal(request);
		if (refusal) {
			return NextResponse.json(
				{ error: refusal },
				{ status: 403, headers: { "Cache-Control": "no-store" } },
			);
		}
	}

	if (parsed.selection.mode !== "multiuser-web") return NextResponse.next();

	const loaded = loadMultiuserConfig();
	if (!loaded.ok) {
		if (api) {
			return jsonError(
				503,
				"auth_not_configured",
				`Authentication is not configured: ${loaded.issues.map((issue) => issue.code).join(", ")}.`,
			);
		}
		return new NextResponse("Multiuser authentication is not configured.", {
			status: 503,
			headers: { "cache-control": "no-store" },
		});
	}
	const config = loaded.config;

	let authenticated = false;
	const token = sessionTokenFromRequest(request);
	if (token) {
		try {
			const verified = await verifySessionToken(token, config.auth.sessionSecret);
			authenticated = verified.ok && verified.session.provider === config.auth.provider;
		} catch {
			authenticated = false;
		}
	}

	if (isPublicPath(pathname)) {
		// A signed-in browser does not need the auth forms again.
		if (authenticated && (pathname === "/sign-in" || pathname.startsWith("/sign-in/")
			|| pathname === "/sign-up" || pathname.startsWith("/sign-up/"))) {
			return NextResponse.redirect(new URL("/account", request.url));
		}
		return NextResponse.next();
	}

	if (!authenticated) {
		return api ? jsonError(401, "session_required", "Sign in to continue.") : signInRedirect(request);
	}

	if (pathname === "/") return NextResponse.redirect(new URL("/account", request.url));
	if (isAccountSurface(pathname)) return NextResponse.next();

	// Milestone 1 gate: no shared-store learning route is reachable.
	return learningUnavailable(api);
}

export const config = {
	// Everything except Next's immutable assets and public files. The one
	// streamed plugin-document route deliberately bypasses Proxy (its handler
	// enforces the identical all-method request policy and avoids Next's
	// silently truncated body clone).
	matcher: ["/((?!_next/static|_next/image|favicon.ico|api/plugins/[^/]+/documents/markdown/?$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff2?|txt|webmanifest)$).*)"],
};
