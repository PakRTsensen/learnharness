/**
 * ACCOUNT REGISTRY (per-user accounts, Phase 2).
 *
 * Pins serialized allocation, the permanent UID/GID non-reuse ledger,
 * path derivation from internal ids only, corruption fail-closure, and the
 * exactly-one-administrator invariant.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { parseAccountRegistry } from "../src/accounts/contracts.ts";
import {
	ACCOUNT_SUBJECT_PATTERN,
	emptyRegistry,
	toPublicAccount,
} from "../src/accounts/contracts.ts";
import {
	allocateIdentity,
	appointAdministratorByHost,
	disableAccountBySubject,
	ensureAccount,
	eraseAccountById,
	findAccountBySubject,
	readAccountRegistry,
	recoverAccount,
	registryOptionsFromConfig,
	scheduleAccountDeletion,
	transferAdministrator,
	withRegistryLock,
	writeAccountRegistry,
	RegistryError,
	type RegistryOptions,
} from "../src/controller/registry.ts";
import { bootstrapFirstAdministrator } from "../src/controller/provisioning.ts";
import { loadMultiuserConfig } from "../src/runtime/multiuser-config.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-registry-"));
const ACCOUNT_ROOT = path.join(TMP, "accounts");
const CONTROLLER = path.join(TMP, "controller");
fs.mkdirSync(ACCOUNT_ROOT, { mode: 0o700 });

let clock = new Date("2026-11-12T00:00:00.000Z");
const options = (): RegistryOptions => ({
	controllerStateDir: CONTROLLER,
	accountRoot: ACCOUNT_ROOT,
	uidRange: { start: 30000, end: 30010 },
	gidRange: { start: 40000, end: 40010 },
	now: () => clock,
	lockTimeoutMs: 100,
});

function bootstrap(secret = "b".repeat(48)) {
	const result = bootstrapFirstAdministrator(options(), {
		subject: "local_admin",
		providedSecret: secret,
		configuredSecret: secret,
	});
	if (!result.ok) throw new Error(result.code);
	return result;
}

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("registry contracts", () => {
	it("rejects duplicate UIDs, duplicate subjects, bad homes, and unknown versions", () => {
		const base = {
			version: 1,
			bootstrap: {
				consumedAt: "2026-11-12T00:00:00.000Z",
				administratorAccountId: `acct_${"a".repeat(32)}`,
				clerkSubject: "local_admin",
				legacyClaimEligible: true,
			},
			accounts: [{
				id: `acct_${"a".repeat(32)}`,
				clerkSubject: "local_admin",
				role: "administrator",
				lifecycle: "active",
				uid: 30000,
				gid: 40000,
				home: `acct_${"a".repeat(32)}`,
				generation: 1,
				createdAt: "2026-11-12T00:00:00.000Z",
				updatedAt: "2026-11-12T00:00:00.000Z",
				legacyClaimEligible: true,
			}],
			retired: [],
		};
		assert.equal(parseAccountRegistry(base).accounts.length, 1);
		assert.throws(() => parseAccountRegistry({ ...base, version: 2 }), /newer LearnHarness/);
		assert.throws(() => parseAccountRegistry({
			...base,
			accounts: [base.accounts[0], { ...base.accounts[0], id: `acct_${"b".repeat(32)}`, home: `acct_${"b".repeat(32)}` }],
		}), /Duplicate account UID|Duplicate account subject/);
		assert.throws(() => parseAccountRegistry({
			...base,
			accounts: [{ ...base.accounts[0], home: "../escape" }],
		}), /home must be the internal account id/);
		assert.throws(() => parseAccountRegistry({
			...base,
			accounts: [{ ...base.accounts[0], role: "user", legacyClaimEligible: false }],
		}), /Exactly one administrator/);
		assert.equal(ACCOUNT_SUBJECT_PATTERN.test("local_admin"), true);
		assert.equal(ACCOUNT_SUBJECT_PATTERN.test("../../etc/passwd"), false);
		assert.deepEqual(emptyRegistry(), { version: 1, bootstrap: null, accounts: [], retired: [] });
	});

	it("allocates the first free identity and refuses exhaustion", () => {
		const registry = emptyRegistry();
		assert.deepEqual(allocateIdentity(registry, { start: 30000, end: 30001 }, { start: 40000, end: 40001 }), { uid: 30000, gid: 40000 });
		const exhausted = {
			...registry,
			accounts: [{
				id: `acct_${"a".repeat(32)}`,
				clerkSubject: "local_admin",
				role: "administrator" as const,
				lifecycle: "active" as const,
				uid: 30000,
				gid: 40000,
				home: `acct_${"a".repeat(32)}`,
				generation: 1,
				createdAt: "2026-11-12T00:00:00.000Z",
				updatedAt: "2026-11-12T00:00:00.000Z",
				legacyClaimEligible: true,
			}],
			bootstrap: {
				consumedAt: "2026-11-12T00:00:00.000Z",
				administratorAccountId: `acct_${"a".repeat(32)}`,
				clerkSubject: "local_admin",
				legacyClaimEligible: true as const,
			},
		};
		assert.throws(
			() => allocateIdentity(exhausted, { start: 30000, end: 30000 }, { start: 40000, end: 40000 }),
			(error: unknown) => error instanceof RegistryError && error.code === "identity_range_exhausted",
		);
	});
});

describe("registry transactions", () => {
	it("commits bootstrap, creates a private home, and refuses replay", () => {
		const result = bootstrap();
		assert.equal(result.account.role, "administrator");
		assert.equal(result.account.uid, 30000);
		assert.equal(result.account.gid, 40000);
		assert.equal(result.account.home, result.account.id);
		assert.equal(result.registry.bootstrap?.administratorAccountId, result.account.id);
		const home = path.join(ACCOUNT_ROOT, result.account.id);
		assert.equal(fs.statSync(home).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(CONTROLLER, "registry.json")).mode & 0o777, 0o600);
		assert.equal(readAccountRegistry(CONTROLLER).accounts.length, 1);

		const replay = bootstrapFirstAdministrator(options(), {
			subject: "local_other",
			providedSecret: "b".repeat(48),
			configuredSecret: "b".repeat(48),
		});
		assert.equal(replay.ok, false);
		if (!replay.ok) assert.equal(replay.code, "bootstrap_already_consumed");
	});

	it("registers ordinary accounts idempotently after bootstrap", () => {
		const first = ensureAccount(options(), "local_user");
		const second = ensureAccount(options(), "local_user");
		assert.equal(first.id, second.id);
		assert.equal(first.role, "user");
		assert.equal(first.uid, 30001);
		assert.equal(first.gid, 40001);
		assert.equal(fs.statSync(path.join(ACCOUNT_ROOT, first.id)).mode & 0o777, 0o700);
		const publicView = toPublicAccount(first);
		assert.equal("clerkSubject" in publicView, false);
		assert.equal("uid" in publicView, false);
	});

	it("serializes registry writers and reports a busy lock", () => {
		const lock = path.join(CONTROLLER, "registry.lock");
		fs.writeFileSync(lock, "other-owner", { mode: 0o600 });
		try {
			assert.throws(
				() => withRegistryLock({ ...options(), lockTimeoutMs: 30 }, () => "never"),
				(error: unknown) => error instanceof RegistryError && error.code === "registry_busy",
			);
		} finally {
			fs.rmSync(lock, { force: true });
		}
		assert.equal(withRegistryLock({ ...options(), lockTimeoutMs: 100 }, () => "ran"), "ran");
	});

	it("fails closed on a corrupt registry or an unsupported version", () => {
		const file = path.join(CONTROLLER, "registry.json");
		const original = fs.readFileSync(file, "utf8");
		fs.writeFileSync(file, "{not json");
		assert.throws(
			() => readAccountRegistry(CONTROLLER),
			(error: unknown) => error instanceof RegistryError && error.code === "registry_invalid",
		);
		fs.writeFileSync(file, JSON.stringify({ version: 99, bootstrap: null, accounts: [], retired: [] }));
		assert.throws(
			() => readAccountRegistry(CONTROLLER),
			(error: unknown) => error instanceof RegistryError && error.code === "registry_version_unsupported",
		);
		fs.writeFileSync(file, original);
	});
});

describe("registry lifecycle", () => {
	it("transfers the administrator role, disables, schedules deletion, and recovers", () => {
		const admin = readAccountRegistry(CONTROLLER).accounts.find((account) => account.role === "administrator");
		assert.ok(admin);
		const user = findAccountBySubject(readAccountRegistry(CONTROLLER), "local_user");
		assert.ok(user);

		assert.throws(
			() => scheduleAccountDeletion(options(), "local_admin"),
			(error: unknown) => error instanceof RegistryError && error.code === "transfer_admin_required",
		);

		const transferred = transferAdministrator(options(), "local_admin", user.id);
		assert.equal(transferred.role, "administrator");
		const registry = readAccountRegistry(CONTROLLER);
		assert.equal(registry.accounts.filter((account) => account.role === "administrator").length, 1);
		assert.equal(findAccountBySubject(registry, "local_admin")?.role, "user");
		assert.equal(findAccountBySubject(registry, "local_admin")?.legacyClaimEligible, false);

		const lifecycle = ensureAccount(options(), "local_lifecycle");
		const disabled = disableAccountBySubject(options(), "local_lifecycle");
		assert.equal(disabled?.lifecycle, "disabled");
		assert.equal(disabled?.generation, lifecycle.generation + 1);
		assert.equal(disableAccountBySubject(options(), "local_lifecycle")?.generation, disabled?.generation);
		assert.throws(
			() => recoverAccount(options(), "local_lifecycle"),
			(error: unknown) => error instanceof RegistryError && error.code === "account_disabled",
		);

		clock = new Date("2026-11-13T00:00:00.000Z");
		const scheduled = scheduleAccountDeletion(options(), "local_admin");
		assert.equal(scheduled.lifecycle, "pending-deletion");
		assert.equal(scheduled.deletionScheduledFor, "2026-11-20T00:00:00.000Z");
		const recovered = recoverAccount(options(), "local_admin");
		assert.equal(recovered.lifecycle, "active");
		assert.equal(recovered.deletionScheduledFor, undefined);
	});

	it("keeps retired identities permanently unavailable and never deletes data early", () => {
		const user = ensureAccount(options(), "local_erase_me");
		clock = new Date("2026-11-14T00:00:00.000Z");
		const scheduled = scheduleAccountDeletion(options(), user.clerkSubject);
		assert.equal(scheduled.lifecycle, "pending-deletion");
		assert.throws(
			() => eraseAccountById(options(), user.id),
			(error: unknown) => error instanceof RegistryError && error.code === "deletion_not_due",
		);

		clock = new Date("2026-11-22T00:00:00.000Z");
		const retired = eraseAccountById(options(), user.id);
		assert.equal(retired.uid, user.uid);
		assert.equal(retired.gid, user.gid);
		assert.equal(readAccountRegistry(CONTROLLER).accounts.some((account) => account.id === user.id), false);
		const replacement = ensureAccount(options(), "local_replacement");
		assert.notEqual(replacement.uid, user.uid);
		assert.notEqual(replacement.gid, user.gid);
	});

	it("host recovery can replace a disabled sole administrator without content access", () => {
		const registry = readAccountRegistry(CONTROLLER);
		const admin = registry.accounts.find((account) => account.role === "administrator");
		assert.ok(admin);
		clock = new Date("2026-11-23T00:00:00.000Z");
		disableAccountBySubject(options(), admin.clerkSubject);
		const replacement = appointAdministratorByHost(options(), "local_replacement");
		assert.equal(replacement.role, "administrator");
		const after = readAccountRegistry(CONTROLLER);
		assert.equal(after.accounts.filter((account) => account.role === "administrator").length, 1);
		assert.equal(after.accounts.find((account) => account.id === admin.id)?.role, "user");
		assert.equal(after.accounts.find((account) => account.id === replacement.id)?.legacyClaimEligible, true);
	});
});

describe("registry config projection", () => {
	it("uses only validated host paths and ranges", () => {
		const loaded = loadMultiuserConfig({
			LH_DEPLOYMENT_MODE: "multiuser-web",
			LH_AUTH_PROVIDER: "local",
			LH_ALLOW_LOCAL_AUTH: "1",
			LH_LOCAL_AUTH_SECRET: "s".repeat(48),
			LH_READ_ONLY_ROOT_FS: "1",
			LH_WRITABLE_MOUNTS: "/srv/lh",
			LH_ACCOUNT_ROOT: "/srv/lh/accounts",
			LH_CONTROLLER_STATE_DIR: "/srv/lh/controller",
			LH_STAGING_DIR: "/srv/lh/staging",
			LH_SNAPSHOT_DIR: "/srv/lh/snapshots",
			LH_PRIVATE_WORK_DIR: "/srv/lh/work",
			NODE_ENV: "test",
		});
		assert.equal(loaded.ok, true);
		if (!loaded.ok) return;
		const projected = registryOptionsFromConfig(loaded.config);
		assert.equal(projected.accountRoot, "/srv/lh/accounts");
		assert.deepEqual(projected.uidRange, { start: 200000, end: 200999 });
	});
});
