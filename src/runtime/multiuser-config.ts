/**
 * MULTIUSER WEB CONFIGURATION (per-user accounts, Phase 1, 2026-11-12).
 *
 * Everything here is read at RUNTIME from the host environment. Clerk
 * publishable/secret keys are deliberately NOT part of this seam:
 *   - session proofs are verified against a configured issuer/JWKS URL;
 *   - the application's own session cookie is signed with LH_SESSION_SECRET;
 *   - no NEXT_PUBLIC_* value is baked into the build.
 *
 * The local provider is the offline/development simulation of Clerk identity:
 * it mints the same HS256 session cookie shape without contacting any service.
 * It is refused in production unless the host explicitly opts in with
 * LH_ALLOW_LOCAL_AUTH=1 (for offline Docker demos and tests).
 *
 * Secrets are validated but never returned in error messages.
 */

import path from "node:path";
import { RUNTIME_PATHS } from "../../config.ts";

export type AuthProvider = "local" | "clerk";

export interface IdentityRange {
	start: number;
	end: number;
}

export interface MultiuserPaths {
	accountRoot: string;
	controllerStateDir: string;
	stagingDir: string;
	snapshotDir: string;
	privateWorkDir: string;
}

export interface LocalAuthConfig {
	provider: "local";
	sessionSecret: string;
	allowLocalAuth: true;
}

export interface ClerkAuthConfig {
	provider: "clerk";
	sessionSecret: string;
	issuer: string;
	jwksUrl: string;
	audience?: string;
	/** Exact `azp` values accepted from Clerk session tokens. */
	authorizedParties: string[];
	/** Public origin of this installation; also the default authorized party. */
	appOrigin: string;
	/** Clerk's browser session cookie, used only for same-origin custom-domain
	 *  deployments. The primary exchange is a POSTed session token. */
	sessionCookie: string;
	signInUrl?: string;
	signUpUrl?: string;
	webhookSecret?: string;
}

export type AuthConfig = LocalAuthConfig | ClerkAuthConfig;

export interface ResourceLimits {
	maxActiveAccounts: number;
	maxActiveWorkers: number;
	maxStreams: number;
	maxArchiveJobs: number;
	maxProviderConnections: number;
	maxTemporaryBytes: number;
}

export interface MultiuserConfig {
	paths: MultiuserPaths;
	uidRange: IdentityRange;
	gidRange: IdentityRange;
	auth: AuthConfig;
	/** Always true: public multiuser startup requires a read-only root. */
	readOnlyRootFilesystem: true;
	writableMounts: string[];
	limits: ResourceLimits;
	/** Application session lifetime. */
	sessionTtlSeconds: number;
}

export interface ConfigIssue {
	code: string;
	message: string;
}

export type MultiuserConfigResult =
	| { ok: true; config: MultiuserConfig }
	| { ok: false; issues: ConfigIssue[] };

const LIMIT_DEFAULTS: ResourceLimits = {
	maxActiveAccounts: 20,
	maxActiveWorkers: 40,
	maxStreams: 100,
	maxArchiveJobs: 2,
	maxProviderConnections: 32,
	maxTemporaryBytes: 10 * 1024 * 1024 * 1024,
};

const LIMIT_ENV: Record<keyof ResourceLimits, string> = {
	maxActiveAccounts: "LH_MAX_ACTIVE_ACCOUNTS",
	maxActiveWorkers: "LH_MAX_ACTIVE_WORKERS",
	maxStreams: "LH_MAX_STREAMS",
	maxArchiveJobs: "LH_MAX_ARCHIVE_JOBS",
	maxProviderConnections: "LH_MAX_PROVIDER_CONNECTIONS",
	maxTemporaryBytes: "LH_MAX_TEMPORARY_BYTES",
};

function issue(issues: ConfigIssue[], code: string, message: string): void {
	issues.push({ code, message });
}

