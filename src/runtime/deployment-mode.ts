/**
 * THE DEPLOYMENT-MODE SEAM (per-user accounts, Phase 1, 2026-11-12).
 *
 * One process family, three explicit compositions:
 *
 *   desktop          — the Electron shell. Keeps the existing local, single-user
 *                      data paths and the per-launch HTTP capability.
 *   single-user-web  — `next dev` / `next start` / the current Docker image.
 *                      Byte-for-byte the historical shared-server behavior.
 *   multiuser-web    — the new composition root selected by the host with
 *                      LH_DEPLOYMENT_MODE=multiuser-web. It requires the
 *                      multiuser configuration and readiness gates in
 *                      src/runtime/multiuser-config.ts and readiness.ts.
 *
 * DESIGN RULE: merely exporting Clerk variables never selects multiuser mode.
 * The host must opt in explicitly; a typo or a partially configured deployment
 * must refuse to start instead of silently falling back to shared storage.
 */

export const DEPLOYMENT_MODES = ["desktop", "single-user-web", "multiuser-web"] as const;

export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export type DeploymentModeErrorCode =
	| "invalid_deployment_mode"
	| "desktop_mode_not_explicit"
	| "desktop_multiuser_conflict";

export interface DeploymentModeSelection {
	mode: DeploymentMode;
	source: "default" | "desktop-launch" | "explicit";
}

export type DeploymentModeResult =
	| { ok: true; selection: DeploymentModeSelection }
	| { ok: false; code: DeploymentModeErrorCode; message: string };

export class DeploymentModeError extends Error {
	readonly code: DeploymentModeErrorCode;

	constructor(code: DeploymentModeErrorCode, message: string) {
		super(message);
		this.name = "DeploymentModeError";
		this.code = code;
	}
}

function selectedMode(raw: string | undefined): DeploymentMode | undefined {
	if (!raw) return undefined;
	const normalized = raw.trim().toLowerCase();
	return (DEPLOYMENT_MODES as readonly string[]).includes(normalized)
		? (normalized as DeploymentMode)
		: undefined;
}

/** The Electron shell identifies itself with a launch marker, never with the
 *  application data paths: a web deployment must not be mistaken for desktop
 *  merely because LH_DATA_DIR is set. */
function desktopLaunchMarker(env: Record<string, string | undefined>): boolean {
	return env.LH_DESKTOP_SERVER === "1" || (env.LH_DESKTOP_API_SECRET?.length ?? 0) > 0;
}

/**
 * Pure mode selection. No filesystem or secret access so it can run in the
 * Proxy and in startup code without side effects.
 */
export function parseDeploymentMode(
	env: Record<string, string | undefined> = process.env,
): DeploymentModeResult {
	const raw = env.LH_DEPLOYMENT_MODE;
	const explicit = selectedMode(raw);
	const desktop = desktopLaunchMarker(env);

	if (raw !== undefined && raw.trim() !== "" && !explicit) {
		return {
			ok: false,
			code: "invalid_deployment_mode",
			message: `LH_DEPLOYMENT_MODE must be one of ${DEPLOYMENT_MODES.join(", ")}.`,
		};
	}

	if (!explicit) {
		return desktop
			? { ok: true, selection: { mode: "desktop", source: "desktop-launch" } }
			: { ok: true, selection: { mode: "single-user-web", source: "default" } };
	}

	if (explicit === "desktop" && !desktop) {
		return {
			ok: false,
			code: "desktop_mode_not_explicit",
			message: "desktop mode requires the Electron launch marker (LH_DESKTOP_SERVER=1 or LH_DESKTOP_API_SECRET).",
		};
	}

	if (explicit === "multiuser-web" && desktop) {
		return {
			ok: false,
			code: "desktop_multiuser_conflict",
			message: "multiuser-web cannot run with the desktop launch marker.",
		};
	}

	return { ok: true, selection: { mode: explicit, source: "explicit" } };
}

/** Fail-closed mode accessor: invalid configuration throws rather than
 *  degrading into the historical shared-storage composition. */
export function deploymentMode(env: Record<string, string | undefined> = process.env): DeploymentMode {
	const parsed = parseDeploymentMode(env);
	if (!parsed.ok) throw new DeploymentModeError(parsed.code, parsed.message);
	return parsed.selection.mode;
}

/** True only for the one explicit multiuser composition. Throws on an invalid
 *  selector so a typo cannot produce a shared-storage web process. */
export function isMultiuserWeb(env: Record<string, string | undefined> = process.env): boolean {
	return deploymentMode(env) === "multiuser-web";
}
