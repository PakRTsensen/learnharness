/**
 * Deployment modes, multiuser-web configuration, and the fail-closed readiness
 * gate (per-user-accounts phase 1).
 *
 * These tests are the Phase 1 resolution-step evidence for the parts that do not
 * need a container: mode selection, invalid combinations, startup refusal, and
 * the readiness decision function over injected host facts. The real Docker
 * UID/GID/mount evidence is the Phase 3 gate (A13).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CLERK_VARIABLES,
	DEPLOYMENT_MODE_VARIABLE,
	selectDeploymentMode,
	type DeploymentEnvironment,
} from "../src/runtime/deployment-mode.ts";
import {
	ACCOUNT_LIMIT_VARIABLES,
	GLOBAL_LIMIT_VARIABLES,
	loadMultiuserConfig,
	redactedMultiuserSummary,
} from "../src/runtime/multiuser-config.ts";
import {
	evaluateReadiness,
	governingMount,
	inspectReadiness,
	isDockerSocketMount,
	parseIdentityDatabase,
	parseMountInfo,
	parseProcessGroups,
	type MountEntry,
	type NodeFacts,
	type ReadinessFacts,
} from "../src/runtime/readiness.ts";

const SECRET = "sk_test_SUPERSECRETVALUE";
const PUBLISHABLE = "pk_test_PUBLICVALUE";

/** A complete, valid multiuser-web environment. Tests subtract from this. */
function validEnv(): DeploymentEnvironment {
	return {
		[DEPLOYMENT_MODE_VARIABLE]: "multiuser-web",
		CLERK_SECRET_KEY: SECRET,
		NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PUBLISHABLE,
		LH_CLERK_AUTHORIZED_PARTIES: "https://learn.example.com,http://localhost:3000",
		LH_ACCOUNT_ROOT: "/data/accounts",
		LH_REGISTRY_DIR: "/data/registry",
		LH_INSTANCE_STATE_DIR: "/data/instance",
		LH_STAGING_DIR: "/data/staging",
		LH_SNAPSHOT_DIR: "/data/snapshots",
		LH_PRIVATE_WORK_DIR: "/data/private-work",
		LH_CONTROLLER_IPC: "/run/lh/controller.sock",
		LH_HELPER_IPC: "/run/lh/helper.sock",
		[ACCOUNT_LIMIT_VARIABLES.processes]: "64",
		[ACCOUNT_LIMIT_VARIABLES.cpuMillicores]: "2000",
		[ACCOUNT_LIMIT_VARIABLES.memoryMb]: "2048",
		[ACCOUNT_LIMIT_VARIABLES.concurrentJobs]: "4",
		[ACCOUNT_LIMIT_VARIABLES.diskMb]: "4096",
		[GLOBAL_LIMIT_VARIABLES.activeAccounts]: "20",
		[GLOBAL_LIMIT_VARIABLES.activeWorkers]: "20",
		[GLOBAL_LIMIT_VARIABLES.streams]: "60",
		[GLOBAL_LIMIT_VARIABLES.providerConnections]: "40",
		[GLOBAL_LIMIT_VARIABLES.archiveJobs]: "2",
		[GLOBAL_LIMIT_VARIABLES.tempBytes]: String(2 * 1024 * 1024 * 1024),
	};
}

function without(env: DeploymentEnvironment, ...names: string[]): DeploymentEnvironment {
	const copy = { ...env };
	for (const name of names) delete copy[name];
	return copy;
}

