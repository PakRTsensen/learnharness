/**
 * CONTROLLER CAPABILITIES (per-user accounts, Phase 2, 2026-11-12).
 *
 * Short-lived, single-use grants bound to the verified subject, internal
 * account, operation, and worker generation. Phase 3 passes these over the
 * authenticated controller/helper IPC; the primitive is implemented and
 * tested here so the privilege boundary has one reviewed token format.
 *
 * Format: `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`
 * The payload is authenticated, not encrypted: it contains identifiers only,
 * never credentials, content, or provider key material.
 */

import fs from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
	ACCOUNT_ID_PATTERN,
	ACCOUNT_SUBJECT_PATTERN,
} from "../accounts/contracts.ts";
import { StateLockError, withStateLock, writeJsonAtomic } from "./state-lock.ts";

const TOKEN_PREFIX = "v1";
const MAX_TOKEN_LENGTH = 4096;
const MAX_TTL_SECONDS = 3600;
const CAPABILITIES_FILE = "capabilities.json";

export interface CapabilityClaims {
	v: 1;
	sub: string;
	accountId: string;
	operation: string;
	generation: number;
	iat: number;
	exp: number;
	jti: string;
}

export interface CapabilityExpectation {
	subject: string;
	accountId: string;
	operation: string;
	generation: number;
}

export type CapabilityFailureCode =
	| "capability_malformed"
	| "capability_signature_invalid"
	| "capability_expired"
	| "capability_not_yet_valid"
	| "capability_binding_mismatch"
	| "capability_replayed"
	| "capability_store_invalid";

export type CapabilityResult =
	| { ok: true; claims: CapabilityClaims }
	| { ok: false; code: CapabilityFailureCode; message: string };

function base64url(value: Buffer): string {
	return value.toString("base64url");
}

function failure(code: CapabilityFailureCode, message: string): { ok: false; code: CapabilityFailureCode; message: string } {
	return { ok: false, code, message };
}

function secretKey(secret: string): Buffer {
	if (secret.length < 32 || secret.length > 512) {
		throw new Error("Capability secret must be 32-512 characters.");
	}
	return Buffer.from(secret, "utf8");
}

function sign(secret: string, signed: string): Buffer {
	return createHmac("sha256", secretKey(secret)).update(signed, "utf8").digest();
}

function validClaims(value: unknown): value is CapabilityClaims {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.v === 1
		&& typeof record.sub === "string" && ACCOUNT_SUBJECT_PATTERN.test(record.sub)
		&& typeof record.accountId === "string" && ACCOUNT_ID_PATTERN.test(record.accountId)
		&& typeof record.operation === "string" && /^[a-z][a-z0-9._-]{1,63}$/.test(record.operation)
		&& typeof record.generation === "number" && Number.isSafeInteger(record.generation) && record.generation >= 1
		&& typeof record.iat === "number" && Number.isSafeInteger(record.iat)
		&& typeof record.exp === "number" && Number.isSafeInteger(record.exp)
		&& typeof record.jti === "string" && /^[a-f0-9-]{36}$/.test(record.jti);
}

/** Issue one capability. TTL is deliberately short; callers choose it. */
export function issueCapability(input: {
	secret: string;
	expectation: CapabilityExpectation;
	ttlSeconds?: number;
	now?: Date;
}): string {
	if (!ACCOUNT_SUBJECT_PATTERN.test(input.expectation.subject)) throw new Error("Invalid capability subject.");
	if (!ACCOUNT_ID_PATTERN.test(input.expectation.accountId)) throw new Error("Invalid capability account id.");
	if (!/^[a-z][a-z0-9._-]{1,63}$/.test(input.expectation.operation)) throw new Error("Invalid capability operation.");
	if (!Number.isSafeInteger(input.expectation.generation) || input.expectation.generation < 1) {
		throw new Error("Invalid capability generation.");
	}
	const ttl = input.ttlSeconds ?? 60;
	if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
		throw new Error("Capability TTL is out of bounds.");
	}
	const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
	const claims: CapabilityClaims = {
		v: 1,
		sub: input.expectation.subject,
		accountId: input.expectation.accountId,
		operation: input.expectation.operation,
		generation: input.expectation.generation,
		iat: now,
		exp: now + ttl,
		jti: randomUUID(),
	};
	const payload = base64url(Buffer.from(JSON.stringify(claims), "utf8"));
	const signed = `${TOKEN_PREFIX}.${payload}`;
	return `${signed}.${base64url(sign(input.secret, signed))}`;
}

