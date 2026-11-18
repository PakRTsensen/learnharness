/**
 * MULTI-USER WEB READINESS (per-user-accounts phase 1).
 *
 * The design makes public multi-user startup FAIL CLOSED: if the deployment
 * cannot prove its isolation prerequisites, it must refuse to serve instead of
 * falling back to shared storage. This module is the check list.
 *
 * Everything here is a pure function over INJECTED host facts (mount table,
 * ownership/mode records, passwd/group text). `inspectReadiness()` supplies the
 * real ones from `/proc/self/mountinfo`, `fs.lstatSync`, `/etc/passwd`, and
 * `/etc/group`. Keeping the decision logic separate from the syscalls is what
 * lets the readiness tests run without a Docker host, while A13 still proves
 * the same checks inside the real image.
 *
 * Checks implemented here:
 *   • the deployment mode is `multiuser-web`;
 *   • the multiuser configuration parses (see multiuser-config.ts);
 *   • the container root filesystem is mounted read-only;
 *   • every writable root has its own mount point and source;
 *   • writable roots exist, are real directories, and are not account-owned;
 *   • non-account roots are root-owned with mode exactly 0700;
 *   • the account root grants no access to the web identity, including through
 *     its supplementary groups;
 *   • no Docker socket is mounted, under either .sock or .socket spelling;
 *   • the UID/GID window does not collide with identities already on the host.
 *
 * Deliberately NOT here: launching the controller/helper (Phase 3) and enabling
 * routes (Phase 7). Readiness only decides whether the process may start.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";

import {
	CLERK_VARIABLES,
	DEPLOYMENT_MODE_VARIABLE,
	selectDeploymentMode,
	type DeploymentEnvironment,
	type DeploymentMode,
} from "./deployment-mode.ts";
import {
	LAYOUT_VARIABLES,
	WEB_IDENTITY_VARIABLES,
	loadMultiuserConfig,
	redactedMultiuserSummary,
	type MultiuserConfig,
} from "./multiuser-config.ts";

/** One mount table row, reduced to what readiness needs. */
export interface MountEntry {
	/** Absolute, normalized mount point. */
	mountPoint: string;
	/** Mount options (`ro`, `rw`, `nosuid`, …) from the per-mount field. */
	options: ReadonlySet<string>;
	/** Device major:minor from mountinfo; identifies the filesystem. */
	device: string;
	/** Root within that filesystem, used with `device` to identify the source. */
	sourceRoot: string;
}

/** What readiness knows about one filesystem node. */
export interface NodeFacts {
	exists: boolean;
	isSymlink: boolean;
	isDirectory: boolean;
	uid: number;
	gid: number;
	/** Permission bits only (e.g. 0o755). */
	mode: number;
}

export interface ReadinessFacts {
	mode: DeploymentMode;
	config: MultiuserConfig;
	/** The process identity already cross-checked against config.webIdentity. */
	identity: ProcessIdentity;
	mounts: readonly MountEntry[];
	/** Node facts by the LAYOUT_VARIABLES keys readiness inspects. */
	nodes: Partial<Record<keyof typeof LAYOUT_VARIABLES, NodeFacts>>;
	/** True when /var/run/docker.sock (or a docker.sock) is visible in the mount table. */
	dockerSocketMounted: boolean;
}

export type ReadinessCheck = { id: string; ok: boolean; detail: string };

export type ReadinessResult =
	| { ok: true; checks: ReadinessCheck[]; warnings: string[]; config: MultiuserConfig }
	| { ok: false; checks: ReadinessCheck[]; errors: string[]; warnings: string[] };

/** Parse `/proc/self/mountinfo`. Malformed lines are skipped, never fatal. */
export function parseMountInfo(text: string): MountEntry[] {
	const entries: MountEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		// Fields are space-separated; the optional field block sits between the
		// mount options (field 6) and the literal "-" separator.
		const fields = line.split(" ");
		if (fields.length < 7) continue;
		const device = fields[2]?.trim() ?? "";
		const sourceRoot = unescapeMountField(fields[3] ?? "");
		const mountPoint = unescapeMountField(fields[4] ?? "");
		const options = new Set((fields[5] ?? "").split(",").filter(Boolean));
		if (!device || !sourceRoot.startsWith("/") || !mountPoint) continue;
		entries.push({ mountPoint, options, device, sourceRoot });
	}
	return entries;
}

