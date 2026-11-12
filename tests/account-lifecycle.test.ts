/**
 * ACCOUNT LIFECYCLE (per-user accounts, Phase 2).
 *
 * Disablement, seven-day recovery, permanent identity retirement, sole-admin
 * transfer, and host recovery. No test reads private content: these are
 * registry/lifecycle guarantees only.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	appointAdministratorByHost,
	disableAccountBySubject,
	ensureAccount,
	eraseAccountById,
	findAccountBySubject,
	readAccountRegistry,
	recoverAccount,
	scheduleAccountDeletion,
	transferAdministrator,
	RegistryError,
	type RegistryOptions,
} from "../src/controller/registry.ts";
import { bootstrapFirstAdministrator } from "../src/controller/provisioning.ts";

const SECRET = "b".repeat(48);

interface Fixture {
	root: string;
	opts: RegistryOptions;
	adminId: string;
	userId: string;
	setClock: (date: Date) => void;
	cleanup: () => void;
}

function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lifecycle-"));
	const accountRoot = path.join(root, "accounts");
	fs.mkdirSync(accountRoot, { mode: 0o700 });
	let clock = new Date("2026-11-12T00:00:00.000Z");
	const opts: RegistryOptions = {
		controllerStateDir: path.join(root, "controller"),
		accountRoot,
		uidRange: { start: 70000, end: 70010 },
		gidRange: { start: 80000, end: 80010 },
		now: () => clock,
	};
	const boot = bootstrapFirstAdministrator(opts, {
		subject: "local_admin",
		providedSecret: SECRET,
		configuredSecret: SECRET,
	});
	if (!boot.ok) throw new Error(boot.code);
	const user = ensureAccount(opts, "local_user");
	return {
		root,
		opts,
		adminId: boot.account.id,
		userId: user.id,
		setClock: (date) => { clock = date; },
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

describe("account lifecycle", () => {
	it("disables an account immediately and keeps webhook disablement idempotent", () => {
		const f = fixture();
		try {
			const before = findAccountBySubject(readAccountRegistry(f.opts.controllerStateDir), "local_user");
			assert.ok(before);
			const disabled = disableAccountBySubject(f.opts, "local_user");
			assert.equal(disabled?.lifecycle, "disabled");
			assert.equal(disabled?.generation, before.generation + 1);
			assert.equal(disabled?.role, "user");
			assert.equal(disableAccountBySubject(f.opts, "local_user")?.generation, disabled?.generation);
			assert.equal(disableAccountBySubject(f.opts, "local_absent"), null);
			assert.throws(
				() => recoverAccount(f.opts, "local_user"),
				(error: unknown) => error instanceof RegistryError && error.code === "account_disabled",
			);
		} finally {
			f.cleanup();
		}
	});

	it("blocks sole-administrator deletion until the role is transferred", () => {
		const f = fixture();
		try {
			assert.throws(
				() => scheduleAccountDeletion(f.opts, "local_admin"),
				(error: unknown) => error instanceof RegistryError && error.code === "transfer_admin_required",
			);
			const transferred = transferAdministrator(f.opts, "local_admin", f.userId);
			assert.equal(transferred.role, "administrator");
			const after = readAccountRegistry(f.opts.controllerStateDir);
			assert.equal(after.accounts.filter((account) => account.role === "administrator").length, 1);
			assert.equal(findAccountBySubject(after, "local_admin")?.role, "user");
			const scheduled = scheduleAccountDeletion(f.opts, "local_admin");
			assert.equal(scheduled.lifecycle, "pending-deletion");
			assert.equal(scheduled.deletionScheduledFor, "2026-11-19T00:00:00.000Z");
		} finally {
			f.cleanup();
		}
	});

	it("recovers inside the seven-day window and refuses after it", () => {
		const f = fixture();
		try {
			f.setClock(new Date("2026-11-12T00:00:00.000Z"));
			const scheduled = scheduleAccountDeletion(f.opts, "local_user");
			assert.equal(scheduled.lifecycle, "pending-deletion");
			f.setClock(new Date("2026-11-18T23:59:59.000Z"));
			const recovered = recoverAccount(f.opts, "local_user");
			assert.equal(recovered.lifecycle, "active");
			assert.equal(recovered.deletionScheduledFor, undefined);
			assert.equal(recovered.disabledAt, undefined);

			f.setClock(new Date("2026-11-19T00:00:00.000Z"));
			scheduleAccountDeletion(f.opts, "local_user");
			f.setClock(new Date("2026-11-27T00:00:01.000Z"));
			assert.throws(
				() => recoverAccount(f.opts, "local_user"),
				(error: unknown) => error instanceof RegistryError && error.code === "deletion_window_expired",
			);
		} finally {
			f.cleanup();
		}
	});

	it("retires identities only after the window, leaves content for the helper, and never reuses UIDs", () => {
		const f = fixture();
		try {
			const user = findAccountBySubject(readAccountRegistry(f.opts.controllerStateDir), "local_user");
			assert.ok(user);
			scheduleAccountDeletion(f.opts, "local_user");
			f.setClock(new Date("2026-11-19T00:00:01.000Z"));
			const retired = eraseAccountById(f.opts, user.id);
			assert.equal(retired.uid, user.uid);
			assert.equal(retired.gid, user.gid);
			assert.equal(readAccountRegistry(f.opts.controllerStateDir).accounts.some((account) => account.id === user.id), false);
			// Phase 2 retires the registry record; the Phase 3 helper owns physical
			// non-content cleanup. Never claim the web process deleted the home.
			assert.equal(fs.existsSync(path.join(f.opts.accountRoot, user.id)), true);
			const replacement = ensureAccount(f.opts, "local_replacement");
			assert.notEqual(replacement.uid, user.uid);
			assert.notEqual(replacement.gid, user.gid);
			assert.ok(readAccountRegistry(f.opts.controllerStateDir).retired.some((identity) => identity.uid === user.uid));
		} finally {
			f.cleanup();
		}
	});

	it("host recovery replaces a disabled sole administrator and preserves the one-admin invariant", () => {
		const f = fixture();
		try {
			const replacement = ensureAccount(f.opts, "local_replacement");
			disableAccountBySubject(f.opts, "local_admin");
			const appointed = appointAdministratorByHost(f.opts, replacement.clerkSubject);
			assert.equal(appointed.id, replacement.id);
			assert.equal(appointed.role, "administrator");
			const registry = readAccountRegistry(f.opts.controllerStateDir);
			assert.equal(registry.accounts.filter((account) => account.role === "administrator").length, 1);
			const old = registry.accounts.find((account) => account.id === f.adminId);
			assert.equal(old?.role, "user");
			assert.equal(old?.legacyClaimEligible, false);
			assert.equal(registry.accounts.find((account) => account.id === replacement.id)?.legacyClaimEligible, true);
		} finally {
			f.cleanup();
		}
	});

	it("host recovery can create a replacement administrator when no other account exists", () => {
		const f = fixture();
		try {
			disableAccountBySubject(f.opts, "local_admin");
			const appointed = appointAdministratorByHost(f.opts, "local_new_admin");
			assert.equal(appointed.role, "administrator");
			const registry = readAccountRegistry(f.opts.controllerStateDir);
			assert.equal(registry.accounts.filter((account) => account.role === "administrator").length, 1);
			assert.equal(registry.accounts.find((account) => account.id === f.adminId)?.role, "user");
			assert.equal(fs.statSync(path.join(f.opts.accountRoot, appointed.id)).mode & 0o777, 0o700);
		} finally {
			f.cleanup();
		}
	});
});