export function verifyCapability(
	token: string,
	secret: string,
	expectation: CapabilityExpectation,
	now: Date = new Date(),
): CapabilityResult {
	if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
		return failure("capability_malformed", "The capability is malformed.");
	}
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
		return failure("capability_malformed", "The capability is malformed.");
	}
	const signed = `${parts[0]}.${parts[1]}`;
	const expected = sign(secret, signed);
	const supplied = Buffer.from(parts[2], "base64url");
	if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
		return failure("capability_signature_invalid", "The capability signature is invalid.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return failure("capability_malformed", "The capability payload is malformed.");
	}
	if (!validClaims(parsed)) return failure("capability_malformed", "The capability claims are malformed.");
	const seconds = Math.floor(now.getTime() / 1000);
	if (parsed.exp <= seconds) return failure("capability_expired", "The capability has expired.");
	if (parsed.iat > seconds + 30) return failure("capability_not_yet_valid", "The capability is not yet valid.");
	if (
		parsed.sub !== expectation.subject ||
		parsed.accountId !== expectation.accountId ||
		parsed.operation !== expectation.operation ||
		parsed.generation !== expectation.generation
	) {
		return failure("capability_binding_mismatch", "The capability is bound to a different operation.");
	}
	return { ok: true, claims: parsed };
}

interface UsedLedger {
	version: 1;
	used: Record<string, number>;
}

function readUsed(file: string): UsedLedger {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, used: {} };
		throw new Error("capability_store_invalid");
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
		const record = parsed as Record<string, unknown>;
		if (record.version !== 1 || !record.used || typeof record.used !== "object" || Array.isArray(record.used)) {
			throw new Error("invalid");
		}
		const used: Record<string, number> = {};
		for (const [jti, exp] of Object.entries(record.used as Record<string, unknown>)) {
			if (typeof exp !== "number" || !Number.isSafeInteger(exp)) throw new Error("invalid");
			used[jti] = exp;
		}
		return { version: 1, used };
	} catch {
		throw new Error("capability_store_invalid");
	}
}

/**
 * Verify and atomically burn the capability's `jti`. Replay after this call
 * fails even if the token has not expired. The ledger lives in controller
 * state, outside every account home.
 */
export function consumeCapability(input: {
	controllerStateDir: string;
	token: string;
	secret: string;
	expectation: CapabilityExpectation;
	now?: Date;
}): CapabilityResult {
	const now = input.now ?? new Date();
	const verified = verifyCapability(input.token, input.secret, input.expectation, now);
	if (!verified.ok) return verified;
	const file = path.join(input.controllerStateDir, CAPABILITIES_FILE);
	try {
		return withStateLock(input.controllerStateDir, "capabilities.lock", () => {
			const ledger = readUsed(file);
			const seconds = Math.floor(now.getTime() / 1000);
			for (const [jti, exp] of Object.entries(ledger.used)) {
				if (exp < seconds - 60) delete ledger.used[jti];
			}
			if (ledger.used[verified.claims.jti] !== undefined) {
				return failure("capability_replayed", "The capability has already been used.");
			}
			ledger.used[verified.claims.jti] = verified.claims.exp;
			writeJsonAtomic(file, ledger, 0o600);
			return verified;
		});
	} catch (error) {
		if (error instanceof StateLockError || (error instanceof Error && error.message === "capability_store_invalid")) {
			return failure("capability_store_invalid", "The capability replay ledger is unavailable.");
		}
		throw error;
	}
}
