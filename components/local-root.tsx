"use client";

import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { PluginsProvider } from "@/components/plugins";
import type { AppearanceSettings, Theme } from "@/src/core";

/** Local root copied deliberately rather than run conditionally around Clerk:
 * no alternate composition changes local provider ordering or use-effect work. */
export function LocalRoot({ children, appearance, theme }: {
	children: React.ReactNode;
	appearance: AppearanceSettings | undefined;
	theme: Theme;
}) {
	return <>
		<ServerEventsProvider>
			<PluginsProvider>
				<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</PluginsProvider>
		</ServerEventsProvider>
		<UpdateBanner />
	</>;
}

