/**
 * MULTI-USER WEB CONFIGURATION (per-user-accounts phase 1).
 *
 * Parses and validates the deployment surface the account-isolated profile
 * needs: the account root, the UID/GID allocation window, the controller-owned
 * instance state, the root-locked staging/snapshot/private-working roots, the
 * private IPC endpoints, required Clerk credentials and trusted origins, and
 * the mandatory resource limits.
 *
 * Two rules shape everything here:
 *
 *   1. FAIL CLOSED. A missing, malformed, or contradictory value is an error,
 *      never a silent default where the design forbids one. The only defaults
 *      are the fixed layout paths (which the Docker image ships with).
 *   2. NO SECRETS IN DIAGNOSTICS. Errors name the VARIABLE, never its value.
 *      `clerk.secretKey` is carried in memory for later phases and is absent
 *      from every summary/error string by construction.
 *
 * This module is pure: it reads the environment object it is given and never
 * touches the filesystem. Mount, ownership, and identity inspection live in
 * `readiness.ts` so they can be tested with fixtures.
 */

import path from "node:path";

/** Resource limits every multiuser-web deployment must state. No defaults on purpose. */
export const ACCOUNT_LIMIT_VARIABLES = {
	processes: "LH_ACCOUNT_MAX_PROCESSES",
	cpuMillicores: "LH_ACCOUNT_MAX_CPU_MILLICORES",
	memoryMb: "LH_ACCOUNT_MAX_MEMORY_MB",
	concurrentJobs: "LH_ACCOUNT_MAX_CONCURRENT_JOBS",
	diskMb: "LH_ACCOUNT_MAX_DISK_MB",
} as const;

/** Global admission limits every multiuser-web deployment must state. */
export const GLOBAL_LIMIT_VARIABLES = {
	activeAccounts: "LH_GLOBAL_MAX_ACTIVE_ACCOUNTS",
	activeWorkers: "LH_GLOBAL_MAX_ACTIVE_WORKERS",
	streams: "LH_GLOBAL_MAX_STREAMS",
	providerConnections: "LH_GLOBAL_MAX_PROVIDER_CONNECTIONS",
	archiveJobs: "LH_GLOBAL_MAX_ARCHIVE_JOBS",
	tempBytes: "LH_GLOBAL_MAX_TEMP_BYTES",
} as const;

/** Fixed layout variables with their documented image defaults. */
export const LAYOUT_VARIABLES = {
	accountRoot: { name: "LH_ACCOUNT_ROOT", fallback: "/data/accounts" },
	registryDir: { name: "LH_REGISTRY_DIR", fallback: "/data/registry" },
	instanceStateDir: { name: "LH_INSTANCE_STATE_DIR", fallback: "/data/instance" },
	stagingDir: { name: "LH_STAGING_DIR", fallback: "/data/staging" },
	snapshotDir: { name: "LH_SNAPSHOT_DIR", fallback: "/data/snapshots" },
	privateWorkDir: { name: "LH_PRIVATE_WORK_DIR", fallback: "/data/private-work" },
	controllerIpc: { name: "LH_CONTROLLER_IPC", fallback: "/run/lh/controller.sock" },
	helperIpc: { name: "LH_HELPER_IPC", fallback: "/run/lh/helper.sock" },
} as const;

type LayoutKey = keyof typeof LAYOUT_VARIABLES;

/** The writable filesystem roots (the IPC endpoints are files, not roots). */
const WRITABLE_ROOT_KEYS = [
	"accountRoot",
	"registryDir",
	"instanceStateDir",
	"stagingDir",
	"snapshotDir",
	"privateWorkDir",
] as const satisfies readonly LayoutKey[];

const SOCKET_KEYS = ["controllerIpc", "helperIpc"] as const satisfies readonly LayoutKey[];

/** Identity allocation window variables. */
export const ID_VARIABLES = {
	uidMin: { name: "LH_ACCOUNT_UID_MIN", fallback: 30_000 },
	uidMax: { name: "LH_ACCOUNT_UID_MAX", fallback: 39_999 },
	gidMin: { name: "LH_ACCOUNT_GID_MIN", fallback: 30_000 },
	gidMax: { name: "LH_ACCOUNT_GID_MAX", fallback: 39_999 },
} as const;

/**
 * The UNPRIVILEGED WEB IDENTITY (per-user-accounts design, "the web UID").
 *
 * Readiness must be able to answer "can the web process reach this root?", so it
 * needs the identity the web process runs as. The Docker image runs the server
 * as the `node` user (uid/gid 1000), which sits BELOW the account window, so the
 * account-window checks in this module cannot see it at all. These values are
 * declared by the operator and, at real startup, cross-checked against
 * `process.getuid()`/`getgid()` — declaring an identity the process does not
 * have is a refusal, not a silent no-op.
 */
