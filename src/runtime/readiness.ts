/**
 * MULTIUSER STARTUP READINESS (per-user accounts, Phase 1, 2026-11-12).
 *
 * Phase 1 is a security gate, not a feature toggle. A process selected as
 * `multiuser-web` must prove that the host supplied a valid configuration,
 * a read-only root filesystem declaration, designated writable mounts, and
 * private runtime directories. Missing mandatory controls throw during
 * startup; there is no fallback to the shared-storage composition.
 *
 * Ownership/mode checks are reported from this milestone onward but become
 * MANDATORY only when the Phase 3 root helper owns account-home creation.
 * Until then the strict checks are advisories, labelled as such in the report
 * so an operator cannot mistake them for satisfied isolation.
 */

import fs from "node:fs";
import type { DeploymentMode } from "./deployment-mode.ts";
import type { MultiuserConfig, MultiuserConfigResult } from "./multiuser-config.ts";

export interface ReadinessCheck {
	code: string;
	ok: boolean;
	mandatory: boolean;
	message: string;
}

export interface ReadinessReport {
	ok: boolean;
	checks: ReadinessCheck[];
}

export interface ReadinessEntry {
	isDirectory: boolean;
	isSymbolicLink: boolean;
	mode: number;
	uid: number;
}

export interface ReadinessDeps {
	lstat?: (file: string) => ReadinessEntry;
	getuid?: () => number;
	mkdir?: (directory: string) => void;
}

export class ReadinessError extends Error {
	readonly codes: string[];

	constructor(codes: string[]) {
		super(`Multiuser readiness failed: ${codes.join(", ")}`);
		this.name = "ReadinessError";
		this.codes = codes;
	}
}

function defaultLstat(file: string): ReadinessEntry {
	const stat = fs.lstatSync(file);
	return {
		isDirectory: stat.isDirectory(),
		isSymbolicLink: stat.isSymbolicLink(),
		mode: stat.mode & 0o777,
		uid: stat.uid,
	};
}

function check(
	checks: ReadinessCheck[],
	code: string,
	ok: boolean,
	message: string,
	mandatory = true,
): void {
	checks.push({ code, ok, mandatory, message });
}

function inspectDirectory(
	checks: ReadinessCheck[],
	code: string,
	label: string,
	directory: string,
	deps: Required<Pick<ReadinessDeps, "lstat">>,
): ReadinessEntry | undefined {
	let entry: ReadinessEntry;
	try {
		entry = deps.lstat(directory);
	} catch {
		check(checks, `${code}_missing`, false, `${label} does not exist.`);
		return undefined;
	}
	check(checks, `${code}_directory`, entry.isDirectory && !entry.isSymbolicLink, `${label} must be a real directory, not a symlink.`);
	return entry;
}

/**
 * Pure readiness evaluation. No directory is created here; use
 * prepareLocalDevelopmentDirectories for the explicit offline simulation.
 */
export function evaluateReadiness(
	mode: DeploymentMode,
	loaded: MultiuserConfigResult,
	deps: ReadinessDeps = {},
): ReadinessReport {
	const checks: ReadinessCheck[] = [];
	if (mode !== "multiuser-web") {
		check(checks, "mode_single_user", true, "Single-user/desktop mode uses the existing local composition root.");
		return { ok: true, checks };
	}

	check(checks, "mode_multiuser", true, "An explicit multiuser-web composition root is selected.");

	if (!loaded.ok) {
		check(
			checks,
			"config_valid",
			false,
			`Multiuser configuration is invalid: ${loaded.issues.map((entry) => entry.code).join(", ")}.`,
		);
		return { ok: false, checks };
	}
	const config = loaded.config;
	check(checks, "config_valid", true, "Multiuser configuration is valid.");
	check(checks, "read_only_root", config.readOnlyRootFilesystem, "A read-only root filesystem is required.");
	check(checks, "writable_mounts", config.writableMounts.length > 0, "Designated writable mounts are required.");

	const lstat = deps.lstat ?? defaultLstat;
	const getuid = deps.getuid ?? (() => process.getuid?.() ?? -1);

	const directories: Array<[string, string, string]> = [
		["account_root", "Account root", config.paths.accountRoot],
		["controller_state", "Controller state directory", config.paths.controllerStateDir],
		["upload_staging", "Upload staging directory", config.paths.stagingDir],
		["snapshots", "Snapshot directory", config.paths.snapshotDir],
		["private_work", "Private working directory", config.paths.privateWorkDir],
	];

	let accountRootEntry: ReadinessEntry | undefined;
	let controllerEntry: ReadinessEntry | undefined;
	for (const [code, label, directory] of directories) {
		const entry = inspectDirectory(checks, code, label, directory, { lstat });
		if (code === "account_root") accountRootEntry = entry;
		if (code === "controller_state") controllerEntry = entry;
	}

	const self = getuid();
	if (accountRootEntry) {
		check(
			checks,
			"account_root_permissions",
			(accountRootEntry.mode & 0o077) === 0,
			"ADVISORY (Phase 3 mandatory): the account root must deny group/other access.",
			false,
		);
		check(
			checks,
			"account_root_owner",
			accountRootEntry.uid !== self,
			"ADVISORY (Phase 3 mandatory): the account root must be owned by the root helper, not the web identity.",
			false,
		);
	}
	if (controllerEntry) {
		check(
			checks,
			"controller_state_permissions",
			(controllerEntry.mode & 0o077) === 0,
			"ADVISORY (Phase 3 mandatory): controller state must be private to the controller identity.",
			false,
		);
	}

	return { ok: checks.every((entry) => !entry.mandatory || entry.ok), checks };
}

/** Startup gate. Throws with stable codes; never prints a secret value. */
export function assertReady(mode: DeploymentMode, loaded: MultiuserConfigResult, deps: ReadinessDeps = {}): ReadinessReport {
	const report = evaluateReadiness(mode, loaded, deps);
	if (!report.ok) {
		throw new ReadinessError(report.checks.filter((entry) => entry.mandatory && !entry.ok).map((entry) => entry.code));
	}
	return report;
}

/**
 * OFFLINE SIMULATION ONLY. The local auth provider is the development/offline
 * stand-in for Clerk; it needs its runtime directories to exist before the
 * first request. Production Clerk deployments must provide root-owned,
 * host-created mounts instead (Phase 3 helper).
 */
export function prepareLocalDevelopmentDirectories(config: MultiuserConfig, deps: ReadinessDeps = {}): void {
	if (config.auth.provider !== "local") return;
	const mkdir = deps.mkdir ?? ((directory: string) => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); });
	for (const directory of Object.values(config.paths)) {
		mkdir(directory);
	}
}
