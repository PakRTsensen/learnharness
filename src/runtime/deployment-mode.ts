/**
 * THE deployment-mode selector (per-user-accounts phase 1).
 *
 * LearnHarness has three supported composition roots, and which one runs is an
 * EXPLICIT deployment decision — never inferred from the presence of Clerk
 * variables. Desktop keeps the Electron single-user launch; `single-user` is
 * the historical dev/self-hosted web profile; `multiuser-web` is the
 * Clerk-authenticated, per-Linux-identity profile gated by Phase 1–5 security
 * tests.
 *
 * Selection rules (design: docs/designs/per-user-accounts.md):
 *   1. `LH_DEPLOYMENT_MODE` always wins when set. Unknown values are a
 *      fail-closed error naming the accepted values — a typo must never
 *      silently select the shared-storage profile.
 *   2. Unset means the desktop shell's own variables decide: Electron passes
 *      `LH_DESKTOP_SERVER=1` and a per-launch `LH_DESKTOP_API_SECRET`.
 *   3. Otherwise the profile is `single-user` (dev / self-hosted web).
 *
 * Contradictions are rejected rather than resolved by precedence: the desktop
 * HTTP capability has no meaning in `multiuser-web`, where Clerk session proof
 * is the account authority.
 *
 * Diagnostics are secret-free by construction: messages carry variable NAMES
 * and parsed mode values only, never values of secret-bearing variables.
 */

/** The three composition roots the repository supports. */
export type DeploymentMode = "desktop" | "single-user" | "multiuser-web";

/** The environment surface this module reads (injectable so tests never touch process.env). */
export type DeploymentEnvironment = Record<string, string | undefined>;

/** The single variable that selects a mode explicitly. */
export const DEPLOYMENT_MODE_VARIABLE = "LH_DEPLOYMENT_MODE";

/** Accepted explicit values, in documentation order. */
export const DEPLOYMENT_MODES: readonly DeploymentMode[] = ["desktop", "single-user", "multiuser-web"];

/** Desktop-shell launch markers (electron/main.cjs). */
export const DESKTOP_SHELL_VARIABLES = ["LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET"] as const;

/** Clerk settings — required in multiuser-web, ignored (with a warning) elsewhere. */
export const CLERK_VARIABLES = ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "LH_CLERK_AUTHORIZED_PARTIES"] as const;

/** Where the selection came from, for startup logging. */
export type DeploymentModeSource = "explicit" | "desktop-shell" | "default";

export type DeploymentSelection =
	| { ok: true; mode: DeploymentMode; source: DeploymentModeSource; warnings: string[] }
	| { ok: false; error: string; warnings: string[] };

/** True when the desktop shell launched this process. Shared with desktop-access.ts semantics. */
export function desktopShellEnvironment(env: DeploymentEnvironment = process.env): boolean {
	return env.LH_DESKTOP_SERVER === "1" || Boolean(env.LH_DESKTOP_API_SECRET);
}

/** True for the account-isolated web profile (the only mode with per-user accounts). */
export function isMultiuserWebMode(mode: DeploymentMode): boolean {
	return mode === "multiuser-web";
}

/** True for the historical single shared-store web profile (dev and self-hosted web). */
export function isSingleUserMode(mode: DeploymentMode): boolean {
	return mode === "single-user";
}

/** True for the Electron-hosted profile. */
export function isDesktopMode(mode: DeploymentMode): boolean {
	return mode === "desktop";
}

function clerkVariablesPresent(env: DeploymentEnvironment): boolean {
	return CLERK_VARIABLES.some((name) => Boolean(env[name]));
}

/**
 * Resolve the deployment mode from an environment. Never throws: a refusal is
 * a discriminated result so a startup path can log it and exit deliberately.
 */
export function selectDeploymentMode(env: DeploymentEnvironment = process.env): DeploymentSelection {
	const warnings: string[] = [];
	const explicit = (env[DEPLOYMENT_MODE_VARIABLE] ?? "").trim().toLowerCase();
	const desktop = desktopShellEnvironment(env);

	if (explicit && !DEPLOYMENT_MODES.includes(explicit as DeploymentMode)) {
		return {
			ok: false,
			error: `${DEPLOYMENT_MODE_VARIABLE} must be one of ${DEPLOYMENT_MODES.join(", ")}. Refusing to guess a composition root.`,
			warnings,
		};
	}

	const mode = (explicit || (desktop ? "desktop" : "single-user")) as DeploymentMode;
	const source: DeploymentModeSource = explicit ? "explicit" : desktop ? "desktop-shell" : "default";

	// The desktop HTTP capability is not an identity: it must not coexist with
	// the Clerk-authenticated profile, where it would create a bypass branch.
	if (mode === "multiuser-web" && desktop) {
		return {
			ok: false,
			error: `${DESKTOP_SHELL_VARIABLES.join("/")} is set while ${DEPLOYMENT_MODE_VARIABLE}=multiuser-web. The desktop capability has no meaning in the multi-user profile; unset it or select desktop.`,
			warnings,
		};
	}

	// Clerk outside multiuser-web is inert, not authoritative. Say so once so an
	// operator never assumes accounts are active because the keys are present.
	if (mode !== "multiuser-web" && clerkVariablesPresent(env)) {
		warnings.push(
			`${CLERK_VARIABLES.join("/")} is set while the deployment mode is ${mode}; Clerk authentication is inactive in this profile.`,
		);
	}

	return { ok: true, mode, source, warnings };
}
