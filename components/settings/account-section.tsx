"use client";

import { useAccountState } from "@/components/account-state";
import { SettingsSection } from "./controls.tsx";

/** A05 deliberately reads only registry-derived public fields. Clerk handles
 * identity/profile via UserButton; no browser account ID, metadata, or fake
 * deletion action is rendered here. */
export function AccountSection() {
	const account = useAccountState();
	if (!account) return null;
	return <SettingsSection title="Account" testid="section-account">
		<dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-3 text-sm">
			<dt className="text-muted-foreground">Role</dt><dd>{account.role === "admin" ? "Administrator" : "Member"}</dd>
			<dt className="text-muted-foreground">Status</dt><dd>{account.lifecycle}</dd>
			<dt className="text-muted-foreground">Recovery</dt><dd>{account.recoveringUntil ? `Available until ${account.recoveringUntil}` : "Not scheduled"}</dd>
		</dl>
	</SettingsSection>;
}