export const WEB_IDENTITY_VARIABLES = {
	uid: "LH_WEB_UID",
	gid: "LH_WEB_GID",
} as const;

/** Fallbacks match the shipped image (`USER node`: 1000:1000). */
export const WEB_IDENTITY_FALLBACK = { uid: 1000, gid: 1000 } as const;

/** Clerk keys come from the SDK's own documented variable names. */
export const CLERK_SECRET_VARIABLE = "CLERK_SECRET_KEY";
export const CLERK_PUBLISHABLE_VARIABLE = "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY";
/** Explicit canonical origins trusted by Clerk's `authorizedParties` verifier. */
export const CLERK_AUTHORIZED_PARTIES_VARIABLE = "LH_CLERK_AUTHORIZED_PARTIES";

/** Lowest identity an account may receive; below this are system/service users. */
export const MINIMUM_ACCOUNT_ID = 1_000;
/** Upper bound keeps the ledger's numbers comfortably inside 32-bit POSIX ids. */
export const MAXIMUM_ACCOUNT_ID = 2_000_000_000;

export interface IdRange {
	min: number;
	max: number;
}

export interface AccountLimits {
	processes: number;
	cpuMillicores: number;
	memoryMb: number;
	concurrentJobs: number;
	diskMb: number;
}

export interface GlobalLimits {
	activeAccounts: number;
	activeWorkers: number;
	streams: number;
	providerConnections: number;
	archiveJobs: number;
	tempBytes: number;
}

export interface MultiuserConfig {
	/** Root of every account home. Root-owned, non-traversable by the web UID. */
	accountRoot: string;
	/** The unprivileged web identity these roots must exclude. */
	webIdentity: { uid: number; gid: number };
	uidRange: IdRange;
	gidRange: IdRange;
	/** Controller-only registry + non-reuse ledger location. */
	registryDir: string;
	/** Controller-only instance state (encryption keys, shared policy). */
	instanceStateDir: string;
	/** Root-locked upload/import staging outside live account data. */
	stagingDir: string;
	/** Root-controlled export snapshots. */
	snapshotDir: string;
	/** Per-account private working directories (temp/caches). */
	privateWorkDir: string;
	/** Private controller IPC endpoint (web relay → controller). */
	controllerIpc: string;
	/** Private helper IPC endpoint (controller → root helper). */
	helperIpc: string;
	/** Clerk credentials and canonical trusted origins. Credentials never enter logs or errors. */
	clerk: { secretKey: string; publishableKey: string; authorizedParties: string[] };
	limits: { account: AccountLimits; global: GlobalLimits };
}

export type MultiuserConfigResult =
	| { ok: true; config: MultiuserConfig; warnings: string[] }
	| { ok: false; errors: string[]; warnings: string[] };

export interface MultiuserConfigOptions {
	/** Identities already taken on the host (readiness supplies these from the passwd/group databases). */
	reservedUids?: Iterable<number>;
	reservedGids?: Iterable<number>;
}

export type Environment = Record<string, string | undefined>;

export function canonicalLayoutPath(value: string): string {
	// `path.posix.normalize` collapses `//` and resolves `.`/`..`, but it KEEPS a
	// trailing slash: "/data/accounts/" stays "/data/accounts/". Every containment
	// check here compares with `${root}/`, so one trailing slash silently defeats
	// all of them (an IPC socket inside the account root would be accepted).
	// Canonicalize once, at the single point every layout path passes through.
	return path.posix.normalize(value).replace(/\/+$/, "");
}

function readLayoutPath(env: Environment, key: LayoutKey): { value: string } | { error: string } {
	const { name, fallback } = LAYOUT_VARIABLES[key];
	const raw = (env[name] ?? "").trim();
	const value = raw || fallback;
	if (value.includes("\0")) return { error: `${name} contains a NUL byte.` };
	if (!path.posix.isAbsolute(value)) return { error: `${name} must be an absolute path.` };
	const normalized = canonicalLayoutPath(value);
	if (!normalized || normalized === "/") return { error: `${name} must not be the filesystem root.` };
	if (normalized === "." || normalized.startsWith("..")) return { error: `${name} must resolve beneath an absolute root.` };
	return { value: normalized };
}

