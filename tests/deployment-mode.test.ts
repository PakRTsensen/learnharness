/**
 * DEPLOYMENT MODE + MULTIUSER READINESS (per-user accounts, Phase 1).
 *
 * Pins the fail-closed selection rules and the configuration/mount checks
 * that must pass before a multiuser-web process may serve auth surfaces.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DeploymentModeError,
	deploymentMode,
	isMultiuserWeb,
	parseDeploymentMode,
} from "../src/runtime/deployment-mode.ts";
import { loadMultiuserConfig } from "../src/runtime/multiuser-config.ts";
import {
	assertReady,
	evaluateReadiness,
	prepareLocalDevelopmentDirectories,
	ReadinessError,
	type ReadinessEntry,
} from "../src/runtime/readiness.ts";

const SECRET = "s".repeat(48);

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		LH_DEPLOYMENT_MODE: "multiuser-web",
		LH_AUTH_PROVIDER: "local",
		LH_ALLOW_LOCAL_AUTH: "1",
		LH_LOCAL_AUTH_SECRET: SECRET,
		LH_READ_ONLY_ROOT_FS: "1",
		LH_WRITABLE_MOUNTS: "/srv/lh",
		LH_ACCOUNT_ROOT: "/srv/lh/accounts",
		LH_CONTROLLER_STATE_DIR: "/srv/lh/controller",
		LH_STAGING_DIR: "/srv/lh/staging",
		LH_SNAPSHOT_DIR: "/srv/lh/snapshots",
		LH_PRIVATE_WORK_DIR: "/srv/lh/work",
		NODE_ENV: "test",
		...overrides,
	};
}

function configOk(overrides: Record<string, string | undefined> = {}) {
	const loaded = loadMultiuserConfig(baseEnv(overrides));
	if (!loaded.ok) throw new Error(loaded.issues.map((issue) => issue.code).join(","));
	return loaded.config;
}

function codes(result: ReturnType<typeof loadMultiuserConfig>): string[] {
	return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("deployment mode", () => {
	it("defaults to single-user web and auto-detects the desktop launch marker", () => {
		assert.deepEqual(parseDeploymentMode({}), {
			ok: true,
			selection: { mode: "single-user-web", source: "default" },
		});
		assert.equal(parseDeploymentMode({ LH_DESKTOP_SERVER: "1" }).ok, true);
		assert.equal(deploymentMode({ LH_DESKTOP_SERVER: "1" }), "desktop");
		assert.equal(deploymentMode({ LH_DESKTOP_API_SECRET: "x".repeat(64) }), "desktop");
	});

	it("requires the explicit multiuser selector and rejects conflicts/typos", () => {
		assert.equal(deploymentMode({ LH_DEPLOYMENT_MODE: "multiuser-web" }), "multiuser-web");
		assert.equal(isMultiuserWeb({ LH_DEPLOYMENT_MODE: "multiuser-web" }), true);
		assert.equal(isMultiuserWeb({}), false);

		const explicitDesktop = parseDeploymentMode({ LH_DEPLOYMENT_MODE: "desktop" });
		assert.equal(explicitDesktop.ok, false);
		if (!explicitDesktop.ok) assert.equal(explicitDesktop.code, "desktop_mode_not_explicit");

		const conflict = parseDeploymentMode({ LH_DEPLOYMENT_MODE: "multiuser-web", LH_DESKTOP_SERVER: "1" });
		assert.equal(conflict.ok, false);
		if (!conflict.ok) assert.equal(conflict.code, "desktop_multiuser_conflict");

		const typo = parseDeploymentMode({ LH_DEPLOYMENT_MODE: "multi-user" });
		assert.equal(typo.ok, false);
		if (!typo.ok) assert.equal(typo.code, "invalid_deployment_mode");

		assert.throws(() => deploymentMode({ LH_DEPLOYMENT_MODE: "nope" }), DeploymentModeError);
	});

	it("does not select multiuser merely because Clerk variables exist", () => {
		assert.equal(deploymentMode({ CLERK_ISSUER: "https://clerk.example", CLERK_SECRET_KEY: "sk_test" }), "single-user-web");
	});
});

describe("multiuser configuration", () => {
	it("accepts a complete local/offline configuration", () => {
		const config = configOk();
		assert.equal(config.auth.provider, "local");
		assert.deepEqual(config.paths, {
			accountRoot: "/srv/lh/accounts",
			controllerStateDir: "/srv/lh/controller",
			stagingDir: "/srv/lh/staging",
			snapshotDir: "/srv/lh/snapshots",
			privateWorkDir: "/srv/lh/work",
		});
		assert.deepEqual(config.uidRange, { start: 200000, end: 200999 });
		assert.deepEqual(config.gidRange, { start: 200000, end: 200999 });
		assert.equal(config.readOnlyRootFilesystem, true);
		assert.equal(config.sessionTtlSeconds, 43_200);
		assert.equal(config.limits.maxActiveAccounts, 20);
	});

	it("accepts the explicit production local-auth opt-in", () => {
		const config = configOk({ NODE_ENV: "production", LH_ALLOW_LOCAL_AUTH: "1" });
		assert.equal(config.auth.provider, "local");
	});

	it("refuses local auth in production without the explicit opt-in", () => {
		const loaded = loadMultiuserConfig(baseEnv({ NODE_ENV: "production", LH_ALLOW_LOCAL_AUTH: undefined }));
		assert.equal(loaded.ok, false);
		assert.ok(codes(loaded).includes("local_auth_not_allowed"));
	});

	it("fails closed on missing read-only root, missing mounts, and paths outside mounts", () => {
		assert.ok(codes(loadMultiuserConfig(baseEnv({ LH_READ_ONLY_ROOT_FS: undefined }))).includes("read_only_root_required"));
		assert.ok(codes(loadMultiuserConfig(baseEnv({ LH_WRITABLE_MOUNTS: undefined }))).includes("writable_mounts_missing"));
		assert.ok(codes(loadMultiuserConfig(baseEnv({ LH_WRITABLE_MOUNTS: "/srv/elsewhere" }))).includes("path_not_writable"));
		assert.ok(codes(loadMultiuserConfig(baseEnv({ LH_ACCOUNT_ROOT: "relative/accounts" }))).includes("path_not_absolute"));
	});

	it("refuses overlapping controller/account paths and invalid identity ranges", () => {
		assert.ok(codes(loadMultiuserConfig(baseEnv({ LH_CONTROLLER_STATE_DIR: "/srv/lh/accounts/controller" }))).includes("path_overlaps_account_root"));
		assert.ok(codes(loadMultiuserConfig(baseEnv({ LH_UID_RANGE_START: "500", LH_UID_RANGE_END: "600" }))).includes("identity_range_invalid"));
		assert.ok(codes(loadMultiuserConfig(baseEnv({ LH_GID_RANGE_START: "900", LH_GID_RANGE_END: "800" }))).includes("identity_range_invalid"));
	});

	it("validates secrets, TTLs, and limits without exposing values", () => {
		const short = loadMultiuserConfig(baseEnv({ LH_LOCAL_AUTH_SECRET: "short" }));
		assert.ok(codes(short).includes("session_secret_missing"));
		const long = loadMultiuserConfig(baseEnv({ LH_LOCAL_AUTH_SECRET: "x".repeat(600) }));
		assert.ok(codes(long).includes("secret_length_invalid"));
		const whitespace = loadMultiuserConfig(baseEnv({ LH_LOCAL_AUTH_SECRET: ` ${SECRET}` }));
		assert.ok(codes(whitespace).includes("secret_has_surrounding_whitespace"));
		const ttl = loadMultiuserConfig(baseEnv({ LH_SESSION_TTL_SECONDS: "10" }));
		assert.ok(codes(ttl).includes("session_ttl_invalid"));
		const limit = loadMultiuserConfig(baseEnv({ LH_MAX_ACTIVE_ACCOUNTS: "0" }));
		assert.ok(codes(limit).includes("limit_invalid"));
		for (const result of [short, long, whitespace, ttl, limit]) {
			const text = JSON.stringify(result);
			assert.equal(text.includes(SECRET), false, "configured secret never appears in validation output");
		}
	});

	it("accepts runtime Clerk configuration and derives the JWKS URL", () => {
		const config = configOk({
			LH_AUTH_PROVIDER: "clerk",
			LH_LOCAL_AUTH_SECRET: undefined,
			LH_SESSION_SECRET: SECRET,
			CLERK_ISSUER: "https://clerk.example.com",
			LH_APP_ORIGIN: "https://learn.example.com",
			CLERK_WEBHOOK_SECRET: "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQ=",
		});
		assert.equal(config.auth.provider, "clerk");
		if (config.auth.provider !== "clerk") return;
		assert.equal(config.auth.jwksUrl, "https://clerk.example.com/.well-known/jwks.json");
		assert.deepEqual(config.auth.authorizedParties, ["https://learn.example.com"]);
		assert.equal(config.auth.sessionCookie, "__session");
		assert.equal(config.auth.webhookSecret, "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQ=");
	});

	it("refuses insecure or incomplete Clerk configuration", () => {
		const insecure = loadMultiuserConfig(baseEnv({
			LH_AUTH_PROVIDER: "clerk",
			LH_LOCAL_AUTH_SECRET: undefined,
			LH_SESSION_SECRET: SECRET,
			CLERK_ISSUER: "http://clerk.example.com",
			LH_APP_ORIGIN: "https://learn.example.com",
		}));
		assert.ok(codes(insecure).includes("url_insecure"));
		const missing = loadMultiuserConfig(baseEnv({
			LH_AUTH_PROVIDER: "clerk",
			LH_LOCAL_AUTH_SECRET: undefined,
		}));
		assert.ok(codes(missing).includes("url_missing"));
		assert.ok(codes(missing).includes("session_secret_missing"));
		const unknown = loadMultiuserConfig(baseEnv({ LH_AUTH_PROVIDER: "saml" }));
		assert.ok(codes(unknown).includes("auth_provider_invalid"));
	});
});

describe("multiuser readiness", () => {
	const config = configOk();
	const entry = (overrides: Partial<ReadinessEntry> = {}): ReadinessEntry => ({
		isDirectory: true,
		isSymbolicLink: false,
		mode: 0o700,
		uid: 0,
		...overrides,
	});

	function deps(entries: Record<string, ReadinessEntry>, uid = 1000) {
		return {
			lstat: (file: string) => {
				const found = entries[file];
				if (!found) throw new Error("ENOENT");
				return found;
			},
			getuid: () => uid,
		};
	}

	function allDirectories(): Record<string, ReadinessEntry> {
		return Object.fromEntries(Object.values(config.paths).map((directory) => [directory, entry()]));
	}

	it("passes with host-created private directories and reports ownership advisories", () => {
		const entries = allDirectories();
		const report = evaluateReadiness("multiuser-web", { ok: true, config }, deps(entries));
		assert.equal(report.ok, true);
		const owner = report.checks.find((check) => check.code === "account_root_owner");
		assert.equal(owner?.mandatory, false);
		assert.equal(owner?.ok, true);
	});

	it("fails closed on a missing, symlinked, or non-private account root", () => {
		const missing = allDirectories();
		delete missing[config.paths.accountRoot];
		const missingReport = evaluateReadiness("multiuser-web", { ok: true, config }, deps(missing));
		assert.equal(missingReport.ok, false);
		assert.ok(missingReport.checks.some((check) => check.code === "account_root_missing" && !check.ok));

		const symlink = allDirectories();
		symlink[config.paths.accountRoot] = entry({ isSymbolicLink: true });
		const symlinkReport = evaluateReadiness("multiuser-web", { ok: true, config }, deps(symlink));
		assert.equal(symlinkReport.ok, false);
		assert.ok(symlinkReport.checks.some((check) => check.code === "account_root_directory" && !check.ok));

		// Ownership/mode is advisory in Milestone 1 (Phase 3 makes it mandatory).
		const loose = allDirectories();
		loose[config.paths.accountRoot] = entry({ mode: 0o755, uid: 1000 });
		assert.equal(evaluateReadiness("multiuser-web", { ok: true, config }, deps(loose)).ok, true);
	});

	it("throws the readiness error and leaves single-user mode inert", () => {
		assert.throws(
			() => assertReady("multiuser-web", { ok: true, config }, deps({})),
			(error: unknown) => error instanceof ReadinessError && error.codes.includes("account_root_missing"),
		);
		const single = evaluateReadiness("single-user-web", { ok: true, config });
		assert.equal(single.ok, true);
		assert.equal(single.checks[0]?.code, "mode_single_user");
	});

	it("local offline simulation prepares its runtime directories only", () => {
		const created: string[] = [];
		prepareLocalDevelopmentDirectories(config, { mkdir: (directory) => { created.push(directory); } });
		assert.deepEqual(created.sort(), Object.values(config.paths).sort());
		const clerkConfig = configOk({
			LH_AUTH_PROVIDER: "clerk",
			LH_LOCAL_AUTH_SECRET: undefined,
			LH_SESSION_SECRET: SECRET,
			CLERK_ISSUER: "https://clerk.example.com",
			LH_APP_ORIGIN: "https://learn.example.com",
		});
		const clerkCreated: string[] = [];
		prepareLocalDevelopmentDirectories(clerkConfig, { mkdir: (directory) => { clerkCreated.push(directory); } });
		assert.deepEqual(clerkCreated, []);
	});
});
