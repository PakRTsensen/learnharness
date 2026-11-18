/** Server-only account adapter. This module is intentionally not exported
 * through the browser-safe core barrel. */
import type { WebAccountAccess } from "../core/web-account-access.ts";
import { webAccountController } from "./web-account-composition.ts";

/** Server-only authentication material for the controller. The raw token is
 * obtained by the server Clerk adapter, never read from request JSON, query,
 * params, or browser-supplied account identifiers. A06 independently verifies
 * it and binds the resulting subject to its registry entry. */
export interface ClerkSessionProof {
	readonly sessionToken: string;
}

export type { WebAccountAccess } from "../core/web-account-access.ts";

export type AccountMutationResult =
	| WebAccountAccess
	| { readonly kind: "invalid" }
	| { readonly kind: "conflict" };

/** The narrow A05 ↔ controller boundary. It deliberately exposes no registry,
 * UID/GID, Clerk user records, account IDs, metadata, or bootstrap-secret
 * comparison/storage operation. A06 is the sole implementation of these ports. */
export interface WebAccountController {
	resolve(proof: ClerkSessionProof | null): Promise<WebAccountAccess>;
	bootstrap(proof: ClerkSessionProof, hostSecret: string): Promise<AccountMutationResult>;
	register(proof: ClerkSessionProof): Promise<AccountMutationResult>;
	/** Verified external deletion starts fencing/disablement only. */
	disableFromClerkWebhook(clerkUserId: string): Promise<void>;
}

/** The fail-closed production implementation lives at the single composition seam. */
export interface ClerkProofSource {
	/** Null is signed out; a rejected token read is an unavailable service. */
	read(): Promise<ClerkSessionProof | null>;
}

export function createWebAccountService(deps: {
	controller: WebAccountController;
	proof: ClerkProofSource;
}) {
	return {
		async current(): Promise<WebAccountAccess> {
			let proof: ClerkSessionProof | null;
			try { proof = await deps.proof.read(); }
			catch { return { kind: "unavailable" }; }
			if (!proof) return { kind: "unauthenticated" };
			try { return await deps.controller.resolve(proof); }
			catch { return { kind: "unavailable" }; }
		},
		async mutate(operation: "bootstrap" | "register", input: { hostSecret?: string }): Promise<AccountMutationResult> {
			let proof: ClerkSessionProof | null;
			try { proof = await deps.proof.read(); }
			catch { return { kind: "unavailable" }; }
			if (!proof) return { kind: "unauthenticated" };
			try {
				return operation === "bootstrap"
					? await deps.controller.bootstrap(proof, input.hostSecret ?? "")
					: await deps.controller.register(proof);
			} catch { return { kind: "unavailable" }; }
		},
	};
}

export const clerkProofSource: ClerkProofSource = {
	async read() {
		const { auth } = await import("@clerk/nextjs/server");
		const session = await auth();
		if (!session.userId) return null;
		const sessionToken = await session.getToken();
		return sessionToken ? { sessionToken } : null;
	},
};

// Construct the default service lazily: importing this port never loads Clerk,
// initializes stores, or caches data between requests.
export const webAccountService = createWebAccountService({
	controller: webAccountController,
	proof: clerkProofSource,
});