function envPath(env: Record<string, string | undefined>, name: string, fallback: string, issues: ConfigIssue[]): string {
	const raw = env[name]?.trim();
	const value = raw && raw.length > 0 ? raw : fallback;
	if (!path.isAbsolute(value)) {
		issue(issues, "path_not_absolute", `${name} must be an absolute path.`);
		return path.resolve(value);
	}
	return path.normalize(value);
}

function inside(child: string, parent: string): boolean {
	if (child === parent) return true;
	return child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function parseRange(
	env: Record<string, string | undefined>,
	startName: string,
	endName: string,
	issues: ConfigIssue[],
): IdentityRange {
	const startRaw = env[startName]?.trim();
	const endRaw = env[endName]?.trim();
	const start = startRaw ? Number(startRaw) : 200000;
	const end = endRaw ? Number(endRaw) : 200999;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1000 || end < start || end > 2_147_483_647) {
		issue(issues, "identity_range_invalid", `${startName}/${endName} must be integers with 1000 <= start <= end.`);
		return { start: 200000, end: 200999 };
	}
	if (end - start + 1 > 10_000) {
		issue(issues, "identity_range_too_large", `${startName}/${endName} may not span more than 10000 identities.`);
	}
	return { start, end };
}

function parseSecret(
	env: Record<string, string | undefined>,
	name: string,
	issues: ConfigIssue[],
): string | undefined {
	const value = env[name];
	if (value === undefined || value.length === 0) return undefined;
	if (value !== value.trim()) {
		issue(issues, "secret_has_surrounding_whitespace", `${name} must not have leading or trailing whitespace.`);
		return undefined;
	}
	if (value.length < 32 || value.length > 512) {
		issue(issues, "secret_length_invalid", `${name} must be between 32 and 512 characters.`);
		return undefined;
	}
	return value;
}

function parseHttpUrl(
	raw: string | undefined,
	name: string,
	issues: ConfigIssue[],
	options: { allowLocalHttp?: boolean } = {},
): string | undefined {
	if (!raw) {
		issue(issues, "url_missing", `${name} is required.`);
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		issue(issues, "url_invalid", `${name} must be an absolute URL.`);
		return undefined;
	}
	if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
		issue(issues, "url_invalid", `${name} must be an origin without credentials, path, query, or fragment.`);
		return undefined;
	}
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(options.allowLocalHttp !== false && local && url.protocol === "http:")) {
		issue(issues, "url_insecure", `${name} must use https (http is accepted only for localhost).`);
		return undefined;
	}
	return url.origin;
}

function parsePositiveInt(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	issues: ConfigIssue[],
): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		issue(issues, "limit_invalid", `${name} must be a positive integer.`);
		return fallback;
	}
	return value;
}

function parseMounts(
	env: Record<string, string | undefined>,
	issues: ConfigIssue[],
): string[] {
	const raw = env.LH_WRITABLE_MOUNTS?.trim();
	if (!raw) {
		issue(issues, "writable_mounts_missing", "LH_WRITABLE_MOUNTS must enumerate the designated writable mounts.");
		return [];
	}
	const mounts = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
	if (mounts.length === 0) {
		issue(issues, "writable_mounts_missing", "LH_WRITABLE_MOUNTS must enumerate at least one writable mount.");
		return [];
	}
	const normalized: string[] = [];
	for (const mount of mounts) {
		if (!path.isAbsolute(mount)) {
			issue(issues, "writable_mount_not_absolute", "Every LH_WRITABLE_MOUNTS entry must be an absolute path.");
			continue;
		}
		normalized.push(path.normalize(mount));
	}
	return normalized;
}

function localAuthAllowed(env: Record<string, string | undefined>): boolean {
	return env.NODE_ENV !== "production" || env.LH_ALLOW_LOCAL_AUTH === "1";
}

/**
 * Load and validate the multiuser configuration. Pure: it never touches the
 * filesystem and never logs or returns secret values.
 */
