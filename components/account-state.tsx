"use client";

import { createContext, useContext } from "react";
import type { PublicAccountStatus } from "@/src/core";

/** Opaque UI state only: no client account ID, Clerk subject, token, or private
 * Clerk metadata crosses this context. AppShell remains entirely outside this
 * context in local modes. */
const AccountStateContext = createContext<PublicAccountStatus | null>(null);

export function AccountStateProvider({ account, children }: {
	account: PublicAccountStatus;
	children: React.ReactNode;
}) {
	return <AccountStateContext.Provider value={account}>{children}</AccountStateContext.Provider>;
}

export function useAccountState(): PublicAccountStatus | null {
	return useContext(AccountStateContext);
}