describe("deployment mode selection", () => {
	it("defaults to the single-user profile when nothing selects a mode", () => {
		const selection = selectDeploymentMode({});
		assert.equal(selection.ok, true);
		if (selection.ok) {
			assert.equal(selection.mode, "single-user");
			assert.equal(selection.source, "default");
		}
	});

	it("recognises the Electron shell's launch markers as desktop", () => {
		for (const marker of [{ LH_DESKTOP_SERVER: "1" }, { LH_DESKTOP_API_SECRET: "a".repeat(64) }]) {
			const selection = selectDeploymentMode(marker);
			assert.equal(selection.ok, true);
			if (selection.ok) {
				assert.equal(selection.mode, "desktop");
				assert.equal(selection.source, "desktop-shell");
			}
		}
	});

	it("honours an explicit mode over the desktop markers", () => {
		assert.equal(selectDeploymentMode({ LH_DEPLOYMENT_MODE: "desktop" }).ok, true);
		const explicit = selectDeploymentMode({ LH_DEPLOYMENT_MODE: "single-user", LH_DESKTOP_SERVER: "1" });
		assert.equal(explicit.ok, true);
		if (explicit.ok) assert.equal(explicit.mode, "single-user");
	});

	it("accepts multiuser-web only when explicitly selected", () => {
		const selection = selectDeploymentMode({ LH_DEPLOYMENT_MODE: "multiuser-web" });
		assert.equal(selection.ok, true);
		if (selection.ok) {
			assert.equal(selection.mode, "multiuser-web");
			assert.equal(selection.source, "explicit");
		}
	});

	it("never infers multiuser-web from Clerk variables alone", () => {
		const selection = selectDeploymentMode({
			CLERK_SECRET_KEY: SECRET,
			NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PUBLISHABLE,
		});
		assert.equal(selection.ok, true);
		if (selection.ok) {
			assert.equal(selection.mode, "single-user");
			assert.equal(selection.warnings.length, 1);
			assert.match(selection.warnings[0]!, /Clerk authentication is inactive/);
		}
	});

	it("refuses an unknown explicit mode instead of falling back", () => {
		const selection = selectDeploymentMode({ LH_DEPLOYMENT_MODE: "multiuser" });
		assert.equal(selection.ok, false);
		if (!selection.ok) {
			assert.match(selection.error, /LH_DEPLOYMENT_MODE/);
			assert.match(selection.error, /desktop, single-user, multiuser-web/);
		}
	});

	it("refuses contradictions: the desktop capability has no meaning in multiuser-web", () => {
		const selection = selectDeploymentMode({ LH_DEPLOYMENT_MODE: "multiuser-web", LH_DESKTOP_API_SECRET: "a".repeat(64) });
		assert.equal(selection.ok, false);
		if (!selection.ok) assert.match(selection.error, /desktop capability has no meaning/);
	});

	it("does not report Clerk as inactive when it is the active profile", () => {
		const selection = selectDeploymentMode({ LH_DEPLOYMENT_MODE: "multiuser-web", CLERK_SECRET_KEY: SECRET });
		assert.equal(selection.ok, true);
		if (selection.ok) assert.deepEqual(selection.warnings, []);
	});

	it("names the Clerk variables without echoing their values", () => {
		const selection = selectDeploymentMode({ CLERK_SECRET_KEY: SECRET, LH_CLERK_AUTHORIZED_PARTIES: "https://sensitive-host.example" });
		assert.equal(selection.ok, true);
		if (selection.ok) {
			assert.ok(selection.warnings[0]!.includes(CLERK_VARIABLES.join("/")));
			assert.equal(selection.warnings[0]!.includes(SECRET), false);
			assert.equal(selection.warnings[0]!.includes("sensitive-host.example"), false);
		}
	});
});

