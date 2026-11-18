// Pure request-path/response helpers shared by Proxy and the Node server.
/** Exact public Clerk surfaces. Prefix matching is prohibited for the webhook. */
export { isPublicWebAuthenticationPath } from "../core/web-authentication-path.ts";

/** Browser host and write-origin policy runs before Clerk. The desktop branch
 * is selected only by the browsers' absence of the desktop launch capability,
 * exactly as before; multiuser mode itself is checked explicitly by callers. */
export function multiuserApiResponse(message: string, status = 401): Response {
	return Response.json({ error: message }, {
		status,
		headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
	});
}
