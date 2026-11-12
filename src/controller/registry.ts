/**
 * ACCOUNT REGISTRY (per-user accounts, Phase 2, 2026-11-12).
 *
 * THE SOLE WRITER of src/accounts/contracts.ts's registry document. Every
 * mutation runs under one serialized lock, validates the complete resulting
 * document, and replaces it atomically. UID/GID allocation is derived from
 * the configured range and the permanent non-reuse ledger.
 *
 * Security invariants enforced here:
 *   - an account home is derived from the random internal id, never a subject;
 *   - a new home is created before commit and is removed only when empty;
 *   - allocation is committed together with the account record;
 *   - retired identities are never reused;
 *   - exactly one administrator (and one legacy-claim holder) can exist.
 *
 * Phase 3 moves home creation to the root helper; this module keeps the
 * registry transaction semantics it will delegate to.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
	ACCOUNT_ID_PATTERN,
	ACCOUNT_SUBJECT_PATTERN,
	AccountContractError,
	emptyRegistry,
	parseAccountRegistry,
	type AccountRecord,
	type AccountRegistry,
	type AccountRole,
	type RetiredIdentity,
} from "../accounts/contracts.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { StateLockError, withStateLock } from "./state-lock.ts";
import type { IdentityRange, MultiuserConfig } from "../runtime/multiuser-config.ts";

const REGISTRY_FILE = "registry.json";
const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RegistryOptions {
	controllerStateDir: string;
	accountRoot: string;
	uidRange: IdentityRange;
	gidRange: IdentityRange;
	/** Test seam; production uses the default five-second wait. */
	lockTimeoutMs?: number;
	now?: () => Date;
}

export type RegistryErrorCode =
	| "registry_unavailable"
	| "registry_invalid"
	| "registry_busy"
	| "registry_version_unsupported"
	| "account_root_missing"
	| "account_home_exists"
	| "account_home_invalid"
	| "identity_range_exhausted"
	| "identity_range_invalid"
	| "account_id_exhausted"
	| "subject_invalid"
	| "account_not_found"
	| "account_not_active"
	| "account_disabled"
	| "account_exists"
	| "bootstrap_required"
	| "administrator_required"
	| "administrator_exists"
	| "target_is_administrator"
	| "transfer_admin_required"
	| "deletion_window_expired"
	| "deletion_not_due";

export class RegistryError extends Error {
	readonly code: RegistryErrorCode;

	constructor(code: RegistryErrorCode, message: string) {
		super(message);
		this.name = "RegistryError";
		this.code = code;
	}
}

export function registryFile(controllerStateDir: string): string {
	return path.join(controllerStateDir, REGISTRY_FILE);
}

export function readAccountRegistry(controllerStateDir: string): AccountRegistry {
	const file = registryFile(controllerStateDir);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
		throw new RegistryError("registry_unavailable", "The account registry cannot be read.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new RegistryError("registry_invalid", "The account registry is not valid JSON.");
	}
	try {
		return parseAccountRegistry(parsed);
	} catch (error) {
		if (error instanceof AccountContractError) {
			throw new RegistryError(
				error.code === "registry_version_unsupported" ? "registry_version_unsupported" : "registry_invalid",
				error.message,
			);
		}
		throw error;
	}
}