/** The kernel escapes space, tab, newline, and backslash as octal in mountinfo. */
function unescapeMountField(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** The mount entry that governs `target` (longest matching mount point). */
export function governingMount(mounts: readonly MountEntry[], target: string): MountEntry | undefined {
	let best: MountEntry | undefined;
	for (const mount of mounts) {
		const matches = target === mount.mountPoint || target.startsWith(`${mount.mountPoint === "/" ? "" : mount.mountPoint}/`);
		if (!matches) continue;
		if (!best || mount.mountPoint.length > best.mountPoint.length) best = mount;
	}
	return best;
}

/** Count colon-separated id databases (passwd/group) into an id set. */
export function parseIdentityDatabase(text: string): number[] {
	const ids: number[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		const fields = line.split(":");
		const id = Number(fields[2]);
		if (Number.isInteger(id) && id >= 0) ids.push(id);
	}
	return ids;
}

function check(id: string, ok: boolean, detail: string): ReadinessCheck {
	return { id, ok, detail };
}

const WRITABLE_ROOT_KEYS = [
	"registryDir",
	"instanceStateDir",
	"stagingDir",
	"snapshotDir",
	"privateWorkDir",
] as const;

const WRITABLE_MOUNT_KEYS = ["accountRoot", ...WRITABLE_ROOT_KEYS] as const;

/**
 * The permission bits the web identity actually receives on a node, following
 * POSIX ownership precedence: owner bits when it owns the node, group bits when
 * only the group matches, other bits otherwise.
 */
export function webAccessBits(node: Pick<NodeFacts, "uid" | "gid" | "mode">, web: { uid: number; gid: number; groups?: readonly number[] }): number {
	if (node.uid === web.uid) return (node.mode >> 6) & 0o7;
	if (node.gid === web.gid || web.groups?.includes(node.gid)) return (node.mode >> 3) & 0o7;
	return node.mode & 0o7;
}

/** Read=4, write=2, execute=1. */
const ACCESS_WRITE = 0o2;
const ACCESS_EXECUTE = 0o1;

/**
 * Decide readiness from injected facts. Never throws.
 */
export function evaluateReadiness(facts: ReadinessFacts): ReadinessResult {
	const checks: ReadinessCheck[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];

	checks.push(
		check(
			"deployment-mode",
			facts.mode === "multiuser-web",
			facts.mode === "multiuser-web"
				? `${DEPLOYMENT_MODE_VARIABLE}=multiuser-web`
				: `deployment mode is ${facts.mode}; multiuser-web requires an explicit ${DEPLOYMENT_MODE_VARIABLE}=multiuser-web`,
		),
	);

	// 1) Read-only container root. A writable root filesystem would let any
	//    compromised service rewrite the helper/worker executables.
	const rootMount = facts.mounts.find((mount) => mount.mountPoint === "/");
	const rootReadOnly = Boolean(rootMount?.options.has("ro"));
	checks.push(
		check(
			"root-filesystem-read-only",
			rootReadOnly,
			rootReadOnly ? "container root is mounted ro" : "the container root filesystem must be mounted read-only",
		),
	);

	// 2) Designated writable mounts are distinct mount points. Entries that are
	//    merely subdirectories of /data would share one quota/failure domain,
	//    which the design explicitly forbids as a fallback.
	const mountPoints = new Set(facts.mounts.map((mount) => mount.mountPoint));
	const subdirectoryRoots = WRITABLE_MOUNT_KEYS.filter((key) => {
		const value = facts.config[key];
		return mountPoints.has(value) === false;
	});
	checks.push(
		check(
			"writable-mounts-designated",
			subdirectoryRoots.length === 0,
			subdirectoryRoots.length === 0
				? "every writable root is its own mount point"
				: `not separate mount points: ${subdirectoryRoots.map((key) => LAYOUT_VARIABLES[key].name).join(", ")}`,
		),
	);

	// 3) Every root exists, is a real directory, and is not account-owned.
	for (const key of WRITABLE_MOUNT_KEYS) {
		const factsForNode = facts.nodes[key];
		const name = LAYOUT_VARIABLES[key].name;
		if (!factsForNode?.exists) {
			const detail = `${name} does not exist; the deployment must create and mount it`;
			checks.push(check(`root-present:${key}`, false, detail));
			errors.push(detail);
			continue;
		}
		if (factsForNode.isSymlink) {
			const detail = `${name} is a symlink; account roots must be real directories beneath the fixed root`;
			checks.push(check(`root-real-directory:${key}`, false, detail));
			errors.push(detail);
			continue;
		}
		if (!factsForNode.isDirectory) {
			const detail = `${name} is not a directory`;
			checks.push(check(`root-real-directory:${key}`, false, detail));
			errors.push(detail);
			continue;
		}
		checks.push(check(`root-real-directory:${key}`, true, `${name} is a real directory`));

		// What matters is not "world-writable" in the abstract but whether the
		// UNPRIVILEGED WEB IDENTITY can write or replace entries here. Group bits
		// count whenever the web GID matches, which is exactly the case the
		// world-bits-only check missed (a root:1000 0770 root is web-writable).
		const web = facts.identity;
		const access = webAccessBits(factsForNode, web);
		const webWritable = (access & ACCESS_WRITE) !== 0;
		const writableDetail = webWritable
			? `${name} is writable by the web identity ${web.uid}:${web.gid} (mode ${factsForNode.mode.toString(8)}); a top-level root must exclude it`
			: `${name} is not writable by the web identity`;
		checks.push(check(`root-not-web-writable:${key}`, !webWritable, writableDetail));
		if (webWritable) errors.push(writableDetail);

		if (key !== "accountRoot") {
			const rootOwned = factsForNode.uid === 0;
			const sealed = factsForNode.mode === 0o700;
			const detail = !rootOwned
				? `${name} must be root-owned`
				: !sealed
					? `${name} has mode ${factsForNode.mode.toString(8)}; a non-account root must have exactly mode 0700 so no service, controller, provider, or parser peer can read or traverse it`
					: `${name} is root-owned with mode 0700`;
			checks.push(check(`root-private:${key}`, rootOwned && sealed, detail));
			if (!rootOwned || !sealed) errors.push(detail);
		}

		const { uidRange, gidRange } = facts.config;
		const ownedByWeb = factsForNode.uid === web.uid || factsForNode.gid === web.gid;
		if (ownedByWeb) {
			const detail = `${name} is owned by the web identity ${factsForNode.uid}:${factsForNode.gid}; a top-level root must be owned by the service identity`;
			checks.push(check(`root-not-web-owned:${key}`, false, detail));
			errors.push(detail);
		} else {
			checks.push(check(`root-not-web-owned:${key}`, true, `${name} is not owned by the web identity`));
		}

		if ((factsForNode.uid >= uidRange.min && factsForNode.uid <= uidRange.max) || (factsForNode.gid >= gidRange.min && factsForNode.gid <= gidRange.max)) {
			const detail = `${name} is owned by ${factsForNode.uid}:${factsForNode.gid}, inside the account identity window; a top-level root must be owned by the service identity`;
			checks.push(check(`root-not-account-owned:${key}`, false, detail));
			errors.push(detail);
		} else {
			checks.push(check(`root-not-account-owned:${key}`, true, `${name} is not account-owned`));
		}
	}

	// 4) The account root must be root-owned AND deny every access the web
	//    identity could use: traversal (execute) and content listing/creation
	//    (read/write). Checking only the other-execute bit accepted a
	//    root:1000 0770 account root, letting the web process rename or delete
	//    account homes.
	const accountRootFacts = facts.nodes.accountRoot;
	if (accountRootFacts?.exists) {
		const web = facts.identity;
		const rootOwned = accountRootFacts.uid === 0;
		const webBits = webAccessBits(accountRootFacts, web);
		const deniesWeb = webBits === 0;
		const detail = !rootOwned
			? "the account root must be owned by root"
			: deniesWeb
				? `account root is root-owned and grants the web identity no access (mode ${accountRootFacts.mode.toString(8)})`
				: `the account root grants the web identity ${web.uid}:${web.gid} access bits ${webBits.toString(8)} (mode ${accountRootFacts.mode.toString(8)}); it must grant none`;
		checks.push(check("account-root-sealed", rootOwned && deniesWeb, detail));
		if (!rootOwned || !deniesWeb) errors.push(detail);
	}

	// 5) Distinct mount points are insufficient for bind mounts: six aliases of
	//    one host directory still share every file, quota, and failure domain.
	const sources = new Map<string, string[]>();
	for (const key of WRITABLE_MOUNT_KEYS) {
		const mount = facts.mounts.find((entry) => entry.mountPoint === facts.config[key]);
		if (!mount) continue;
		const source = `${mount.device}:${mount.sourceRoot}`;
		const roots = sources.get(source) ?? [];
		roots.push(LAYOUT_VARIABLES[key].name);
		sources.set(source, roots);
	}
	const aliasedSources = [...sources.values()].filter((roots) => roots.length > 1);
	const mountsDistinct = aliasedSources.length === 0;
	const mountDetail = mountsDistinct
		? "designated writable mounts have distinct filesystem sources"
		: `designated writable mounts share one source: ${aliasedSources.map((roots) => roots.join(", ")).join("; ")}`;
	checks.push(check("writable-mount-sources-distinct", mountsDistinct, mountDetail));
	if (!mountsDistinct) errors.push(mountDetail);

	// 6) Never mount the Docker socket: it is a host-root escape path.
	checks.push(
		check(
			"docker-socket-absent",
			!facts.dockerSocketMounted,
			facts.dockerSocketMounted
				? "the Docker socket is mounted into the application container; remove it"
				: "no Docker socket is mounted",
		),
	);
	if (facts.dockerSocketMounted) errors.push("the Docker socket must never be mounted into the application container.");

	// 7) IPC endpoints must live outside every account-writable root.
	const socketsInsideRoots = (["controllerIpc", "helperIpc"] as const).filter((key) => {
		const socket = facts.config[key];
		return WRITABLE_MOUNT_KEYS.some((rootKey) => socket.startsWith(`${facts.config[rootKey]}/`));
	});
	checks.push(
		check(
			"ipc-outside-account-roots",
			socketsInsideRoots.length === 0,
			socketsInsideRoots.length === 0
				? "IPC endpoints are outside every writable root"
				: `IPC endpoints inside writable roots: ${socketsInsideRoots.map((key) => LAYOUT_VARIABLES[key].name).join(", ")}`,
		),
	);
	if (socketsInsideRoots.length) errors.push("IPC endpoints must not live inside an account-writable root.");

	const failed = checks.filter((entry) => !entry.ok);
	if (failed.length) {
		for (const entry of failed) if (!errors.includes(entry.detail)) errors.push(entry.detail);
		return { ok: false, checks, errors: [...new Set(errors)], warnings };
	}
	return { ok: true, checks, warnings, config: facts.config };
}

/**
 * Resolve the mode, parse the configuration, and inspect the host. This is the
 * function a startup path calls; it never throws and never logs secrets.
 */
export interface ProcessIdentity {
	uid: number;
	gid: number;
	/** Undefined means the host could not report its supplementary groups. */
	groups: readonly number[] | undefined;
}

/** Read the supplementary group IDs, distinguishing none from unavailable. */
export function parseProcessGroups(status: string): number[] | undefined {
	const list = status.match(/^Groups:[ \t]*(.*)$/m)?.[1]?.trim();
	if (list === undefined) return undefined;
	if (list === "") return [];
	const groups = list.split(/\s+/).map(Number);
	return groups.every((group) => Number.isInteger(group) && group >= 0) ? groups : undefined;
}

/** The identity this process actually runs as, including supplementary groups. */
export function currentProcessIdentity(): ProcessIdentity {
	const groups = parseProcessGroups(safeRead("/proc/self/status") ?? "");
	return { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, groups };
}

export function inspectReadiness(
	env: DeploymentEnvironment = process.env,
	identity: ProcessIdentity = currentProcessIdentity(),
): ReadinessResult {
	const selection = selectDeploymentMode(env);
	const warnings = [...selection.warnings];

	if (!selection.ok) {
		return {
			ok: false,
			checks: [check("deployment-mode", false, selection.error)],
			errors: [selection.error],
			warnings,
		};
	}

	if (selection.mode !== "multiuser-web") {
		// Other profiles are deliberately not "ready" for multi-user serving; they
		// simply do not use this gate. Saying so prevents a caller from treating a
		// desktop/single-user result as proof of multi-user isolation.
		const detail = `deployment mode is ${selection.mode}; the multi-user readiness gate applies only to multiuser-web`;
		return { ok: false, checks: [check("deployment-mode", false, detail)], errors: [detail], warnings };
	}

	const mountInfo = safeRead("/proc/self/mountinfo");
	const mounts = mountInfo ? parseMountInfo(mountInfo) : [];
	const reservedUids = parseIdentityDatabase(safeRead("/etc/passwd") ?? "");
	const reservedGids = parseIdentityDatabase(safeRead("/etc/group") ?? "");
	const loaded = loadMultiuserConfig(env, { reservedUids, reservedGids });
	if (!loaded.ok) {
		return { ok: false, checks: [check("multiuser-config", false, loaded.errors.join(" "))], errors: loaded.errors, warnings };
	}

	// A DECLARED identity the process does not actually have makes every
	// permission check below meaningless: an operator could declare 1000 while
	// the server runs as 0 or 1001, and the roots would be judged against the
	// wrong identity. Declaring is only useful when it is enforced.
	//
	// An UNKNOWN identity (no `getuid`, i.e. a non-POSIX host) is refused rather
	// than skipped: multiuser-web is a Linux isolation profile, and a gate that
	// silently drops its own identity check would be worse than no gate.
	const { webIdentity } = loaded.config;
	if (identity.uid < 0 || identity.gid < 0 || identity.groups === undefined) {
		const detail = `the process identity cannot be determined on this host; ${DEPLOYMENT_MODE_VARIABLE}=multiuser-web requires a POSIX host with per-process UID/GID and readable supplementary groups`;
		return { ok: false, checks: [check("web-identity-matches-process", false, detail)], errors: [detail], warnings };
	}
	if (identity.uid !== webIdentity.uid) {
		const detail = `this process runs as uid ${identity.uid} but ${WEB_IDENTITY_VARIABLES.uid} declares ${webIdentity.uid}; the web identity must be the identity the server actually runs as`;
		return { ok: false, checks: [check("web-identity-matches-process", false, detail)], errors: [detail], warnings };
	}
	if (identity.gid !== webIdentity.gid) {
		const detail = `this process runs as gid ${identity.gid} but ${WEB_IDENTITY_VARIABLES.gid} declares ${webIdentity.gid}; the web identity must be the identity the server actually runs as`;
		return { ok: false, checks: [check("web-identity-matches-process", false, detail)], errors: [detail], warnings };
	}

	const accountGroups = identity.groups.filter((gid) => gid >= loaded.config.gidRange.min && gid <= loaded.config.gidRange.max);
	if (accountGroups.length > 0) {
		const detail = `the web process has account-window supplementary groups ${accountGroups.join(", ")}; these must be dropped before startup`;
		return { ok: false, checks: [check("web-supplementary-groups", false, detail)], errors: [detail], warnings };
	}

	const nodes: Partial<Record<keyof typeof LAYOUT_VARIABLES, NodeFacts>> = {};
	for (const key of ["accountRoot", ...WRITABLE_ROOT_KEYS] as const) {
		nodes[key] = nodeFacts(loaded.config[key]);
	}

	return evaluateReadiness({
		mode: selection.mode,
		config: loaded.config,
		identity,
		mounts,
		nodes,
		dockerSocketMounted: mounts.some(isDockerSocketMount),
	});
}

/** Docker's API socket grants host-root authority under either common spelling. */
export function isDockerSocketMount(mount: MountEntry): boolean {
	return /\/docker\.sock(?:et)?$/.test(mount.mountPoint);
}

function safeRead(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function nodeFacts(target: string): NodeFacts {
	if (!existsSync(target)) return { exists: false, isSymlink: false, isDirectory: false, uid: -1, gid: -1, mode: 0 };
	try {
		const stats = lstatSync(target);
		return {
			exists: true,
			isSymlink: stats.isSymbolicLink(),
			isDirectory: stats.isDirectory(),
			uid: stats.uid,
			gid: stats.gid,
			mode: stats.mode & 0o777,
		};
	} catch {
		return { exists: false, isSymlink: false, isDirectory: false, uid: -1, gid: -1, mode: 0 };
	}
}

/**
 * Startup gate. Returns the process-exit message for a refused boot, or null
 * when the deployment may start. Secret-free by construction.
 */
export function startupRefusal(env: DeploymentEnvironment = process.env): string | null {
	const readiness = inspectReadiness(env);
	if (readiness.ok) {
		if (readiness.warnings.length) console.warn(`[multiuser] ${readiness.warnings.join(" ")}`);
		console.info("[multiuser] readiness passed", redactedMultiuserSummary(readiness.config));
		return null;
	}
	const lines = [
		"[multiuser] REFUSING TO START: the multi-user web profile did not pass its readiness gate.",
		...readiness.errors.map((error) => `  - ${error}`),
		"",
		`Required environment: ${DEPLOYMENT_MODE_VARIABLE}=multiuser-web, ${CLERK_VARIABLES.join(", ")}.`,
		"See docs/docker.md and docs/architecture.md for the designated mounts and resource limits.",
	];
	return lines.join("\n");
}
