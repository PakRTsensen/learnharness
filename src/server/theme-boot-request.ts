// Injected server theme selector. Store imports remain dynamically server-local.

import { DEFAULT_THEME, themeVars } from "../core/themes.ts";
import type { ThemeBoot } from "./theme-boot.ts";
import type { WebAccountAccess } from "../core/web-account-access.ts";

/** Public/auth/error and active-account first paint never fall back to the
 * global custom-theme readers. A06+ attaches the verified account's theme. */
export function multiuserThemeBoot(access: WebAccountAccess): ThemeBoot {
	void access;
	const theme = DEFAULT_THEME;
	return { appearance: undefined, theme, vars: themeVars(theme.colors, theme.mode) };
}

export async function readRequestThemeBoot(access?: WebAccountAccess): Promise<ThemeBoot> {
	const { DEPLOYMENT_MODE, DEPLOYMENT_SELECTION } = await import("../../config.ts");
	if (!DEPLOYMENT_SELECTION.ok) return multiuserThemeBoot({ kind: "unavailable" });
	if (DEPLOYMENT_MODE === "multiuser-web") return multiuserThemeBoot(access ?? { kind: "unavailable" });
	// Deliberately local-only import: multiuser must never even compose stores.
	const { readThemeBoot } = await import("./theme-boot.ts");
	return readThemeBoot();
}
