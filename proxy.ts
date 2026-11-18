import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { isPublicWebAuthenticationPath, multiuserApiResponse } from "./src/server/multiuser-gate.ts";
import { loadMultiuserConfig } from "./src/runtime/multiuser-config.ts";
import { createProxy } from "./src/server/multiuser-proxy.ts";

/** Next derives the pathname from the actual request URL, not a caller header.
 * Forward it server-side solely to choose the public/auth root composition;
 * it supplies no identity, permission, account, or controller authority. */
function nextMultiuserResponse(request: NextRequest): NextResponse {
	const headers = new Headers(request.headers);
	headers.set("x-learnharness-internal-pathname", request.nextUrl.pathname);
	return NextResponse.next({ request: { headers } });
}

/** Runs only in the explicit multiuser-web composition. Desktop and local web
 * requests use the old response directly and never invoke Clerk. */
import { clerkMiddleware } from "@clerk/nextjs/server";
const multiuserConfig = loadMultiuserConfig(process.env);
const multiuserClerk = clerkMiddleware(async (auth, request) => {
	const publicAuthentication = isPublicWebAuthenticationPath(request.nextUrl.pathname);
	// The public route itself never executes registry/protected work. Signed-in
	// visits to auth forms redirect home; the webhook always stays public to
	// Clerk then independently verifies its signature in the route handler.
	if (publicAuthentication) {
		const session = await auth();
		if (request.nextUrl.pathname === "/api/webhooks/clerk") return NextResponse.next();
		if (!session.userId) return nextMultiuserResponse(request);
		return NextResponse.redirect(new URL("/", request.nextUrl));
	}
	const session = await auth();
	const api = request.nextUrl.pathname === "/api" || request.nextUrl.pathname.startsWith("/api/");
	if (!session.userId) {
		if (api) return multiuserApiResponse("Sign in to access this API.");
		return session.redirectToSignIn({ returnBackUrl: request.nextUrl.href });
	}
	// Bootstrapping and registration need a signed-in identity but deliberately
	// no registered account. Secret proof is never accepted by this layer.
	if (request.nextUrl.pathname === "/api/account/bootstrap" || request.nextUrl.pathname === "/api/account/register") return NextResponse.next();
	if (!api) return nextMultiuserResponse(request);
	const { webAccountService } = await import("./src/server/account-entry.ts");
	const access = await webAccountService.current();
	if (access.kind !== "active") return multiuserApiResponse(
		access.kind === "unavailable" ? "Account service is unavailable." : "A registered, active LearnHarness account is required.",
		access.kind === "unavailable" ? 503 : 403,
	);
	return nextMultiuserResponse(request);
}, {
	authorizedParties: multiuserConfig.ok ? multiuserConfig.config.clerk.authorizedParties : [],
});

/** createProxy is a pure injected factory in src/server/multiuser-proxy.ts. */

export const proxy = createProxy(multiuserClerk as (request: NextRequest, event: NextFetchEvent) => Promise<Response>);

export const config = {
	// Exact streamed document exception preserved: its handler authenticates
	// before params/body/host access. Other static literals protect pages/APIs.
	matcher: [
		"/((?!api/plugins/[^/]+/documents/markdown/?$|_next/static|_next/image|_next/webpack-hmr|favicon.ico|[^?]*\\.(?:css|js|mjs|png|svg|woff2?|ttf|ico)).*)",
		"/api",
		"/api/((?!plugins/[^/]+/documents/markdown/?$).*)",
		"/__clerk/(.*)",
	],
};