describe("multiuser-web configuration", () => {
	it("accepts the documented valid surface and applies the fixed layout defaults", () => {
		const env = without(validEnv(), "LH_ACCOUNT_ROOT", "LH_REGISTRY_DIR", "LH_CONTROLLER_IPC");
		const result = loadMultiuserConfig(env);
		assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
		if (result.ok) {
			assert.equal(result.config.accountRoot, "/data/accounts");
			assert.equal(result.config.registryDir, "/data/registry");
			assert.equal(result.config.controllerIpc, "/run/lh/controller.sock");
			assert.deepEqual(result.config.clerk.authorizedParties, ["https://learn.example.com", "http://localhost:3000"]);
			assert.deepEqual(result.config.uidRange, { min: 30_000, max: 39_999 });
			assert.deepEqual(result.config.gidRange, { min: 30_000, max: 39_999 });
			assert.equal(result.config.limits.account.concurrentJobs, 4);
			assert.equal(result.config.limits.global.activeWorkers, 20);
		}
	});

	it("requires every resource limit and names the missing variable", () => {
		const names = [...Object.values(ACCOUNT_LIMIT_VARIABLES), ...Object.values(GLOBAL_LIMIT_VARIABLES)];
		for (const name of names) {
			const result = loadMultiuserConfig(without(validEnv(), name));
			assert.equal(result.ok, false, `${name} must be mandatory`);
			if (!result.ok) assert.ok(result.errors.some((error) => error.includes(name)), `${name}: ${result.errors.join("; ")}`);
		}
	});

	it("rejects zero, negative, fractional, and non-numeric limits", () => {
		for (const value of ["0", "-1", "1.5", "many", " "]) {
			const result = loadMultiuserConfig({ ...validEnv(), [ACCOUNT_LIMIT_VARIABLES.memoryMb]: value });
			assert.equal(result.ok, false, `value ${JSON.stringify(value)} must be refused`);
			if (!result.ok) assert.ok(result.errors.some((error) => error.includes(ACCOUNT_LIMIT_VARIABLES.memoryMb)));
		}
	});

	it("requires an explicit trusted-origin list and accepts canonical HTTPS or localhost HTTP origins", () => {
		for (const value of [undefined, "", "https://learn.example.com/path", "https://learn.example.com/", "https://learn.example.com?", "https://learn.example.com#", "https://user:pass@learn.example.com", "http://learn.example.com", "https://learn.example.com,,https://other.example.com", "https://learn.example.com,https://learn.example.com", "https://learn.example.com,https://other.example.com/bad"]) {
			const env = { ...validEnv() };
			if (value === undefined) delete env.LH_CLERK_AUTHORIZED_PARTIES;
			else env.LH_CLERK_AUTHORIZED_PARTIES = value;
			const result = loadMultiuserConfig(env);
			assert.equal(result.ok, false, `origin list ${JSON.stringify(value)} must be refused`);
			if (!result.ok) assert.ok(result.errors.some(error => error.includes("LH_CLERK_AUTHORIZED_PARTIES")));
		}
		for (const value of ["https://learn.example.com", "http://localhost:3000", "http://app.localhost:3000"]) {
			const result = loadMultiuserConfig({ ...validEnv(), LH_CLERK_AUTHORIZED_PARTIES: value });
			assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
		}
	});

	it("requires Clerk credentials with the documented key prefixes", () => {
		for (const [name, value] of [
			["CLERK_SECRET_KEY", "not-a-secret"],
			["CLERK_SECRET_KEY", ""],
			["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "wrong"],
		] as const) {
			const result = loadMultiuserConfig({ ...validEnv(), [name]: value });
			assert.equal(result.ok, false, `${name}=${JSON.stringify(value)} must be refused`);
			if (!result.ok) assert.ok(result.errors.some((error) => error.includes(name)));
		}
	});

	it("never echoes a supplied credential value in its errors", () => {
		const result = loadMultiuserConfig({ ...validEnv(), CLERK_SECRET_KEY: "leaky-value-without-prefix" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.errors.join(" ").includes("leaky-value-without-prefix"), false);
	});

	it("rejects identity windows that reach system users, invert, or explode", () => {
		const cases: Array<[string, string]> = [
			["LH_ACCOUNT_UID_MIN", "100"],
			["LH_ACCOUNT_UID_MAX", "999"],
			["LH_ACCOUNT_GID_MIN", "50000"],
			["LH_ACCOUNT_GID_MAX", "20000"],
			["LH_ACCOUNT_UID_MIN", "abc"],
		];
		for (const [name, value] of cases) {
			const result = loadMultiuserConfig({ ...validEnv(), [name]: value });
			assert.equal(result.ok, false, `${name}=${value} must be refused`);
			if (!result.ok) assert.ok(result.errors.some((error) => error.includes(name)), `${name}: ${result.errors.join("; ")}`);
		}
	});

	it("accepts a wide identity window; exhaustion is an allocation concern", () => {
		// The design bounds the window by POSIX identity space and by collision
		// with the host, not by a preferred capacity. A large declared window is
		// a deployment policy, and the registry's allocator is what reports
		// exhaustion (phase 2).
		const result = loadMultiuserConfig({ ...validEnv(), LH_ACCOUNT_UID_MIN: "30000", LH_ACCOUNT_UID_MAX: "200000" });
		assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
	});

	it("rejects a window that overlaps identities already present on the host", () => {
		const result = loadMultiuserConfig(validEnv(), { reservedUids: [30001], reservedGids: [32000] });
		assert.equal(result.ok, false);
		if (!result.ok) {
			if (!result.ok) assert.ok(result.errors.some((error) => /30001/.test(error)));
		}
	});

	it("rejects nested writable roots", () => {
		const result = loadMultiuserConfig({ ...validEnv(), LH_REGISTRY_DIR: "/data/accounts/registry" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => /separate, non-nested/.test(error)));
	});

	it("rejects an IPC endpoint inside an account-writable root", () => {
		const result = loadMultiuserConfig({ ...validEnv(), LH_CONTROLLER_IPC: "/data/accounts/controller.sock" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("LH_CONTROLLER_IPC")));
	});

	it("canonicalizes trailing slashes so containment checks cannot be bypassed", () => {
		// "/data/accounts/" and "/data/accounts" are the SAME path. Containment is
		// compared as `${root}/`, so an unnormalized trailing slash used to accept
		// a socket inside the account root and nested writable roots.
		const socket = loadMultiuserConfig({
			...validEnv(),
			LH_ACCOUNT_ROOT: "/data/accounts/",
			LH_CONTROLLER_IPC: "/data/accounts/controller.sock",
		});
		assert.equal(socket.ok, false, "a trailing slash must not hide a socket inside the account root");

		const nested = loadMultiuserConfig({ ...validEnv(), LH_ACCOUNT_ROOT: "/data/accounts/", LH_REGISTRY_DIR: "/data/accounts/registry" });
		assert.equal(nested.ok, false, "a trailing slash must not hide a nested writable root");

		const legacy = loadMultiuserConfig({ ...validEnv(), LH_ACCOUNT_ROOT: "/data/accounts/", LH_DATA_DIR: "/data/accounts/legacy/" });
		assert.equal(legacy.ok, false, "a trailing slash must not hide legacy data inside the account root");

		const canonical = loadMultiuserConfig({ ...validEnv(), LH_ACCOUNT_ROOT: "/data//accounts/" });
		assert.equal(canonical.ok, true, canonical.ok ? "" : canonical.errors.join("; "));
		if (canonical.ok) assert.equal(canonical.config.accountRoot, "/data/accounts");
	});

	it("rejects relative paths and the filesystem root", () => {
		for (const value of ["data/accounts", "/"]) {
			const result = loadMultiuserConfig({ ...validEnv(), LH_ACCOUNT_ROOT: value });
			assert.equal(result.ok, false, `${value} must be refused`);
		}
	});

	it("refuses a legacy data root that lives inside an account root", () => {
		const result = loadMultiuserConfig({ ...validEnv(), LH_DATA_DIR: "/data/accounts/legacy" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => /quarantined/.test(error)));
	});

	it("accepts the container's documented /data volume as the legacy parent", () => {
		// docker-compose.yml sets LH_DATA_DIR=/data while the account roots are
		// subdirectories of it. That is the shipped layout, not a fallback to
		// shared storage: the legacy records are quarantined by the Phase 7 claim.
		const result = loadMultiuserConfig({ ...validEnv(), LH_DATA_DIR: "/data" });
		assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
	});

	it("accepts a worker ceiling above the active-account ceiling", () => {
		// Policy, not contradiction: one account may run more than one admitted
		// worker, and the enforcing phase owns that relationship.
		const result = loadMultiuserConfig({
			...validEnv(),
			[GLOBAL_LIMIT_VARIABLES.activeAccounts]: "2",
			[GLOBAL_LIMIT_VARIABLES.activeWorkers]: "8",
		});
		assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
	});

	it("refuses a privileged web identity", () => {
		// Root ignores permission bits, so a declared 0 would make every ownership
		// and mode check vacuous while the gate still "passed".
		const root = loadMultiuserConfig({ ...validEnv(), LH_WEB_UID: "0", LH_WEB_GID: "0" });
		assert.equal(root.ok, false);
		if (!root.ok) assert.ok(root.errors.some((error) => /unprivileged/.test(error)));

		const rootGroup = loadMultiuserConfig({ ...validEnv(), LH_WEB_GID: "0" });
		assert.equal(rootGroup.ok, false);
	});

	it("requires a web identity outside the account window", () => {
		const inside = loadMultiuserConfig({ ...validEnv(), LH_WEB_UID: "30001" });
		assert.equal(inside.ok, false, "the web identity must not be an account identity");
		if (!inside.ok) assert.ok(inside.errors.some((error) => error.includes("LH_WEB_UID")));

		const ok = loadMultiuserConfig({ ...validEnv(), LH_WEB_UID: "1000", LH_WEB_GID: "1000" });
		assert.equal(ok.ok, true, ok.ok ? "" : ok.errors.join("; "));
		if (ok.ok) assert.deepEqual(ok.config.webIdentity, { uid: 1000, gid: 1000 });
	});

	it("refuses two IPC endpoints that alias one socket", () => {
		const result = loadMultiuserConfig({ ...validEnv(), LH_HELPER_IPC: "/run/lh/controller.sock" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => /separate endpoints/.test(error)));
	});

	it("applies the same containment rule to the legacy auth file", () => {
		const result = loadMultiuserConfig({ ...validEnv(), LH_AUTH_FILE: "/data/accounts/legacy/auth.json" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("LH_AUTH_FILE")));
	});

	it("refuses a relative legacy data path, which would resolve against the cwd", () => {
		const result = loadMultiuserConfig({ ...validEnv(), LH_DATA_DIR: "data" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => /absolute/.test(error)));
	});

	it("redacts credentials from the startup summary", () => {
		const result = loadMultiuserConfig(validEnv());
		assert.equal(result.ok, true);
		if (!result.ok) return;
		const serialized = JSON.stringify(redactedMultiuserSummary(result.config));
		assert.equal(serialized.includes(SECRET), false);
		assert.equal(serialized.includes(PUBLISHABLE), false);
		assert.match(serialized, /"secretKeyConfigured":true/);
		assert.match(serialized, /"publishableKeyConfigured":true/);
		assert.match(serialized, /"trustedOriginCount":2/);
		assert.equal(serialized.includes("learn.example.com"), false);
	});
});

describe("readiness facts", () => {
	it("parses mountinfo, unescaping kernel octal escapes", () => {
		const text = [
			"36 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw",
			"40 36 0:42 / /data rw,nosuid,nodev - tmpfs tmpfs rw",
			"41 40 0:43 / /data/private\\040work ro - tmpfs tmpfs ro",
			"malformed",
		].join("\n");
		const mounts = parseMountInfo(text);
		assert.deepEqual(
			mounts.map((mount) => mount.mountPoint),
			["/", "/data", "/data/private work"],
		);
		assert.equal(mounts[0]!.options.has("rw"), true);
		assert.equal(mounts[0]!.device, "8:1");
		assert.equal(mounts[0]!.sourceRoot, "/");
		assert.equal(mounts[1]!.device, "0:42");
		assert.equal(mounts[2]!.options.has("ro"), true);
	});

	it("reads the process's supplementary groups", () => {
		assert.deepEqual(parseProcessGroups("Pid: 42\nGroups:\t1000 1001 30005 \nState: S\n"), [1000, 1001, 30005]);
		assert.deepEqual(parseProcessGroups("Groups: \nState: S\n"), []);
		assert.equal(parseProcessGroups("Groups: malformed\n"), undefined);
		assert.equal(parseProcessGroups(""), undefined);
	});

	it("resolves the governing mount by longest prefix", () => {
		const mounts: MountEntry[] = ["/", "/data", "/data/staging"].map((mountPoint, index) => ({
			mountPoint,
			options: new Set([index === 2 ? "ro" : "rw"]),
			device: "8:1",
			sourceRoot: mountPoint,
		}));
		assert.equal(governingMount(mounts, "/data/staging/incoming")?.mountPoint, "/data/staging");
		assert.equal(governingMount(mounts, "/data/other")?.mountPoint, "/data");
		assert.equal(governingMount(mounts, "/tmp")?.mountPoint, "/");
	});

	it("counts ids from a passwd/group database", () => {
		assert.deepEqual(parseIdentityDatabase("root:x:0:0::/root:/bin/sh\n# comment\nnode:x:1000:1000::/home/node:/bin/sh\n"), [0, 1000]);
	});
});

/** Facts for a deployment that should pass every check. */
function readyFacts(): ReadinessFacts {
	const config = loadMultiuserConfig(validEnv());
	if (!config.ok) throw new Error(config.errors.join("; "));
	const directory = (uid: number, mode = 0o700): NodeFacts => ({ exists: true, isSymlink: false, isDirectory: true, uid, gid: uid, mode });
	return {
		mode: "multiuser-web",
		config: config.config,
		identity: { uid: config.config.webIdentity.uid, gid: config.config.webIdentity.gid, groups: [] },
		mounts: [
			{ mountPoint: "/", options: new Set(["ro"]), device: "0:1", sourceRoot: "/" },
			...["/data/accounts", "/data/registry", "/data/instance", "/data/staging", "/data/snapshots", "/data/private-work"].map(
				(mountPoint, index) => ({ mountPoint, options: new Set(["rw"]), device: "8:1", sourceRoot: `/root-${index}` }),
			),
		],
		nodes: {
			accountRoot: directory(0, 0o700),
			// Designated roots are service-owned (root), never owned by the web
			// identity and never by an account identity.
			registryDir: directory(0),
			instanceStateDir: directory(0),
			stagingDir: directory(0, 0o700),
			snapshotDir: directory(0, 0o700),
			privateWorkDir: directory(0, 0o700),
		},
		dockerSocketMounted: false,
	};
}

describe("readiness gate", () => {
	it("passes a fully isolated deployment", () => {
		const result = evaluateReadiness(readyFacts());
		assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
		if (result.ok) assert.ok(result.checks.every((entry) => entry.ok));
	});

	it("refuses a writable root filesystem", () => {
		const facts = readyFacts();
		const result = evaluateReadiness({ ...facts, mounts: facts.mounts.map((mount) => (mount.mountPoint === "/" ? { ...mount, options: new Set(["rw"]) } : mount)) });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => /read-only/.test(error)));
	});

	it("refuses shared writable mounts (a subdirectory pretending to be a mount)", () => {
		const facts = readyFacts();
		const result = evaluateReadiness({ ...facts, mounts: facts.mounts.filter((mount) => mount.mountPoint !== "/data/staging") });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("LH_STAGING_DIR")));
	});

	it("refuses a mounted Docker socket under either socket file name", () => {
		for (const mountPoint of ["/var/run/docker.sock", "/run/custom/docker.socket"]) {
			assert.equal(isDockerSocketMount({ mountPoint, options: new Set(["rw"]), device: "8:1", sourceRoot: "/" }), true);
		}
		assert.equal(isDockerSocketMount({ mountPoint: "/run/app.sock", options: new Set(["rw"]), device: "8:1", sourceRoot: "/" }), false);
		const facts = readyFacts();
		const result = evaluateReadiness({ ...facts, dockerSocketMounted: true });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => /Docker socket/.test(error)));
	});

	it("refuses several roots that are bind-mount aliases of one source", () => {
		const facts = readyFacts();
		const mounts = facts.mounts.map((mount) => ({ ...mount, device: "8:1", sourceRoot: "/same-host-directory" }));
		const result = evaluateReadiness({ ...facts, mounts });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("share one source") && error.includes("LH_ACCOUNT_ROOT")));
	});

	it("allows separate roots on one filesystem", () => {
		const result = evaluateReadiness(readyFacts());
		assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
	});

	it("refuses a symlinked or missing writable root", () => {
		const symlink = evaluateReadiness({
			...readyFacts(),
			nodes: { ...readyFacts().nodes, registryDir: { exists: true, isSymlink: true, isDirectory: false, uid: 1000, gid: 1000, mode: 0o700 } },
		});
		assert.equal(symlink.ok, false);
		const missing = evaluateReadiness({
			...readyFacts(),
			nodes: { ...readyFacts().nodes, snapshotDir: { exists: false, isSymlink: false, isDirectory: false, uid: -1, gid: -1, mode: 0 } },
		});
		assert.equal(missing.ok, false);
	});

	it("refuses world-writable and account-owned top-level roots", () => {
		const worldWritable = evaluateReadiness({
			...readyFacts(),
			nodes: { ...readyFacts().nodes, stagingDir: { exists: true, isSymlink: false, isDirectory: true, uid: 0, gid: 0, mode: 0o777 } },
		});
		assert.equal(worldWritable.ok, false);
		const accountOwned = evaluateReadiness({
			...readyFacts(),
			nodes: { ...readyFacts().nodes, registryDir: { exists: true, isSymlink: false, isDirectory: true, uid: 30_005, gid: 30_005, mode: 0o700 } },
		});
		assert.equal(accountOwned.ok, false);
		if (!accountOwned.ok) assert.ok(accountOwned.errors.some((error) => /account identity window/.test(error)));
	});

	it("refuses an account root the web identity can reach or modify", () => {
		// other-execute only: the web identity may traverse the account root.
		const traversable = evaluateReadiness({
			...readyFacts(),
			nodes: { ...readyFacts().nodes, accountRoot: { exists: true, isSymlink: false, isDirectory: true, uid: 0, gid: 0, mode: 0o755 } },
		});
		assert.equal(traversable.ok, false);

		// The regression this test exists for: a root:1000 0770 account root gives
		// the web identity group write, so it can rename or delete account homes.
		// The world-bits-only check used to accept this.
		const groupWritable = evaluateReadiness({
			...readyFacts(),
			nodes: { ...readyFacts().nodes, accountRoot: { exists: true, isSymlink: false, isDirectory: true, uid: 0, gid: 1000, mode: 0o770 } },
		});
		assert.equal(groupWritable.ok, false, "a group-writable account root must be refused");
		if (!groupWritable.ok) assert.ok(groupWritable.errors.some((error) => /access bits/.test(error)));

		// Group execute alone is already enough to enumerate and traverse.
		const groupTraversable = evaluateReadiness({
			...readyFacts(),
			nodes: { ...readyFacts().nodes, accountRoot: { exists: true, isSymlink: false, isDirectory: true, uid: 0, gid: 1000, mode: 0o750 } },
		});
		assert.equal(groupTraversable.ok, false);
	});

	it("refuses a designated root owned or modifiable by the web identity", () => {
		const owned = evaluateReadiness({
			...readyFacts(),
			nodes: { ...readyFacts().nodes, registryDir: { exists: true, isSymlink: false, isDirectory: true, uid: 1000, gid: 1000, mode: 0o700 } },
		});
		assert.equal(owned.ok, false, "a registry owned by the web identity must be refused");
		if (!owned.ok) assert.ok(owned.errors.some((error) => /web identity/.test(error)));

		const groupWritable = evaluateReadiness({
			...readyFacts(),
			nodes: { ...readyFacts().nodes, stagingDir: { exists: true, isSymlink: false, isDirectory: true, uid: 0, gid: 1000, mode: 0o770 } },
		});
		assert.equal(groupWritable.ok, false, "a staging root group-writable by the web identity must be refused");
	});

	it("requires every non-account root to be root-owned and exactly 0700", () => {
		for (const key of ["registryDir", "instanceStateDir", "stagingDir", "snapshotDir", "privateWorkDir"] as const) {
			const facts = readyFacts();
			const original = facts.nodes[key]!;
			for (const mode of [0o755, 0o750, 0o770]) {
				const result = evaluateReadiness({
					...facts,
					nodes: { ...facts.nodes, [key]: { ...original, mode } },
				});
				assert.equal(result.ok, false, `${key} with mode ${mode.toString(8)} must be refused`);
				if (!result.ok) assert.ok(result.errors.some((error) => error.includes("exactly mode 0700")));
			}
			const nonRoot = evaluateReadiness({ ...facts, nodes: { ...facts.nodes, [key]: { ...original, uid: 1001, gid: 1001 } } });
			assert.equal(nonRoot.ok, false, `${key} must be root-owned`);
		}
	});

	it("seals the account root against the web process's supplementary groups", () => {
		// The regression is evaluated through the real process identity, not just a
		// permissive isolated helper call: gid 1001 grants mode 0770 to this web.
		const facts = readyFacts();
		const result = evaluateReadiness({
			...facts,
			identity: { ...facts.identity, groups: [1001] },
			nodes: { ...facts.nodes, accountRoot: { ...facts.nodes.accountRoot!, gid: 1001, mode: 0o770 } },
		});
		assert.equal(result.ok, false, "a supplementary-group-writable account root must be refused");
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("access bits 7")));
	});

	it("refuses supplementary groups that overlap the account identity window", () => {
		const result = inspectReadiness({ ...validEnv(), LH_WEB_UID: "1000", LH_WEB_GID: "1000" }, { uid: 1000, gid: 1000, groups: [30005] });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("account-window supplementary groups 30005")));
	});

	it("refuses to report success for any mode other than multiuser-web", () => {
		const result = evaluateReadiness({ ...readyFacts(), mode: "desktop" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => /multiuser-web/.test(error)));
	});

	it("refuses real startup on this machine, where no multiuser deployment exists", () => {
		// The test host is a dev checkout: mode defaults to single-user and the
		// designated roots do not exist. The gate must say no, never assume yes.
		const result = inspectReadiness({});
		assert.equal(result.ok, false);
		assert.ok(result.errors.length > 0);
		assert.equal(result.errors.join(" ").includes("sk_"), false);
	});

	it("refuses real startup for an invalid explicit mode", () => {
		const result = inspectReadiness({ LH_DEPLOYMENT_MODE: "nonsense" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => /LH_DEPLOYMENT_MODE/.test(error)));
	});

	it("refuses real startup for an incomplete multiuser-web environment", () => {
		const result = inspectReadiness({ LH_DEPLOYMENT_MODE: "multiuser-web" });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => error.includes("CLERK_SECRET_KEY")));
	});

	it("refuses a declared web identity the process does not actually run as", () => {
		// Declaring an identity only protects anything if it is the real one.
		const result = inspectReadiness({ ...validEnv(), LH_WEB_UID: "1000", LH_WEB_GID: "1000" }, { uid: 0, gid: 0, groups: [] });
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.errors.some((error) => /actually runs as/.test(error)));
	});

	it("refuses to judge permissions when the process identity is unknown", () => {
		// Every permission check below would be meaningless without the actual
		// UID/GID/group set, so it must refuse instead of silently skipping.
		for (const identity of [{ uid: -1, gid: -1, groups: [] }, { uid: 1000, gid: 1000, groups: undefined }]) {
			const result = inspectReadiness({ ...validEnv() }, identity);
			assert.equal(result.ok, false);
			if (!result.ok) assert.ok(result.errors.some((error) => /cannot be determined/.test(error)));
		}
	});
});