export function loadMultiuserConfig(
	env: Record<string, string | undefined> = process.env,
): MultiuserConfigResult {
	const issues: ConfigIssue[] = [];

	const paths: MultiuserPaths = {
		accountRoot: envPath(env, "LH_ACCOUNT_ROOT", RUNTIME_PATHS.accountRoot, issues),
		controllerStateDir: envPath(env, "LH_CONTROLLER_STATE_DIR", RUNTIME_PATHS.controllerState, issues),
		stagingDir: envPath(env, "LH_STAGING_DIR", RUNTIME_PATHS.staging, issues),
		snapshotDir: envPath(env, "LH_SNAPSHOT_DIR", RUNTIME_PATHS.snapshots, issues),
		privateWorkDir: envPath(env, "LH_PRIVATE_WORK_DIR", RUNTIME_PATHS.privateWork, issues),
	};

	const namedPaths: Array<[string, string]> = [
		["LH_ACCOUNT_ROOT", paths.accountRoot],
		["LH_CONTROLLER_STATE_DIR", paths.controllerStateDir],
		["LH_STAGING_DIR", paths.stagingDir],
		["LH_SNAPSHOT_DIR", paths.snapshotDir],
		["LH_PRIVATE_WORK_DIR", paths.privateWorkDir],
	];
	for (const [name, value] of namedPaths) {
		if (inside(value, paths.accountRoot) && name !== "LH_ACCOUNT_ROOT") {
			issue(issues, "path_overlaps_account_root", `${name} must live outside the account root.`);
		}
		if (inside(paths.accountRoot, value) && name !== "LH_ACCOUNT_ROOT") {
			issue(issues, "path_overlaps_account_root", `${name} must not contain the account root.`);
		}
	}
	if (inside(paths.controllerStateDir, paths.stagingDir) || inside(paths.stagingDir, paths.controllerStateDir)) {
		issue(issues, "path_overlap", "Controller state and upload staging must be separate directories.");
	}

	const uidRange = parseRange(env, "LH_UID_RANGE_START", "LH_UID_RANGE_END", issues);
	const gidRange = parseRange(env, "LH_GID_RANGE_START", "LH_GID_RANGE_END", issues);

	if (env.LH_READ_ONLY_ROOT_FS !== "1") {
		issue(issues, "read_only_root_required", "Public multiuser startup requires LH_READ_ONLY_ROOT_FS=1.");
	}

	const writableMounts = parseMounts(env, issues);
	for (const [name, value] of namedPaths) {
		if (writableMounts.length > 0 && !writableMounts.some((mount) => inside(value, mount))) {
			issue(issues, "path_not_writable", `${name} must be inside a designated writable mount.`);
		}
	}

	const limits: ResourceLimits = {
		maxActiveAccounts: parsePositiveInt(env, LIMIT_ENV.maxActiveAccounts, LIMIT_DEFAULTS.maxActiveAccounts, issues),
		maxActiveWorkers: parsePositiveInt(env, LIMIT_ENV.maxActiveWorkers, LIMIT_DEFAULTS.maxActiveWorkers, issues),
		maxStreams: parsePositiveInt(env, LIMIT_ENV.maxStreams, LIMIT_DEFAULTS.maxStreams, issues),
		maxArchiveJobs: parsePositiveInt(env, LIMIT_ENV.maxArchiveJobs, LIMIT_DEFAULTS.maxArchiveJobs, issues),
		maxProviderConnections: parsePositiveInt(env, LIMIT_ENV.maxProviderConnections, LIMIT_DEFAULTS.maxProviderConnections, issues),
		maxTemporaryBytes: parsePositiveInt(env, LIMIT_ENV.maxTemporaryBytes, LIMIT_DEFAULTS.maxTemporaryBytes, issues),
	};

	const sessionTtlRaw = env.LH_SESSION_TTL_SECONDS?.trim();
	let sessionTtlSeconds = 43_200;
	if (sessionTtlRaw) {
		const parsed = Number(sessionTtlRaw);
		if (!Number.isSafeInteger(parsed) || parsed < 300 || parsed > 604_800) {
			issue(issues, "session_ttl_invalid", "LH_SESSION_TTL_SECONDS must be between 300 and 604800.");
		} else {
			sessionTtlSeconds = parsed;
		}
	}

	const providerRaw = (env.LH_AUTH_PROVIDER?.trim().toLowerCase() || "clerk") as AuthProvider;
	let auth: AuthConfig | undefined;

	if (providerRaw === "local") {
		if (!localAuthAllowed(env)) {
			issue(issues, "local_auth_not_allowed", "The local auth provider requires LH_ALLOW_LOCAL_AUTH=1 in production.");
		}
		const sessionSecret = parseSecret(env, "LH_LOCAL_AUTH_SECRET", issues)
			?? parseSecret(env, "LH_SESSION_SECRET", issues);
		if (sessionSecret) {
			auth = { provider: "local", sessionSecret, allowLocalAuth: true };
		} else {
			issue(issues, "session_secret_missing", "The local auth provider requires LH_LOCAL_AUTH_SECRET (or LH_SESSION_SECRET).");
		}
	} else if (providerRaw === "clerk") {
		const sessionSecret = parseSecret(env, "LH_SESSION_SECRET", issues);
		if (!sessionSecret) {
			issue(issues, "session_secret_missing", "Clerk mode requires LH_SESSION_SECRET (32-512 characters).");
		}
		const issuer = parseHttpUrl(env.CLERK_ISSUER?.trim(), "CLERK_ISSUER", issues);
		const jwksUrl = env.CLERK_JWKS_URL?.trim()
			? parseHttpUrl(env.CLERK_JWKS_URL.trim(), "CLERK_JWKS_URL", issues)
			: issuer ? `${issuer}/.well-known/jwks.json` : undefined;
		const appOrigin = parseHttpUrl(env.LH_APP_ORIGIN?.trim(), "LH_APP_ORIGIN", issues);
		const audience = env.CLERK_AUDIENCE?.trim() || undefined;
		const authorizedParties = (env.CLERK_AUTHORIZED_PARTIES ?? "")
			.split(",").map((party) => party.trim()).filter(Boolean);
		if (appOrigin && !authorizedParties.includes(appOrigin)) authorizedParties.push(appOrigin);
		const sessionCookie = env.CLERK_SESSION_COOKIE?.trim() || "__session";
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionCookie)) {
			issue(issues, "clerk_session_cookie_invalid", "CLERK_SESSION_COOKIE must be a simple cookie name.");
		}
		const webhookSecret = env.CLERK_WEBHOOK_SECRET?.trim() || undefined;
		if (webhookSecret && (!webhookSecret.startsWith("whsec_") || webhookSecret.length < 24)) {
			issue(issues, "clerk_webhook_secret_invalid", "CLERK_WEBHOOK_SECRET must be a svix whsec_ secret.");
		}
		const signInUrl = env.CLERK_SIGN_IN_URL?.trim()
			? parseHttpUrl(env.CLERK_SIGN_IN_URL.trim(), "CLERK_SIGN_IN_URL", issues)
			: undefined;
		const signUpUrl = env.CLERK_SIGN_UP_URL?.trim()
			? parseHttpUrl(env.CLERK_SIGN_UP_URL.trim(), "CLERK_SIGN_UP_URL", issues)
			: undefined;
		if (sessionSecret && issuer && jwksUrl && appOrigin) {
			auth = {
				provider: "clerk",
				sessionSecret,
				issuer,
				jwksUrl,
				...(audience ? { audience } : {}),
				authorizedParties,
				appOrigin,
				sessionCookie,
				...(signInUrl ? { signInUrl } : {}),
				...(signUpUrl ? { signUpUrl } : {}),
				...(webhookSecret && webhookSecret.startsWith("whsec_") ? { webhookSecret } : {}),
			};
		}
	} else {
		issue(issues, "auth_provider_invalid", "LH_AUTH_PROVIDER must be local or clerk.");
	}

	if (!auth) {
		issue(issues, "auth_not_configured", "Multiuser authentication is not configured.");
	}

	if (issues.length > 0 || !auth) return { ok: false, issues };

	return {
		ok: true,
		config: {
			paths,
			uidRange,
			gidRange,
			auth,
			readOnlyRootFilesystem: true,
			writableMounts,
			limits,
			sessionTtlSeconds,
		},
	};
}