function readPositiveInteger(env: Environment, name: string, errors: string[]): number | undefined {
	const raw = (env[name] ?? "").trim();
	if (!raw) {
		errors.push(`${name} is required in multiuser-web and must be a positive integer.`);
		return undefined;
	}
	if (!/^\d+$/.test(raw)) {
		errors.push(`${name} must be a positive integer (digits only).`);
		return undefined;
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		errors.push(`${name} must be a positive integer.`);
		return undefined;
	}
	return value;
}

function readIdentityBoundary(env: Environment, name: string, fallback: number, errors: string[]): number | undefined {
	const raw = (env[name] ?? "").trim();
	if (!raw) return fallback;
	if (!/^\d+$/.test(raw)) {
		errors.push(`${name} must be a positive integer.`);
		return undefined;
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		errors.push(`${name} must be a positive integer.`);
		return undefined;
	}
	return value;
}

function readIdRange(
	env: Environment,
	low: { name: string; fallback: number },
	high: { name: string; fallback: number },
	label: "UID" | "GID",
	reserved: Iterable<number> | undefined,
): { range?: IdRange; errors: string[] } {
	const errors: string[] = [];
	const min = readIdentityBoundary(env, low.name, low.fallback, errors);
	const max = readIdentityBoundary(env, high.name, high.fallback, errors);
	if (min === undefined || max === undefined) return { errors };
	if (min < MINIMUM_ACCOUNT_ID) errors.push(`${low.name} must be at least ${MINIMUM_ACCOUNT_ID} (system/service identities are never account identities).`);
	if (max > MAXIMUM_ACCOUNT_ID) errors.push(`${high.name} must be at most ${MAXIMUM_ACCOUNT_ID}.`);
	if (max < min) errors.push(`${high.name} must not be lower than ${low.name}.`);
	if (reserved) {
		for (const taken of reserved) {
			if (taken >= min && taken <= max) {
				errors.push(`The ${label} window ${min}-${max} includes ${taken}, which the host already uses.`);
				break;
			}
		}
	}
	return errors.length ? { errors } : { range: { min, max }, errors };
}

