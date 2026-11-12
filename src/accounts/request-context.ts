/**
 * REQUEST-SCOPED ACCOUNT CONTEXT (per-user accounts, Phase 2, 2026-11-12).
 *
 * The web relay carries a VERIFIED session proof. It never asserts account
 * authority itself: an account context is only constructed from a controller
 * record (subject → internal account) and carries that record's generation.
 *
 * Milestone 1 gate: learning operations remain unavailable in multiuser-web
 * until the Phase 3 account worker/runtime exists. The refusal is explicit so
 * a partially migrated route cannot silently fall back to shared stores.
 */

import type { DeploymentMode } from "../runtime/deployment-mode.ts";
import type { AccountRecord, AccountRole, AccountLifecycle } from "./contracts.ts";
import type { VerifiedSession } from "../controller/session-token.ts";

export type AccountRelayOperation =
	| "learning"
	| "chats"
	| "graph"
	| "settings"
	| "files"
	| "plugins"
	| "jobs"
	| "archive";

export interface AccountContext {
	session: VerifiedSession;
	accountId: string;
	role: AccountRole;
	lifecycle: AccountLifecycle;
	generation: number;
	operation: AccountRelayOperation;
}

export class RelayUnavailableError extends Error {
	readonly code = "worker_runtime_unavailable";

	constructor(operation: AccountRelayOperation) {
		super(`The ${operation} account runtime is not available in this build; worker isolation has not landed yet.`);
		this.name = "RelayUnavailableError";
	}
}

/** Build the context only from a controller-owned account record. */
export function accountContextFromController(
	session: VerifiedSession,
	account: AccountRecord,
	operation: AccountRelayOperation,
): AccountContext {
	return {
		session,
		accountId: account.id,
		role: account.role,
		lifecycle: account.lifecycle,
		generation: account.generation,
		operation,
	};
}

export function learningRouteRefusal(mode: DeploymentMode): string | undefined {
	return mode === "multiuser-web"
		? "Multiuser learning routes are disabled until the per-account worker runtime is available."
		: undefined;
}

/** Fail-closed gate for routes that would touch account content. */
export function assertLearningRelayAvailable(mode: DeploymentMode, operation: AccountRelayOperation = "learning"): void {
	if (mode === "multiuser-web") throw new RelayUnavailableError(operation);
}
