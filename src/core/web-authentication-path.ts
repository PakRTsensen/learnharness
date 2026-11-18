/** Exact public Clerk surfaces. Prefix matching is prohibited for the webhook. */
export function isPublicWebAuthenticationPath(pathname: string): boolean {
	return pathname === "/sign-in" || pathname.startsWith("/sign-in/") ||
		pathname === "/sign-up" || pathname.startsWith("/sign-up/") ||
		pathname === "/api/webhooks/clerk";
}