function overlaps(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

function readClerkAuthorizedParties(env: Environment, errors: string[]): string[] {
	const raw = (env[CLERK_AUTHORIZED_PARTIES_VARIABLE] ?? "").trim();
	if (!raw) {
		errors.push(`${CLERK_AUTHORIZED_PARTIES_VARIABLE} is required in multiuser-web and must list canonical origins.`);
		return [];
	}
	const parties = raw.split(",").map(value => value.trim());
	const valid: string[] = [];
	if (parties.some(party => !party)) {
		errors.push(`${CLERK_AUTHORIZED_PARTIES_VARIABLE} must not contain empty origins.`);
		return [];
	}
	for (const party of parties) {
		let parsed: URL;
		try { parsed = new URL(party); }
		catch {
			errors.push(`${CLERK_AUTHORIZED_PARTIES_VARIABLE} must contain canonical http(s) origins.`);
			continue;
		}
		if (parsed.origin !== party || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href !== `${party}/`) {
			errors.push(`${CLERK_AUTHORIZED_PARTIES_VARIABLE} must contain canonical http(s) origins without paths, credentials, queries, or fragments.`);
			continue;
		}
		const localHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost"));
		if (parsed.protocol !== "https:" && !localHttp) {
			errors.push(`${CLERK_AUTHORIZED_PARTIES_VARIABLE} may use http only for localhost origins; other origins must use https.`);
			continue;
		}
		valid.push(party);
	}
	if (valid.length !== parties.length) return [];
	if (new Set(valid).size !== valid.length) {
		errors.push(`${CLERK_AUTHORIZED_PARTIES_VARIABLE} must not contain duplicate origins.`);
		return [];
	}
	return valid;
}

/**
 * Parse and validate the multiuser-web surface. Never throws; every refusal is
 * an error string that names the variable and never echoes its value.
 */
export function loadMultiuserConfig(env: Environment = process.env, options: MultiuserConfigOptions = {}): MultiuserConfigResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const paths: Partial<Record<LayoutKey, string>> = {};
	for (const key of Object.keys(LAYOUT_VARIABLES) as LayoutKey[]) {
		const read = readLayoutPath(env, key);
		if ("error" in read) errors.push(read.error);
		else paths[key] = read.value;
	}

	const uid = readIdRange(env, ID_VARIABLES.uidMin, ID_VARIABLES.uidMax, "UID", options.reservedUids);
	const gid = readIdRange(env, ID_VARIABLES.gidMin, ID_VARIABLES.gidMax, "GID", options.reservedGids);
	errors.push(...uid.errors, ...gid.errors);

	const webIdentity = {
		uid: readIdentityBoundary(env, WEB_IDENTITY_VARIABLES.uid, WEB_IDENTITY_FALLBACK.uid, errors),
		gid: readIdentityBoundary(env, WEB_IDENTITY_VARIABLES.gid, WEB_IDENTITY_FALLBACK.gid, errors),
	};

	// The web identity must be excluded from the allocation window: an account
	// that happened to receive the web UID/GID would own the relay's identity.
	if (uid.range && webIdentity.uid !== undefined && webIdentity.uid >= uid.range.min && webIdentity.uid <= uid.range.max) {
		errors.push(`${WEB_IDENTITY_VARIABLES.uid} must lie outside the account UID window; it is the unprivileged web identity, not an account.`);
	}
	if (gid.range && webIdentity.gid !== undefined && webIdentity.gid >= gid.range.min && webIdentity.gid <= gid.range.max) {
		errors.push(`${WEB_IDENTITY_VARIABLES.gid} must lie outside the account GID window; it is the unprivileged web identity, not an account.`);
	}

	// The design requires a DEDICATED UNPRIVILEGED web identity. Root ignores
	// permission bits entirely, so a declared 0 would make every ownership and
	// mode check below vacuous — the gate would "pass" while the web process
	// could read and rewrite every account home regardless of mode.
	if (webIdentity.uid === 0) errors.push(`${WEB_IDENTITY_VARIABLES.uid} must not be 0; the web identity must be unprivileged.`);
	if (webIdentity.gid === 0) errors.push(`${WEB_IDENTITY_VARIABLES.gid} must not be 0; the web identity must be unprivileged.`);

	// Every writable root must be its own subtree: a nested root would let one
	// category's data live inside another's, defeating the designated-mount check.
	const roots = WRITABLE_ROOT_KEYS.flatMap((key) => {
		const value = paths[key];
		return value ? [{ key, value }] : [];
	});
	for (let i = 0; i < roots.length; i++) {
		for (let j = i + 1; j < roots.length; j++) {
			const left = roots[i]!;
			const right = roots[j]!;
			if (overlaps(left.value, right.value)) {
				errors.push(`${LAYOUT_VARIABLES[left.key].name} and ${LAYOUT_VARIABLES[right.key].name} must be separate, non-nested paths.`);
			}
		}
	}

	// Sockets inside a writable root would be reachable by the web or account identities.
	for (const socketKey of SOCKET_KEYS) {
		const socket = paths[socketKey];
		if (!socket) continue;
		if (!socket.endsWith(".sock")) {
			errors.push(`${LAYOUT_VARIABLES[socketKey].name} must name a .sock endpoint.`);
			continue;
		}
		for (const root of roots) {
			if (overlaps(socket, root.value)) {
				errors.push(`${LAYOUT_VARIABLES[socketKey].name} must not live inside ${LAYOUT_VARIABLES[root.key].name}.`);
			}
		}
	}

	// Two DIFFERENT trust boundaries must not share one endpoint. The web→
	// controller socket and the controller→root-helper socket carry different
	// peer authorities; aliasing them lets one peer answer the other's traffic.
	const [controllerSocket, helperSocket] = [paths.controllerIpc, paths.helperIpc];
	if (controllerSocket && helperSocket && controllerSocket === helperSocket) {
		errors.push(`${LAYOUT_VARIABLES.controllerIpc.name} and ${LAYOUT_VARIABLES.helperIpc.name} must be separate endpoints (they carry different peer authorities).`);
	}

	const secretKey = (env[CLERK_SECRET_VARIABLE] ?? "").trim();
	const publishableKey = (env[CLERK_PUBLISHABLE_VARIABLE] ?? "").trim();
	const authorizedParties = readClerkAuthorizedParties(env, errors);
	if (!secretKey) errors.push(`${CLERK_SECRET_VARIABLE} is required in multiuser-web.`);
	else if (!/^sk_(test|live)_/.test(secretKey)) errors.push(`${CLERK_SECRET_VARIABLE} does not look like a Clerk secret key (expected an sk_test_ or sk_live_ prefix).`);
	if (!publishableKey) errors.push(`${CLERK_PUBLISHABLE_VARIABLE} is required in multiuser-web.`);
	else if (!/^pk_(test|live)_/.test(publishableKey)) errors.push(`${CLERK_PUBLISHABLE_VARIABLE} does not look like a Clerk publishable key (expected a pk_test_ or pk_live_ prefix).`);

	const account = {
		processes: readPositiveInteger(env, ACCOUNT_LIMIT_VARIABLES.processes, errors),
		cpuMillicores: readPositiveInteger(env, ACCOUNT_LIMIT_VARIABLES.cpuMillicores, errors),
		memoryMb: readPositiveInteger(env, ACCOUNT_LIMIT_VARIABLES.memoryMb, errors),
		concurrentJobs: readPositiveInteger(env, ACCOUNT_LIMIT_VARIABLES.concurrentJobs, errors),
		diskMb: readPositiveInteger(env, ACCOUNT_LIMIT_VARIABLES.diskMb, errors),
	};
	const global = {
		activeAccounts: readPositiveInteger(env, GLOBAL_LIMIT_VARIABLES.activeAccounts, errors),
		activeWorkers: readPositiveInteger(env, GLOBAL_LIMIT_VARIABLES.activeWorkers, errors),
		streams: readPositiveInteger(env, GLOBAL_LIMIT_VARIABLES.streams, errors),
		providerConnections: readPositiveInteger(env, GLOBAL_LIMIT_VARIABLES.providerConnections, errors),
		archiveJobs: readPositiveInteger(env, GLOBAL_LIMIT_VARIABLES.archiveJobs, errors),
		tempBytes: readPositiveInteger(env, GLOBAL_LIMIT_VARIABLES.tempBytes, errors),
	};

	// Numeric shape only. Inter-limit relationships (worker/stream/provider
	// ceilings versus account ceilings) belong to the phase that enforces them
	// (A33); a ceiling above the account count is a policy choice, not a
	// contradiction.


	// Legacy shared data is quarantined, never reused as an account-owned root.
	// Only containment is refused: a legacy path must not be, or live inside, a
	// designated root (that would let legacy record paths alias live account
	// data). A PARENT such as the documented /data volume is legitimate — the
	// legacy subdirectories are quarantined by the Phase 7 claim, not by shape.
	//
	// BOTH legacy shared paths are checked: LH_DATA_DIR holds records and
	// LH_AUTH_FILE holds provider credentials. A credential file inside the
	// account root would be readable by that account's identity.
	//
	// A RELATIVE path is refused rather than skipped: config.ts resolves it
	// against the process cwd, so "data" could land inside an account home
	// depending only on where the worker happens to start.
	for (const legacyVariable of ["LH_DATA_DIR", "LH_AUTH_FILE"] as const) {
		const raw = (env[legacyVariable] ?? "").trim();
		if (!raw) continue;
		if (!path.posix.isAbsolute(raw)) {
			errors.push(`${legacyVariable} must be an absolute path in multiuser-web; a relative path resolves against the process working directory.`);
			continue;
		}
		const legacy = canonicalLayoutPath(raw);
		for (const root of roots) {
			if (legacy === root.value || legacy.startsWith(`${root.value}/`)) {
				errors.push(`${legacyVariable} must not be inside ${LAYOUT_VARIABLES[root.key].name}; legacy shared data is quarantined, not reused as account data.`);
			}
		}
	}

	if (errors.length) return { ok: false, errors: dedupe(errors), warnings };

	const config: MultiuserConfig = {
		accountRoot: paths.accountRoot!,
		webIdentity: { uid: webIdentity.uid!, gid: webIdentity.gid! },
		uidRange: uid.range!,
		gidRange: gid.range!,
		registryDir: paths.registryDir!,
		instanceStateDir: paths.instanceStateDir!,
		stagingDir: paths.stagingDir!,
		snapshotDir: paths.snapshotDir!,
		privateWorkDir: paths.privateWorkDir!,
		controllerIpc: paths.controllerIpc!,
		helperIpc: paths.helperIpc!,
		clerk: { secretKey, publishableKey, authorizedParties },
		limits: { account: account as AccountLimits, global: global as GlobalLimits },
	};
	return { ok: true, config, warnings };
}

/**
 * The safe, structured summary a startup log may print. Contains no credential
 * material: only the presence and shape of the Clerk keys, never their values.
 */
export function redactedMultiuserSummary(config: MultiuserConfig): Record<string, unknown> {
	return {
		accountRoot: config.accountRoot,
		registryDir: config.registryDir,
		instanceStateDir: config.instanceStateDir,
		stagingDir: config.stagingDir,
		snapshotDir: config.snapshotDir,
		privateWorkDir: config.privateWorkDir,
		controllerIpc: config.controllerIpc,
		helperIpc: config.helperIpc,
		webIdentity: config.webIdentity,
		uidRange: config.uidRange,
		gidRange: config.gidRange,
		clerk: {
			secretKeyConfigured: Boolean(config.clerk.secretKey),
			publishableKeyConfigured: Boolean(config.clerk.publishableKey),
			trustedOriginCount: config.clerk.authorizedParties.length,
		},
		limits: config.limits,
	};
}
