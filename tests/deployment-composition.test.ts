/**
 * Composition-root separation (per-user-accounts phase 1).
 *
 * The design's Phase 1 resolution step is a behavioral claim about PROCESSES:
 * desktop/single-user still open the original local stores, while multiuser-web
 * refuses to run with the global composition root or without its mount
 * controls. Deployment mode is module-load-bound, so every assertion here runs
 * in a fresh child process with a throwaway data/auth profile.
 *
 * The real Docker UID/GID and mount evidence stays with the Phase 3 gate (A13);
 * this test proves the dispatch, the refusal, and the untouched default paths.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const PROBE = path.resolve("tests/helpers/composition-root-probe.ts");
const SECRET = "sk_test_PROBESECRETVALUE";
const PUBLISHABLE = "pk_test_PROBEPUBLICVALUE";

let TMP = "";

before(() => {
	TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-composition-root-"));
});

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

/** A throwaway environment: never point a test at a live data/auth profile. */
function probeEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: TMP,
		USERPROFILE: TMP,
		NODE_ENV: "test",
		NODE_OPTIONS: "",
		// The hook only acts in Next's Node.js runtime; the probe simulates it.
		NEXT_RUNTIME: "nodejs",
		LH_DATA_DIR: path.join(TMP, "data"),
		LH_AUTH_FILE: path.join(TMP, "auth.json"),
		LH_IGNORE_ENV_KEYS: "0",
	};
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

interface ProbeResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	report: { ok: boolean; storeKeys?: string[]; error?: string; registered?: boolean } | undefined;
	output: string;
}

function runProbe(name: string, env: Record<string, string | undefined> = {}): ProbeResult {
	const result = spawnSync(process.execPath, ["--import", "tsx", PROBE, name], {
		cwd: process.cwd(),
		env: probeEnv(env),
		encoding: "utf8",
		timeout: 60_000,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop();
	let report: ProbeResult["report"];
	try {
		report = line ? JSON.parse(line) : undefined;
	} catch {
		report = undefined;
	}
	return { status: result.status, signal: result.signal, report, output };
}

const EXPECTED_STORE_KEYS = ["chatStore", "graphStore", "jobStore", "settingsStore", "sourceOrganizationStore", "studyStore", "themeStore"];

describe("desktop and single-user keep the original composition root", () => {
	it("serves the local store set through the relay by default", () => {
		const result = runProbe("relay");
		assert.equal(result.status, 0, result.output);
		assert.equal(result.report?.ok, true, result.output);
		assert.deepEqual(result.report?.storeKeys, EXPECTED_STORE_KEYS);
	});

	it("serves the same store set when the Electron shell launched the process", () => {
		const result = runProbe("relay", { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "a".repeat(64) });
		assert.equal(result.status, 0, result.output);
		assert.deepEqual(result.report?.storeKeys, EXPECTED_STORE_KEYS);
	});

	it("initializes plugins in-process for the single-user profile", () => {
		const result = runProbe("instrumentation", { LH_DATA_DIR: path.join(TMP, "data-instrumentation") });
		assert.equal(result.status, 0, result.output);
		assert.equal(result.report?.registered, true, result.output);
	});

	it("warns that Clerk keys are inert outside multiuser-web", () => {
		// Silent inertness is the trap: an operator who exports Clerk keys into a
		// single-user profile must be told accounts are NOT active.
		const result = runProbe("instrumentation", {
			LH_DATA_DIR: path.join(TMP, "data-clerk-warning"),
			CLERK_SECRET_KEY: SECRET,
			NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PUBLISHABLE,
		});
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /Clerk authentication is inactive/);
		// The warning names the variables, never their values.
		assert.equal(result.output.includes(SECRET), false);
		assert.equal(result.output.includes(PUBLISHABLE), false);
	});
});

describe("multiuser-web refuses the shared composition root", () => {
	const multiuserEnv = {
		LH_DEPLOYMENT_MODE: "multiuser-web",
		CLERK_SECRET_KEY: SECRET,
		NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PUBLISHABLE,
	};

	it("refuses to load the global stores module", () => {
		const result = runProbe("stores", multiuserEnv);
		assert.notEqual(result.status, 0, "the shared composition root must not load in multiuser-web");
		assert.equal(result.report?.ok, false);
		assert.match(result.report?.error ?? "", /must not load in multiuser-web/);
		// The refusal mentions the remedy (the relay), and never leaks a secret.
		assert.match(result.report?.error ?? "", /account relay/);
		assert.equal(result.output.includes(SECRET), false);
	});

	it("refuses the relay instead of falling back to shared stores", () => {
		const result = runProbe("relay", multiuserEnv);
		assert.notEqual(result.status, 0);
		assert.equal(result.report?.ok, false);
		assert.match(result.report?.error ?? "", /AccountRelayUnavailableError/);
		assert.match(result.report?.error ?? "", /refusing to fall back to shared stores/i);
		assert.equal(result.report?.storeKeys, undefined);
	});

	it("exits the process when readiness fails (missing mount controls and limits)", () => {
		// A complete Clerk surface but none of the mandatory resource limits and
		// none of the designated mounts: startup must refuse, not degrade.
		const result = runProbe("instrumentation", multiuserEnv);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /REFUSING TO START/);
		assert.match(result.output, /LH_ACCOUNT_MAX_PROCESSES/);
		assert.equal(result.output.includes(SECRET), false);
		assert.equal(result.output.includes(PUBLISHABLE), false);
	});

	it("never initializes global plugins in the refusing profile", () => {
		const result = runProbe("instrumentation", multiuserEnv);
		assert.equal(result.status, 1);
		assert.equal(/\[plugins\]/.test(result.output), false);
	});

	it("allows the build phase to import route modules (no server is running)", () => {
		// `next build` collects page data in the build environment; a build host may
		// export the deployment mode for its compose file. Nothing is served.
		const result = runProbe("stores", { ...multiuserEnv, NEXT_PHASE: "phase-production-build" });
		assert.equal(result.status, 0, result.output);
		assert.deepEqual(result.report?.storeKeys, EXPECTED_STORE_KEYS);
	});
});

describe("an invalid deployment selection is a refusal, never a fallback", () => {
	// A typo must not be downgraded to the shared-storage profile: that would
	// serve one process the whole instance's records to an operator who asked
	// for per-account isolation.
	const typo = { LH_DEPLOYMENT_MODE: "multiuser-webb" };

	it("refuses to load the shared composition root", () => {
		const result = runProbe("stores", typo);
		assert.notEqual(result.status, 0, "an invalid mode must not open the shared stores");
		assert.equal(result.report?.ok, false);
		assert.match(result.report?.error ?? "", /LH_DEPLOYMENT_MODE/);
		assert.equal(result.report?.storeKeys, undefined);
	});

	it("exits at startup instead of serving", () => {
		const result = runProbe("instrumentation", typo);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /REFUSING TO START/);
		assert.match(result.output, /LH_DEPLOYMENT_MODE/);
		assert.equal(/\[plugins\]/.test(result.output), false);
	});

	it("refuses through the relay too", () => {
		const result = runProbe("relay", typo);
		assert.notEqual(result.status, 0);
		assert.match(result.report?.error ?? "", /AccountRelayUnavailableError/);
	});

	it("still lets the build phase import route modules", () => {
		const result = runProbe("stores", { ...typo, NEXT_PHASE: "phase-production-build" });
		assert.equal(result.status, 0, result.output);
	});
});
