/**
 * CONTROLLER STATE LOCKING (per-user accounts, Phase 2).
 *
 * The registry and the capability replay ledger are small JSON documents
 * mutated by short critical sections. Before the Phase 3 controller process
 * owns them behind authenticated IPC, Next.js route handlers share this
 * process-local lock file. It is deliberately small and filesystem-only:
 *
 *   - O_EXCL lock file serializes separate processes;
 *   - stale locks older than 60 seconds are reclaimed;
 *   - the release path only removes a lock whose token we wrote;
 *   - atomic writes fsync + rename, so readers never see partial JSON.
 *
 * Phase 3 replaces the caller with the controller process; the primitive
 * remains useful for controller-owned state.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

export class StateLockError extends Error {
	readonly code: "state_locked" | "state_unavailable";

	constructor(code: "state_locked" | "state_unavailable", message: string) {
		super(message);
		this.name = "StateLockError";
		this.code = code;
	}
}

/** Synchronous sleep for the short critical sections. Atomics.wait is the
 *  only portable blocking primitive available to synchronous store code. */
export function sleepSync(ms: number): void {
	const view = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(view, 0, 0, Math.max(1, ms));
}

export interface StateLockOptions {
	timeoutMs?: number;
	staleMs?: number;
}

function lockToken(): string {
	return `${process.pid}:${Date.now()}:${randomUUID()}`;
}

function fileExists(file: string): boolean {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Run `fn` while holding `<directory>/<name>`. The directory is created with
 * private permissions when absent. `name` is restricted to a basename.
 */
export function withStateLock<T>(
	directory: string,
	name: string,
	fn: () => T,
	options: StateLockOptions = {},
): T {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
		throw new StateLockError("state_unavailable", "Invalid state lock name.");
	}
	const timeoutMs = options.timeoutMs ?? 5_000;
	const staleMs = options.staleMs ?? 60_000;
	try {
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	} catch {
		throw new StateLockError("state_unavailable", "Controller state directory is unavailable.");
	}

	const lockFile = path.join(directory, name);
	const token = lockToken();
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		let fd: number;
		try {
			fd = fs.openSync(lockFile, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw new StateLockError("state_unavailable", "Controller state lock cannot be created.");
			}
			// Reclaim a lock left by a crashed process. Re-check immediately
			// before unlinking so a fresh lock is not removed by a stale reader.
			let stale = false;
			try {
				stale = Date.now() - fs.statSync(lockFile).mtimeMs > staleMs;
			} catch {
				stale = false;
			}
			if (stale) {
				try { fs.rmSync(lockFile, { force: true }); } catch { /* another process won */ }
				continue;
			}
			if (Date.now() >= deadline) {
				throw new StateLockError("state_locked", "Controller state is busy; retry the operation.");
			}
			sleepSync(20);
			continue;
		}

		try {
			fs.writeFileSync(fd, token, "utf8");
		} finally {
			fs.closeSync(fd);
		}
		break;
	}

	try {
		return fn();
	} finally {
		// Only remove the lock if it is still ours. A stale-reclaim race must
		// never delete the next owner's lock.
		if (readText(lockFile) === token) {
			try { fs.rmSync(lockFile, { force: true }); } catch { /* already gone */ }
		}
	}
}

/** Atomic private JSON write; the parent directory is created with 0700. */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
	const directory = path.dirname(file);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileAtomicSync(file, `${JSON.stringify(value, null, "\t")}\n`, { mode });
}

/** A file is absent when neither it nor a dangling symlink exists. */
export function stateFileExists(file: string): boolean {
	return fileExists(file);
}
