/**
 * THE REQUEST-SCOPED ACCOUNT RELAY CONTRACT (per-user-accounts phase 1).
 *
 * In desktop and single-user web there is exactly one account: the process's
 * own shared store set. In multiuser-web the Next.js process is only a RELAY —
 * it forwards an authenticated operation to the per-account worker and never
 * touches another account's records itself.
 *
 * Phase 1 introduces the seam, not the transport: `scope()` resolves the store
 * set a request may use. The real multi-user transport (controller IPC +
 * capability verification) arrives with `src/server/account-client.ts` in
 * Phase 3, which extends this contract by adding fields to `RelayScope` —
 * without changing the signature routes already code against.
 *
 * Why `scope()` is async: the multi-user path must never load the global
 * composition root. `stores.ts` is imported lazily inside the single-account
 * branch, so a multiuser-web process that calls a relay method refuses instead
 * of silently opening the shared stores.
 */

import type { Stores } from "./stores.ts";

/** What one request may reach. Phase 3 adds the account identity + capability. */
export interface RelayScope {
	/** The store set scoped to the authenticated account (or the local one). */
	readonly stores: Stores;
}

/** The relay seam routes and server components depend on. */
export interface AccountRelay {
	/** Resolve the account scope for the current request. */
	scope(): Promise<RelayScope>;
}

/**
 * Raised when the relay is unavailable. In multiuser-web this is the correct
 * answer until Phase 3 lands the controller transport: refusing is required,
 * falling back to the shared stores is forbidden.
 */
export class AccountRelayUnavailableError extends Error {
	constructor(message = "The multi-user account relay is not available in this build.") {
		super(message);
		this.name = "AccountRelayUnavailableError";
	}
}

/**
 * The process-wide relay. Single-user and desktop get the original local store
 * set; multiuser-web refuses. Deliberately NOT a mutable global store: nothing
 * here caches a per-request result.
 */
export const accountRelay: AccountRelay = {
	async scope(): Promise<RelayScope> {
		// Checked through config.ts (the deployment-mode selector) so there is one
		// source of truth and no second environment-reading implementation here.
		const { DEPLOYMENT_MODE, DEPLOYMENT_SELECTION } = await import("../../config.ts");
		if (!DEPLOYMENT_SELECTION.ok) {
			throw new AccountRelayUnavailableError(
				`The deployment selection was refused (${DEPLOYMENT_SELECTION.error}); refusing to fall back to shared stores.`,
			);
		}
		if (DEPLOYMENT_MODE === "multiuser-web") {
			throw new AccountRelayUnavailableError(
				"The multi-user web relay requires the account controller transport (not built yet); refusing to fall back to shared stores.",
			);
		}
		const { stores } = await import("./stores.ts");
		return { stores };
	},
};
