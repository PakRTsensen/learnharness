/**
 * ACCOUNT PROVISIONING (per-user accounts, Phase 2, 2026-11-12).
 *
 * First-administrator bootstrap is one serialized registry transaction:
 * the whole account + bootstrap marker + UID/GID allocation commit in a
 * single atomic file replacement. The host secret is consumed only by that
 * successful commit; any failure before it leaves no account, no
 * administrator, and no allocated identity, so the host can retry.
 *
 * The secret itself is never persisted. Only the committed marker is, and
 * comparisons are constant-time over fixed-length digests.
 */

import fs from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import {
	AccountContractError,
	type AccountRecord,
	type AccountRegistry,
} from "../accounts/contracts.ts";
import {
	buildAccountRecord,
	createAccountHome,
	RegistryError,
	readAccountRegistry,
	withRegistryLock,
	writeAccountRegistry,
	type RegistryOptions,
} from "./registry.ts";

export type BootstrapSecretResult =
	| { ok: true; secret: string; source: "env" | "file" }
	| { ok: false; code: "bootstrap_secret_unavailable" | "bootstrap_secret_invalid"; message: string };

export type BootstrapFailureCode =
	| "bootstrap_already_consumed"
	| "bootstrap_secret_unavailable"
	| "bootstrap_secret_invalid"
	| "registry_inconsistent"
	| "registry_unavailable"
	| "subject_invalid"
	| "account_root_missing"
	| "registry_write_failed";

export type BootstrapResult =
	| { ok: true; account: AccountRecord; registry: AccountRegistry }
	| { ok: false; code: BootstrapFailureCode; message: string };

function validSecretShape(secret: string): boolean {
	return secret.length >= 32 && secret.length <= 512;
}

/** Read the host-issued bootstrap secret at request/startup time. The
 *  environment wins over the file so a container can override a mounted
 *  secret; neither value is ever logged. */
export function readBootstrapSecret(env: Record<string, string | undefined> = process.env): BootstrapSecretResult {
	const fromEnv = env.LH_BOOTSTRAP_SECRET;
	if (fromEnv !== undefined) {
		const secret = fromEnv.trim();
		return validSecretShape(secret)
			? { ok: true, secret, source: "env" }
			: { ok: false, code: "bootstrap_secret_invalid", message: "LH_BOOTSTRAP_SECRET must be 32-512 characters." };
	}
	const file = env.LH_BOOTSTRAP_SECRET_FILE?.trim();
	if (!file) {
		return {
			ok: false,
			code: "bootstrap_secret_unavailable",
			message: "The host has not supplied a bootstrap secret.",
		};
	}
	let raw: string;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > 4096) throw new Error("not a small regular file");
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return {
			ok: false,
			code: "bootstrap_secret_unavailable",
			message: "The host bootstrap-secret file is unavailable.",
		};
	}
	const secret = raw.trim();
	return validSecretShape(secret)
		? { ok: true, secret, source: "file" }
		: { ok: false, code: "bootstrap_secret_invalid", message: "The bootstrap-secret file must contain 32-512 characters." };
}

function digest(secret: string): Buffer {
	return createHash("sha256").update(secret, "utf8").digest();
}

/** Constant-time comparison over fixed-length digests. */
export function bootstrapSecretMatches(configured: string, provided: string): boolean {
	const a = digest(configured);
	const b = digest(provided);
	return timingSafeEqual(a, b);
}

/**
 * Commit the first administrator. Public registration and legacy claim stay
 * closed until this returns ok; concurrent attempts serialize on the one
 * registry lock, so exactly one can commit.
 */
export function bootstrapFirstAdministrator(
	options: RegistryOptions,
	input: { subject: string; providedSecret: string; configuredSecret: string | undefined },
): BootstrapResult {
	if (!validSecretShape(input.providedSecret)) {
		return { ok: false, code: "bootstrap_secret_invalid", message: "The bootstrap secret is invalid." };
	}
	try {
		return withRegistryLock(options, () => {
			const registry = readAccountRegistry(options.controllerStateDir);
			if (registry.bootstrap) {
				return { ok: false, code: "bootstrap_already_consumed", message: "The first administrator has already been committed." };
			}
			if (registry.accounts.length > 0 || registry.retired.length > 0) {
				return { ok: false, code: "registry_inconsistent", message: "Account state exists without a committed bootstrap." };
			}
			if (!input.configuredSecret) {
				return { ok: false, code: "bootstrap_secret_unavailable", message: "The host has not supplied a bootstrap secret." };
			}
			if (!bootstrapSecretMatches(input.configuredSecret, input.providedSecret)) {
				return { ok: false, code: "bootstrap_secret_invalid", message: "The bootstrap secret is invalid." };
			}

			const now = options.now ? options.now() : new Date();
			const account = buildAccountRecord(registry, options, input.subject, "administrator", now);
			const home = createAccountHome(options, account);
			const next: AccountRegistry = {
				...registry,
				bootstrap: {
					consumedAt: now.toISOString(),
					administratorAccountId: account.id,
					clerkSubject: account.clerkSubject,
					legacyClaimEligible: true,
				},
				accounts: [account],
			};
			try {
				writeAccountRegistry(options.controllerStateDir, next);
			} catch (error) {
				// The registry write did not commit: burn the empty home, leave the
				// secret unconsumed, and report the failure so the host can retry.
				try { fs.rmdirSync(home); } catch { /* non-empty or gone */ }
				const message = error instanceof Error ? error.message : "The account registry could not be committed.";
				return { ok: false, code: "registry_write_failed", message };
			}
			return { ok: true, account, registry: next };
		});
	} catch (error) {
		if (error instanceof RegistryError) {
			const code: BootstrapFailureCode =
				error.code === "subject_invalid" ? "subject_invalid" :
				error.code === "account_root_missing" ? "account_root_missing" :
				error.code === "registry_unavailable" ? "registry_unavailable" :
				"registry_write_failed";
			return { ok: false, code, message: error.message };
		}
		if (error instanceof AccountContractError) {
			return { ok: false, code: "registry_inconsistent", message: error.message };
		}
		return { ok: false, code: "registry_write_failed", message: "The bootstrap transaction failed." };
	}
}

/** True while the first-admin transaction has not committed. */
export function bootstrapRequired(controllerStateDir: string): boolean {
	return readAccountRegistry(controllerStateDir).bootstrap === null;
}
