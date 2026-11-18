import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { PluginsProvider } from "@/components/plugins";
import { AccountStateProvider } from "@/components/account-state";
import { MultiuserClerkProvider, MultiuserSessionBoundary } from "@/components/multiuser-clerk";
import { AccountUnavailable, FinishRegistration, FirstAdminSetup } from "@/components/account-onboarding";
import { DEFAULT_THEME, type WebAccountAccess } from "@/src/core";

/** The root gate returns early for public, pending, disabled, and failed states.
 * No SSE/plugins/settings/chat provider can fetch protected account data until
 * both Clerk and the controller say the account is active. */
export function MultiuserRoot({ access, publicRoute, children }: {
	access: WebAccountAccess;
	publicRoute: boolean;
	children: React.ReactNode;
}) {
	return <MultiuserClerkProvider>
		<MultiuserSessionBoundary />
		{publicRoute ? children : access.kind === "active" ? (
			<ServerEventsProvider>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={undefined} initialTheme={DEFAULT_THEME}>
						<SidebarProvider>
							<ActivityProvider>
								<AccountStateProvider account={access.account}>
									<AppShell>{children}</AppShell>
								</AccountStateProvider>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
		) : access.kind === "bootstrap-required" ? (
			<main className="flex min-h-dvh items-center justify-center p-6"><FirstAdminSetup /></main>
		) : access.kind === "registration-required" ? (
			<main className="flex min-h-dvh items-center justify-center p-6"><FinishRegistration /></main>
		) : access.kind === "unauthenticated" ? (
			<>{children}</>
		) : access.kind === "inactive" ? (
			<AccountUnavailable lifecycle={access.account.lifecycle} recoveringUntil={access.account.recoveringUntil} />
		) : (
			<AccountUnavailable lifecycle="unavailable" recoveringUntil={null} />
		)}
	</MultiuserClerkProvider>;
}
