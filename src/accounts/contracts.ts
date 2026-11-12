/**
 * ACCOUNT CONTRACTS (per-user accounts, Phase 2, 2026-11-12).
 *
 * The registry maps immutable authentication subjects to random internal
 * account IDs and allocated Linux UID/GID values. It never stores email
 * addresses, display names, or filesystem paths supplied by a caller.
 *
 * Validation is strict and fail-closed: a corrupt registry, an unsupported
 * future version, duplicate identities, or more than one administrator is an
 * operational error, never a reason to silently reset local privileged state.
 */

import { createHash } from "node:crypto";

export const REGISTRY_VERSION = 1 as const;

/** Internal account IDs are random and never derived from a subject. */
export const ACCOUNT_ID_PATTERN = /^acct_[a-f0-9]{32}$/;
/** Clerk `user_*` subjects or the offline-simulation `local_*` subjects. */
export const ACCOUNT_SUBJECT_PATTERN = /^(?:user_|local_)[A-Za-z0-9_-]{1,120}$/;
export const LOCAL_SUBJECT_PREFIX = "local_";

export type AccountRole = "administrator" | "user";
export type AccountLifecycle = "active" | "disabled" | "pending-deletion";

export interface BootstrapRecord {
	consumedAt: string;
	administratorAccountId: string;
	clerkSubject: string;
	legacyClaimEligible: true;
}

export interface RetiredIdentity {
	uid: number;
	gid: number;
	retiredAt: string;
}

export interface AccountRecord {
	id: string;
	clerkSubject: string;
	role: AccountRole;
	lifecycle: AccountLifecycle;
	uid: number;
	gid: number;
	/** Basename under the account root. Always equal to `id`. */
	home: string;
	/** Fencing counter; increments on every lifecycle/role change. */
	generation: number;
	createdAt: string;
	updatedAt: string;
	disabledAt?: string;
	deletionScheduledFor?: string;
	legacyClaimEligible: boolean;
}

export interface AccountRegistry {
	version: typeof REGISTRY_VERSION;
	bootstrap: BootstrapRecord | null;
	accounts: AccountRecord[];
	/** Permanently retired identities; UID/GID values are never reused. */
	retired: RetiredIdentity[];
}

export class AccountContractError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AccountContractError";
		this.code = code;
	}
}

function fail(code: string, message: string): never {
	throw new AccountContractError(code, message);
}

function recordValue(value: unknown, code: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "Expected a JSON object.");
	return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, code: string, max = 512): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0 || value.length > max) fail(code, `${key} must be a non-empty string.`);
	return value;
}

function optionalString(record: Record<string, unknown>, key: string, code: string, max = 512): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > max) fail(code, `${key} must be a non-empty string when present.`);
	return value;
}

function integer(record: Record<string, unknown>, key: string, code: string, min = 1): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) fail(code, `${key} must be an integer >= ${min}.`);
	return value;
}

function isoDate(record: Record<string, unknown>, key: string, code: string): string {
	const value = requiredString(record, key, code, 64);
	if (Number.isNaN(Date.parse(value))) fail(code, `${key} must be an ISO timestamp.`);
	return value;
}

function optionalIsoDate(record: Record<string, unknown>, key: string, code: string): string | undefined {
	const value = optionalString(record, key, code, 64);
	if (value !== undefined && Number.isNaN(Date.parse(value))) fail(code, `${key} must be an ISO timestamp.`);
	return value;
}

function booleanField(record: Record<string, unknown>, key: string, code: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") fail(code, `${key} must be a boolean.`);
	return value;
}

export function emptyRegistry(): AccountRegistry {
	return { version: REGISTRY_VERSION, bootstrap: null, accounts: [], retired: [] };
}

function parseAccount(value: unknown, index: number): AccountRecord {
	const code = `account_invalid_${index}`;
	const record = recordValue(value, code);
	const id = requiredString(record, "id", code, 64);
	if (!ACCOUNT_ID_PATTERN.test(id)) fail(code, "Account id has an invalid shape.");
	const clerkSubject = requiredString(record, "clerkSubject", code, 128);
	if (!ACCOUNT_SUBJECT_PATTERN.test(clerkSubject)) fail(code, "Account subject has an invalid shape.");
	const role = requiredString(record, "role", code, 32);
	if (role !== "administrator" && role !== "user") fail(code, "Account role is invalid.");
	const lifecycle = requiredString(record, "lifecycle", code, 32);
	if (lifecycle !== "active" && lifecycle !== "disabled" && lifecycle !== "pending-deletion") {
		fail(code, "Account lifecycle is invalid.");
	}
	const home = requiredString(record, "home", code, 64);
	if (home !== id) fail(code, "Account home must be the internal account id.");
	const uid = integer(record, "uid", code, 1000);
	const gid = integer(record, "gid", code, 1000);
	const generation = integer(record, "generation", code, 1);
	const createdAt = isoDate(record, "createdAt", code);
	const updatedAt = isoDate(record, "updatedAt", code);
	const disabledAt = optionalIsoDate(record, "disabledAt", code);
	const deletionScheduledFor = optionalIsoDate(record, "deletionScheduledFor", code);
	if (lifecycle === "pending-deletion" && !deletionScheduledFor) {
		fail(code, "A pending-deletion account requires deletionScheduledFor.");
	}
	if (lifecycle !== "pending-deletion" && deletionScheduledFor) {
		fail(code, "deletionScheduledFor is only valid for a pending-deletion account.");
	}
	return {
		id,
		clerkSubject,
		role,
		lifecycle,
		uid,
		gid,
		home,
		generation,
		createdAt,
		updatedAt,
		...(disabledAt ? { disabledAt } : {}),
		...(deletionScheduledFor ? { deletionScheduledFor } : {}),
		legacyClaimEligible: booleanField(record, "legacyClaimEligible", code),
	};
}

