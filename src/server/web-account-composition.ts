import type { WebAccountController } from "./account-web.ts";

/** Deliberately no fallback to the local/shared learning stores. */
export const unavailableWebAccountController: WebAccountController = {
	async resolve() { return { kind: "unavailable" }; },
	async bootstrap() { return { kind: "unavailable" }; },
	async register() { return { kind: "unavailable" }; },
	async disableFromClerkWebhook() { throw new Error("The account controller is unavailable."); },
};

/**
 * The only production A05/A06 composition seam. A05 deliberately has no
 * registry, bootstrap-secret verifier, provisioner, or authenticated relay;
 * replacing this unavailable controller with A06's separate process adapter
 * updates all Clerk routes and gates together rather than at individual URLs.
 */
export const webAccountController: WebAccountController = unavailableWebAccountController;
