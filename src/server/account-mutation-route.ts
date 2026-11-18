// Server route adapter; kept injectable for network-free contract tests.

import type { AccountMutationResult } from "./account-web.ts";

export function messageForAccountMutation(result: AccountMutationResult): { error: string; status: number } {
	switch (result.kind) {
		case "unauthenticated": return { error: "Sign in to continue.", status: 401 };
		case "bootstrap-required": return { error: "The host bootstrap secret was not accepted.", status: 403 };
		case "registration-required": return { error: "LearnHarness registration is not open for this identity.", status: 403 };
		case "invalid": return { error: "The account setup request is invalid.", status: 400 };
		case "conflict": return { error: "The account setup request conflicts with the current state.", status: 409 };
		case "inactive": return { error: "This account is inactive.", status: 403 };
		case "unavailable": return { error: "Account service is unavailable.", status: 503 };
		case "active": return { error: "", status: 200 };
	}
}
