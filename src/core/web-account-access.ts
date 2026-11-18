import type { PublicAccountStatus } from "./account-status.ts";

/** Public request-gate result. Identity and session material live only in the
 * server port; this is the sole account-access shape a client component may see. */
export type WebAccountAccess =
	| { readonly kind: "unauthenticated" }
	| { readonly kind: "bootstrap-required" }
	| { readonly kind: "registration-required" }
	| { readonly kind: "active"; readonly account: PublicAccountStatus }
	| { readonly kind: "inactive"; readonly account: PublicAccountStatus }
	| { readonly kind: "unavailable" };
