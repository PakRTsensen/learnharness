import { apiRequestRefusal, browserAPIRefusal } from "./desktop-access.ts";
import { multiuserApiResponse } from "./multiuser-gate.ts";
import { loadMultiuserConfig } from "../runtime/multiuser-config.ts";

export interface PluginDocumentTransport {
	convertDocument(id: string, request: Request): Promise<Response>;
}

/** This streamed route must avoid Proxy's silently truncated body clone.
 * Preserve the mode-aware API policy before any params/body/plugin work. */
export function createPluginDocumentRoute(transport: PluginDocumentTransport, deps: {
	mode(): Promise<"desktop" | "single-user" | "multiuser-web" | "invalid">;
	account(request: Request): Promise<Response | undefined>;
} = {
	async mode() {
		const { selectDeploymentMode } = await import("../runtime/deployment-mode.ts");
		const selection = selectDeploymentMode(process.env);
		return selection.ok ? selection.mode : "invalid";
	},
	async account(request) {
		try {
			const { clerkClient } = await import("@clerk/nextjs/server");
			// This route is deliberately excluded from Proxy, so clerkMiddleware
			// never ran and auth() cannot read middleware context. Verify the
			// request's session through the backend client instead. Never derive
			// authorized parties from request headers: readiness validated the
			// operator's canonical-origin allowlist at startup.
			const config = loadMultiuserConfig(process.env);
			if (!config.ok) return multiuserApiResponse("Account service is unavailable.", 503);
			const session = await (await clerkClient()).authenticateRequest(request, {
				secretKey: config.config.clerk.secretKey,
				authorizedParties: config.config.clerk.authorizedParties,
			});
			if (session.tokenType !== "session_token") {
				return multiuserApiResponse("A valid Clerk session is required.");
			}
			if (session.status !== "signed-in" || !session.toAuth().userId) {
				return multiuserApiResponse("Sign in to access this API.");
			}
			const { webAccountController } = await import("./account-entry.ts");
			// The route intentionally bypasses clerkMiddleware, so forward the
			// backend-verified token rather than relying on auth() request context.
			const access = await webAccountController.resolve({ sessionToken: session.token });
			if (access.kind !== "active") return multiuserApiResponse(
				access.kind === "unavailable" ? "Account service is unavailable." : "A registered, active LearnHarness account is required.",
				access.kind === "unavailable" ? 503 : 403,
			);
			// Phase 2 has no per-account plugin transport. Do not load the shared
			// plugin/store composition for an active account either.
			return multiuserApiResponse("This account's plugin service is unavailable.", 503);
		} catch {
			return multiuserApiResponse("Account service is unavailable.", 503);
		}
	},
}) {
	const refusal = async (request: Request) => {
		const mode = await deps.mode();
		if (mode === "invalid") return multiuserApiResponse("The deployment configuration is invalid.", 503);
		if (mode === "multiuser-web") {
			const error = browserAPIRefusal(request);
			if (error) return multiuserApiResponse(error, 403);
			return await deps.account(request) ?? multiuserApiResponse("The account service is unavailable.", 503);
		}
		const error = apiRequestRefusal(request);
		if (error) return Response.json({ error }, { status: 403, headers: { "Cache-Control": "no-store" } });
		return undefined;
	};
	const unsupported = async (request: Request) => await refusal(request) ?? new Response(null, { status: 405 });
	return {
		async POST(request: Request, context: { params: Promise<{ id: string }> }) {
			const denied = await refusal(request);
			if (denied) return denied;
			return transport.convertDocument((await context.params).id, request);
		},
		OPTIONS: async (request: Request) => await refusal(request) ?? new Response(null, { status: 204, headers: { Allow: "OPTIONS, POST" } }),
		GET: unsupported, HEAD: unsupported, PUT: unsupported, PATCH: unsupported, DELETE: unsupported,
	};
}