function parseBootstrap(value: unknown): BootstrapRecord | null {
	if (value === null || value === undefined) return null;
	const code = "registry_bootstrap_invalid";
	const record = recordValue(value, code);
	const consumedAt = isoDate(record, "consumedAt", code);
	const administratorAccountId = requiredString(record, "administratorAccountId", code, 64);
	const clerkSubject = requiredString(record, "clerkSubject", code, 128);
	if (!ACCOUNT_ID_PATTERN.test(administratorAccountId)) fail(code, "Bootstrap administrator id is invalid.");
	if (!ACCOUNT_SUBJECT_PATTERN.test(clerkSubject)) fail(code, "Bootstrap subject is invalid.");
	if (booleanField(record, "legacyClaimEligible", code) !== true) {
		fail(code, "Bootstrap must record legacy claim eligibility.");
	}
	return { consumedAt, administratorAccountId, clerkSubject, legacyClaimEligible: true };
}

function parseRetired(value: unknown, index: number): RetiredIdentity {
	const code = `registry_retired_invalid_${index}`;
	const record = recordValue(value, code);
	return {
		uid: integer(record, "uid", code, 1000),
		gid: integer(record, "gid", code, 1000),
		retiredAt: isoDate(record, "retiredAt", code),
	};
}

/**
 * Strictly validate and normalize a registry document. Unknown fields are
 * dropped by the normalized result, which is intentional for controller-owned
 * state with an explicit version gate.
 */
export function parseAccountRegistry(value: unknown): AccountRegistry {
	const root = recordValue(value, "registry_invalid");
	const version = root.version;
	if (version !== REGISTRY_VERSION) {
		if (typeof version === "number" && version > REGISTRY_VERSION) {
			fail("registry_version_unsupported", "The account registry was written by a newer LearnHarness version.");
		}
		fail("registry_version_invalid", "The account registry version is missing or invalid.");
	}

	const accountsRaw = root.accounts;
	if (!Array.isArray(accountsRaw)) fail("registry_accounts_invalid", "accounts must be an array.");
	const accounts = accountsRaw.map(parseAccount);

	const retiredRaw = root.retired;
	if (!Array.isArray(retiredRaw)) fail("registry_retired_invalid", "retired must be an array.");
	const retired = retiredRaw.map(parseRetired);

	const bootstrap = parseBootstrap(root.bootstrap);

	const ids = new Set<string>();
	const subjects = new Set<string>();
	const uids = new Set<number>();
	const gids = new Set<number>();
	for (const account of accounts) {
		if (ids.has(account.id)) fail("registry_duplicate_account", "Duplicate account id.");
		if (subjects.has(account.clerkSubject)) fail("registry_duplicate_subject", "Duplicate account subject.");
		if (uids.has(account.uid)) fail("registry_duplicate_uid", "Duplicate account UID.");
		if (gids.has(account.gid)) fail("registry_duplicate_gid", "Duplicate account GID.");
		ids.add(account.id);
		subjects.add(account.clerkSubject);
		uids.add(account.uid);
		gids.add(account.gid);
	}

	for (const identity of retired) {
		if (uids.has(identity.uid)) fail("registry_reused_uid", "A retired UID is still in use.");
		if (gids.has(identity.gid)) fail("registry_reused_gid", "A retired GID is still in use.");
		uids.add(identity.uid);
		gids.add(identity.gid);
	}

	const administrators = accounts.filter((account) => account.role === "administrator");
	if (bootstrap === null) {
		if (accounts.length > 0 || retired.length > 0) {
			fail("registry_bootstrap_missing", "Accounts exist without a committed bootstrap transaction.");
		}
	} else {
		const bootstrapAdmin = accounts.find((account) => account.id === bootstrap.administratorAccountId);
		if (!bootstrapAdmin) fail("registry_bootstrap_admin_missing", "The bootstrap administrator record is missing.");
		if (bootstrapAdmin.clerkSubject !== bootstrap.clerkSubject) {
			fail("registry_bootstrap_subject_mismatch", "The bootstrap subject does not match its administrator.");
		}
		if (administrators.length !== 1) {
			fail("registry_administrator_count", "Exactly one administrator account is required.");
		}
		const legacy = accounts.filter((account) => account.legacyClaimEligible);
		if (legacy.length !== 1 || legacy[0]?.role !== "administrator") {
			fail("registry_legacy_claim_invalid", "Exactly one administrator must hold legacy-claim eligibility.");
		}
	}

	return {
		version: REGISTRY_VERSION,
		bootstrap,
		accounts,
		retired,
	};
}

export interface PublicAccount {
	accountId: string;
	role: AccountRole;
	lifecycle: AccountLifecycle;
	createdAt: string;
	deletionScheduledFor?: string;
	legacyClaimEligible: boolean;
}

/** The only account shape a browser receives: no subject, UID/GID, or home. */
export function toPublicAccount(account: AccountRecord): PublicAccount {
	return {
		accountId: account.id,
		role: account.role,
		lifecycle: account.lifecycle,
		createdAt: account.createdAt,
		...(account.deletionScheduledFor ? { deletionScheduledFor: account.deletionScheduledFor } : {}),
		legacyClaimEligible: account.legacyClaimEligible,
	};
}

export function isValidLocalEmail(email: string): boolean {
	const trimmed = email.trim();
	return trimmed.length > 3 && trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Offline identity subject: a deterministic hash of the normalized email so
 * the registry never stores an email address or a caller-controlled path
 * fragment. The same email maps to the same simulated account.
 */
export function localSubjectForEmail(email: string): string {
	const normalized = email.trim().toLowerCase();
	return `${LOCAL_SUBJECT_PREFIX}${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}