/** Validate the complete document before replacing the file. */
export function writeAccountRegistry(controllerStateDir: string, registry: AccountRegistry): void {
	let next: AccountRegistry;
	try {
		next = parseAccountRegistry(registry);
	} catch (error) {
		if (error instanceof AccountContractError) {
			throw new RegistryError(
				error.code === "registry_version_unsupported" ? "registry_version_unsupported" : "registry_invalid",
				error.message,
			);
		}
		throw error;
	}
	fs.mkdirSync(controllerStateDir, { recursive: true, mode: 0o700 });
	writeFileAtomicSync(registryFile(controllerStateDir), `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
}

export function withRegistryLock<T>(options: RegistryOptions, fn: () => T): T {
	try {
		return withStateLock(options.controllerStateDir, "registry.lock", fn, { timeoutMs: options.lockTimeoutMs });
	} catch (error) {
		if (error instanceof StateLockError) {
			throw new RegistryError(
				error.code === "state_locked" ? "registry_busy" : "registry_unavailable",
				error.message,
			);
		}
		throw error;
	}
}

export function findAccountBySubject(registry: AccountRegistry, subject: string): AccountRecord | undefined {
	return registry.accounts.find((account) => account.clerkSubject === subject);
}

export function findAccountById(registry: AccountRegistry, accountId: string): AccountRecord | undefined {
	return registry.accounts.find((account) => account.id === accountId);
}

function requireAccount(registry: AccountRegistry, subject: string): AccountRecord {
	const account = findAccountBySubject(registry, subject);
	if (!account) throw new RegistryError("account_not_found", "No local account exists for this identity.");
	return account;
}

function nowOf(options: RegistryOptions): Date {
	return options.now ? options.now() : new Date();
}

function iso(date: Date): string {
	return date.toISOString();
}

function assertRange(range: IdentityRange, label: string): void {
	if (
		!Number.isSafeInteger(range.start) ||
		!Number.isSafeInteger(range.end) ||
		range.start < 1000 ||
		range.end < range.start ||
		range.end - range.start > 100_000
	) {
		throw new RegistryError("identity_range_invalid", `${label} is invalid.`);
	}
}

/** First free UID and GID in their configured ranges, excluding the permanent
 *  retirement ledger. Allocation is not persisted until the account commits. */
export function allocateIdentity(
	registry: AccountRegistry,
	uidRange: IdentityRange,
	gidRange: IdentityRange,
): { uid: number; gid: number } {
	assertRange(uidRange, "UID range");
	assertRange(gidRange, "GID range");
	const usedUids = new Set<number>([
		...registry.accounts.map((account) => account.uid),
		...registry.retired.map((identity) => identity.uid),
	]);
	const usedGids = new Set<number>([
		...registry.accounts.map((account) => account.gid),
		...registry.retired.map((identity) => identity.gid),
	]);
	let uid: number | undefined;
	for (let candidate = uidRange.start; candidate <= uidRange.end; candidate += 1) {
		if (!usedUids.has(candidate)) { uid = candidate; break; }
	}
	let gid: number | undefined;
	for (let candidate = gidRange.start; candidate <= gidRange.end; candidate += 1) {
		if (!usedGids.has(candidate)) { gid = candidate; break; }
	}
	if (uid === undefined || gid === undefined) {
		throw new RegistryError("identity_range_exhausted", "No unallocated Linux identity remains in the configured range.");
	}
	return { uid, gid };
}

export function accountHomePath(accountRoot: string, accountId: string): string {
	if (!ACCOUNT_ID_PATTERN.test(accountId)) {
		throw new RegistryError("subject_invalid", "Refusing to derive a path from an invalid account id.");
	}
	return path.join(accountRoot, accountId);
}

/** Build the record only; the caller commits it in the same registry write as
 *  any related state (for example the bootstrap marker). */
export function buildAccountRecord(
	registry: AccountRegistry,
	options: RegistryOptions,
	subject: string,
	role: AccountRole,
	now: Date,
): AccountRecord {
	if (!ACCOUNT_SUBJECT_PATTERN.test(subject)) {
		throw new RegistryError("subject_invalid", "The authenticated subject has an unsupported shape.");
	}
	if (findAccountBySubject(registry, subject)) {
		throw new RegistryError("account_exists", "An account already exists for this identity.");
	}
	const { uid, gid } = allocateIdentity(registry, options.uidRange, options.gidRange);
	let id: string | undefined;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const candidate = `acct_${randomBytes(16).toString("hex")}`;
		if (!registry.accounts.some((account) => account.id === candidate)) {
			id = candidate;
			break;
		}
	}
	if (!id) throw new RegistryError("account_id_exhausted", "Could not allocate an internal account id.");
	const timestamp = iso(now);
	return {
		id,
		clerkSubject: subject,
		role,
		lifecycle: "active",
		uid,
		gid,
		home: id,
		generation: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		legacyClaimEligible: role === "administrator",
	};
}

/** Create the top-level home with private permissions. Phase 3 delegates this
 *  step to the root helper; the directory is never created recursively so a
 *  missing account root is an operational error, not a silent new mount. */
export function createAccountHome(options: RegistryOptions, account: AccountRecord): string {
	const home = accountHomePath(options.accountRoot, account.id);
	try {
		fs.mkdirSync(home, { mode: 0o700 });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") throw new RegistryError("account_home_exists", "The account home already exists.");
		if (code === "ENOENT") throw new RegistryError("account_root_missing", "The configured account root does not exist.");
		throw new RegistryError("registry_unavailable", "The account home cannot be created.");
	}
	try {
		const stat = fs.lstatSync(home);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new RegistryError("account_home_invalid", "The account home is not a real directory.");
		}
	} catch (error) {
		if (error instanceof RegistryError) {
			try { fs.rmdirSync(home); } catch { /* leave it for the operator */ }
			throw error;
		}
		throw new RegistryError("account_home_invalid", "The account home cannot be verified.");
	}
	return home;
}

function removeEmptyHome(home: string): void {
	try { fs.rmdirSync(home); } catch { /* non-empty or already gone: never delete data */ }
}

function withoutLifecycleDates(account: AccountRecord): AccountRecord {
	const { disabledAt: _disabledAt, deletionScheduledFor: _deletionScheduledFor, ...rest } = account;
	return rest;
}

/**
 * Registration after bootstrap: idempotent creation of the caller's normal
 * account. Before bootstrap this refuses, so public registration stays closed.
 */
export function ensureAccount(options: RegistryOptions, subject: string): AccountRecord {
	return withRegistryLock(options, () => {
		const registry = readAccountRegistry(options.controllerStateDir);
		const existing = findAccountBySubject(registry, subject);
		if (existing) {
			if (existing.lifecycle !== "active") {
				throw new RegistryError("account_not_active", "This account is disabled or awaiting deletion.");
			}
			return existing;
		}
		if (!registry.bootstrap) {
			throw new RegistryError("bootstrap_required", "The first administrator bootstrap has not completed.");
		}
		const account = buildAccountRecord(registry, options, subject, "user", nowOf(options));
		const home = createAccountHome(options, account);
		try {
			writeAccountRegistry(options.controllerStateDir, { ...registry, accounts: [...registry.accounts, account] });
		} catch (error) {
			removeEmptyHome(home);
			throw error;
		}
		return account;
	});
}

/** External Clerk deletion starts disablement only; it never erases data. */
export function disableAccountBySubject(options: RegistryOptions, subject: string): AccountRecord | null {
	return withRegistryLock(options, () => {
		const registry = readAccountRegistry(options.controllerStateDir);
		const account = findAccountBySubject(registry, subject);
		if (!account) return null;
		if (account.lifecycle !== "active") return account;
		const now = nowOf(options);
		const next: AccountRecord = {
			...account,
			lifecycle: "disabled",
			disabledAt: iso(now),
			updatedAt: iso(now),
			generation: account.generation + 1,
		};
		writeAccountRegistry(options.controllerStateDir, {
			...registry,
			accounts: registry.accounts.map((entry) => (entry.id === next.id ? next : entry)),
		});
		return next;
	});
}

/** User-confirmed deletion: disable now, retain recovery data for seven days. */
export function scheduleAccountDeletion(options: RegistryOptions, subject: string): AccountRecord {
	return withRegistryLock(options, () => {
		const registry = readAccountRegistry(options.controllerStateDir);
		const account = requireAccount(registry, subject);
		if (account.lifecycle === "pending-deletion") return account;
		if (account.lifecycle !== "active") {
			throw new RegistryError("account_disabled", "This account is already disabled.");
		}
		if (account.role === "administrator") {
			throw new RegistryError("transfer_admin_required", "Transfer the administrator role before deleting this account.");
		}
		const now = nowOf(options);
		const next: AccountRecord = {
			...account,
			lifecycle: "pending-deletion",
			disabledAt: account.disabledAt ?? iso(now),
			deletionScheduledFor: iso(new Date(now.getTime() + DELETION_GRACE_MS)),
			updatedAt: iso(now),
			generation: account.generation + 1,
		};
		writeAccountRegistry(options.controllerStateDir, {
			...registry,
			accounts: registry.accounts.map((entry) => (entry.id === next.id ? next : entry)),
		});
		return next;
	});
}

/** Recover a user-requested deletion inside the seven-day window. */
export function recoverAccount(options: RegistryOptions, subject: string): AccountRecord {
	return withRegistryLock(options, () => {
		const registry = readAccountRegistry(options.controllerStateDir);
		const account = requireAccount(registry, subject);
		if (account.lifecycle === "active") return account;
		if (account.lifecycle === "disabled") {
			throw new RegistryError("account_disabled", "This account was disabled by its identity provider and needs host recovery.");
		}
		const now = nowOf(options);
		if (!account.deletionScheduledFor || now.getTime() >= Date.parse(account.deletionScheduledFor)) {
			throw new RegistryError("deletion_window_expired", "The seven-day recovery window has expired.");
		}
		const next: AccountRecord = {
			...withoutLifecycleDates(account),
			lifecycle: "active",
			updatedAt: iso(now),
			generation: account.generation + 1,
		};
		writeAccountRegistry(options.controllerStateDir, {
			...registry,
			accounts: registry.accounts.map((entry) => (entry.id === next.id ? next : entry)),
		});
		return next;
	});
}

/**
 * Retire an account after its recovery window. Phase 2 removes the registry
 * record and permanently burns the identity; physical content deletion is the
 * Phase 3 helper's non-content cleanup operation, so no data path is touched
 * from the web process.
 */
export function eraseAccountById(options: RegistryOptions, accountId: string): RetiredIdentity {
	return withRegistryLock(options, () => {
		const registry = readAccountRegistry(options.controllerStateDir);
		const account = findAccountById(registry, accountId);
		if (!account) throw new RegistryError("account_not_found", "No account has this id.");
		if (account.lifecycle !== "pending-deletion" || !account.deletionScheduledFor) {
			throw new RegistryError("deletion_not_due", "This account is not awaiting deletion.");
		}
		const now = nowOf(options);
		if (now.getTime() < Date.parse(account.deletionScheduledFor)) {
			throw new RegistryError("deletion_not_due", "The seven-day recovery window has not ended.");
		}
		const retired: RetiredIdentity = { uid: account.uid, gid: account.gid, retiredAt: iso(now) };
		writeAccountRegistry(options.controllerStateDir, {
			...registry,
			accounts: registry.accounts.filter((entry) => entry.id !== account.id),
			retired: [...registry.retired, retired],
		});
		return retired;
	});
}

/** Move the administrator role between two existing active accounts. */
export function transferAdministrator(
	options: RegistryOptions,
	actorSubject: string,
	targetAccountId: string,
): AccountRecord {
	return withRegistryLock(options, () => {
		const registry = readAccountRegistry(options.controllerStateDir);
		const actor = requireAccount(registry, actorSubject);
		if (actor.role !== "administrator" || actor.lifecycle !== "active") {
			throw new RegistryError("administrator_required", "Only the active administrator can transfer the role.");
		}
		const target = findAccountById(registry, targetAccountId);
		if (!target) throw new RegistryError("account_not_found", "No account has this id.");
		if (target.id === actor.id) throw new RegistryError("target_is_administrator", "Choose another account.");
		if (target.lifecycle !== "active") {
			throw new RegistryError("account_not_active", "The target account must be active.");
		}
		const now = nowOf(options);
		const nextActor: AccountRecord = {
			...actor,
			role: "user",
			legacyClaimEligible: false,
			updatedAt: iso(now),
			generation: actor.generation + 1,
		};
		const nextTarget: AccountRecord = {
			...target,
			role: "administrator",
			legacyClaimEligible: true,
			updatedAt: iso(now),
			generation: target.generation + 1,
		};
		writeAccountRegistry(options.controllerStateDir, {
			...registry,
			accounts: registry.accounts.map((entry) => {
				if (entry.id === nextActor.id) return nextActor;
				if (entry.id === nextTarget.id) return nextTarget;
				return entry;
			}),
		});
		return nextTarget;
	});
}

/**
 * Host-authorized recovery appointment. This is the trusted-host path used
 * when the sole administrator is disabled/deleted; it adds no private-content
 * API and can create the replacement account when no other account exists.
 */
export function appointAdministratorByHost(options: RegistryOptions, subject: string): AccountRecord {
	return withRegistryLock(options, () => {
		const registry = readAccountRegistry(options.controllerStateDir);
		if (!registry.bootstrap) {
			throw new RegistryError("bootstrap_required", "The first administrator bootstrap has not completed.");
		}
		const current = registry.accounts.find((account) => account.role === "administrator");
		const existing = findAccountBySubject(registry, subject);
		if (existing && existing.lifecycle !== "active") {
			throw new RegistryError("account_not_active", "The replacement account must be active.");
		}
		if (existing && existing.role === "administrator") return existing;

		const now = nowOf(options);
		const created = existing ? undefined : buildAccountRecord(registry, options, subject, "administrator", now);
		const home = created ? createAccountHome(options, created) : undefined;
		const nextTarget: AccountRecord = {
			...(existing ?? created!),
			role: "administrator",
			legacyClaimEligible: true,
			updatedAt: iso(now),
			generation: (existing ?? created!).generation + 1,
		};
		const accounts = registry.accounts
			.filter((account) => account.id !== current?.id)
			.map((account) => (account.id === nextTarget.id ? nextTarget : account));
		if (created && !accounts.some((account) => account.id === nextTarget.id)) accounts.push(nextTarget);
		if (current && current.id !== nextTarget.id) {
			accounts.push({
				...current,
				role: "user",
				legacyClaimEligible: false,
				updatedAt: iso(now),
				generation: current.generation + 1,
			});
			// Preserve stable ordering for deterministic tests.
			accounts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
		}
		try {
			writeAccountRegistry(options.controllerStateDir, { ...registry, accounts });
		} catch (error) {
			if (home) removeEmptyHome(home);
			throw error;
		}
		return nextTarget;
	});
}

/** Build the registry transaction options from validated runtime config. */
export function registryOptionsFromConfig(config: MultiuserConfig): RegistryOptions {
	return {
		controllerStateDir: config.paths.controllerStateDir,
		accountRoot: config.paths.accountRoot,
		uidRange: config.uidRange,
		gidRange: config.gidRange,
	};
}
