/**
 * FIRST-ADMIN BOOTSTRAP (per-user accounts, Phase 2).
 *
 * The host secret is single-commit: failed provisioning commits nothing and
 * permits retry; success consumes the secret permanently. Registration stays
 * closed until the transaction commits.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	ensureAccount,
	readAccountRegistry,
	RegistryError,
	type RegistryOptions,
} from "../src/controller/registry.ts";
import {
	bootstrapFirstAdministrator,
	bootstrapRequired,
	bootstrapSecretMatches,
	readBootstrapSecret,
} from "../src/controller/provisioning.ts";

const SECRET = "b".repeat(48);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-provisioning-"));

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

function options(root: string): RegistryOptions {
	return {
		controllerStateDir: path.join(root, "controller"),
		accountRoot: path.join(root, "accounts"),
		uidRange: { start: 50000, end: 50010 },
		gidRange: { start: 60000, end: 60010 },
	};
}

function prepare(root: string): void {
	fs.mkdirSync(path.join(root, "accounts"), { mode: 0o700 });
}

describe("bootstrap secret source", () => {
	it("reads the environment first, then a small secret file", () => {
		const fromEnv = readBootstrapSecret({ LH_BOOTSTRAP_SECRET: SECRET });
		assert.equal(fromEnv.ok, true);
		if (fromEnv.ok) {
			assert.equal(fromEnv.source, "env");
			assert.equal(fromEnv.secret, SECRET);
		}
		const file = path.join(TMP, "bootstrap-secret");
		fs.writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });
		const fromFile = readBootstrapSecret({ LH_BOOTSTRAP_SECRET_FILE: file });
		assert.equal(fromFile.ok, true);
		if (fromFile.ok) {
			assert.equal(fromFile.source, "file");
			assert.equal(fromFile.secret, SECRET);
		}
	});

	it("refuses absent, short, and oversized secrets without echoing them", () => {
		const absent = readBootstrapSecret({});
		assert.equal(absent.ok, false);
		if (!absent.ok) assert.equal(absent.code, "bootstrap_secret_unavailable");
		const short = readBootstrapSecret({ LH_BOOTSTRAP_SECRET: "short" });
		assert.equal(short.ok, false);
		if (!short.ok) {
			assert.equal(short.code, "bootstrap_secret_invalid");
			assert.equal(JSON.stringify(short).includes("short"), false);
		}
		const oversized = readBootstrapSecret({ LH_BOOTSTRAP_SECRET: "x".repeat(600) });
		assert.equal(oversized.ok, false);
		const missingFile = readBootstrapSecret({ LH_BOOTSTRAP_SECRET_FILE: path.join(TMP, "missing") });
		assert.equal(missingFile.ok, false);
	});
});

describe("first-administrator transaction", () => {
	it("keeps registration closed and commits nothing on a wrong secret", () => {
		const root = fs.mkdtempSync(path.join(TMP, "wrong-"));
		prepare(root);
		const opts = options(root);
		assert.equal(bootstrapRequired(opts.controllerStateDir), true);

		const wrong = bootstrapFirstAdministrator(opts, {
			subject: "local_admin",
			providedSecret: "x".repeat(48),
			configuredSecret: SECRET,
		});
		assert.equal(wrong.ok, false);
		if (!wrong.ok) assert.equal(wrong.code, "bootstrap_secret_invalid");
		assert.equal(bootstrapRequired(opts.controllerStateDir), true);
		assert.equal(fs.readdirSync(path.join(root, "accounts")).length, 0, "no home was committed");
		assert.equal(fs.existsSync(path.join(root, "controller", "registry.json")), false);
		assert.throws(
			() => ensureAccount(opts, "local_user"),
			(error: unknown) => error instanceof RegistryError && error.code === "bootstrap_required",
		);
	});

	it("retries after a transient failure with the secret still unconsumed", () => {
		const root = fs.mkdtempSync(path.join(TMP, "retry-"));
		const opts = options(root);
		const failed = bootstrapFirstAdministrator(opts, {
			subject: "local_admin",
			providedSecret: SECRET,
			configuredSecret: SECRET,
		});
		assert.equal(failed.ok, false);
		if (!failed.ok) assert.equal(failed.code, "account_root_missing");
		assert.equal(fs.existsSync(path.join(opts.controllerStateDir, "registry.json")), false, "no account state was committed");
		assert.equal(fs.existsSync(opts.accountRoot), false, "no account root was created by the controller");

		prepare(root);
		const retried = bootstrapFirstAdministrator(opts, {
			subject: "local_admin",
			providedSecret: SECRET,
			configuredSecret: SECRET,
		});
		assert.equal(retried.ok, true);
		if (!retried.ok) return;
		assert.equal(retried.account.role, "administrator");
		assert.equal(bootstrapRequired(opts.controllerStateDir), false);
		assert.equal(readAccountRegistry(opts.controllerStateDir).bootstrap?.clerkSubject, "local_admin");

		const replay = bootstrapFirstAdministrator(opts, {
			subject: "local_second",
			providedSecret: SECRET,
			configuredSecret: SECRET,
		});
		assert.equal(replay.ok, false);
		if (!replay.ok) assert.equal(replay.code, "bootstrap_already_consumed");
	});

	it("serializes a same-process second attempt into already-consumed", () => {
		const root = fs.mkdtempSync(path.join(TMP, "concurrent-"));
		prepare(root);
		const opts = options(root);
		const first = bootstrapFirstAdministrator(opts, {
			subject: "local_first",
			providedSecret: SECRET,
			configuredSecret: SECRET,
		});
		const second = bootstrapFirstAdministrator(opts, {
			subject: "local_second",
			providedSecret: SECRET,
			configuredSecret: SECRET,
		});
		assert.equal(first.ok, true);
		assert.equal(second.ok, false);
		if (!second.ok) assert.equal(second.code, "bootstrap_already_consumed");
		assert.equal(readAccountRegistry(opts.controllerStateDir).accounts.length, 1);
	});

	it("refuses an invalid subject before writing any state", () => {
		const root = fs.mkdtempSync(path.join(TMP, "subject-"));
		prepare(root);
		const opts = options(root);
		const result = bootstrapFirstAdministrator(opts, {
			subject: "../../etc/passwd",
			providedSecret: SECRET,
			configuredSecret: SECRET,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "subject_invalid");
		assert.equal(fs.existsSync(path.join(root, "controller", "registry.json")), false);
	});

	it("does not accept a secret supplied without a host configuration", () => {
		const root = fs.mkdtempSync(path.join(TMP, "unconfigured-"));
		prepare(root);
		const result = bootstrapFirstAdministrator(options(root), {
			subject: "local_admin",
			providedSecret: SECRET,
			configuredSecret: undefined,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.code, "bootstrap_secret_unavailable");
	});

	it("compares secrets through fixed-length digests", () => {
		assert.equal(bootstrapSecretMatches(SECRET, SECRET), true);
		assert.equal(bootstrapSecretMatches(SECRET, `${SECRET}x`), false);
		assert.equal(bootstrapSecretMatches(SECRET, "y".repeat(48)), false);
	});
});
