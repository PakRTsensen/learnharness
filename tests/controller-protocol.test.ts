/**
 * CONTROLLER CAPABILITIES + IPC FRAMING (per-user accounts, Phase 2).
 *
 * Capabilities are short-lived, operation-bound, and single-use. Frames are
 * versioned, length-prefixed, and bounded before a handler can parse them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	consumeCapability,
	issueCapability,
	verifyCapability,
} from "../src/controller/capabilities.ts";
import {
	encodeFrame,
	FrameDecoder,
	MAX_FRAME_BYTES,
	parseControllerRequestText,
	parseControllerResponse,
	ProtocolError,
} from "../src/controller/protocol.ts";

const SECRET = "c".repeat(48);
const EXPECTATION = {
	subject: "local_user",
	accountId: `acct_${"a".repeat(32)}`,
	operation: "account.ensure",
	generation: 1,
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-capabilities-"));
const NOW = new Date("2026-11-12T00:00:00.000Z");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("controller capabilities", () => {
	it("verifies a correctly bound, unexpired capability", () => {
		const token = issueCapability({ secret: SECRET, expectation: EXPECTATION, ttlSeconds: 60, now: NOW });
		const result = verifyCapability(token, SECRET, EXPECTATION, new Date(NOW.getTime() + 10_000));
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.claims.accountId, EXPECTATION.accountId);
			assert.equal(result.claims.generation, 1);
		}
	});

	it("rejects expired, tampered, re-bound, and wrong-generation capabilities", () => {
		const token = issueCapability({ secret: SECRET, expectation: EXPECTATION, ttlSeconds: 60, now: NOW });
		const expired = verifyCapability(token, SECRET, EXPECTATION, new Date(NOW.getTime() + 61_000));
		assert.equal(expired.ok, false);
		if (!expired.ok) assert.equal(expired.code, "capability_expired");

		const tampered = verifyCapability(`${token}x`, SECRET, EXPECTATION, NOW);
		assert.equal(tampered.ok, false);

		const wrongOperation = verifyCapability(token, SECRET, { ...EXPECTATION, operation: "account.bootstrap" }, NOW);
		assert.equal(wrongOperation.ok, false);
		if (!wrongOperation.ok) assert.equal(wrongOperation.code, "capability_binding_mismatch");

		const wrongGeneration = verifyCapability(token, SECRET, { ...EXPECTATION, generation: 2 }, NOW);
		assert.equal(wrongGeneration.ok, false);
		if (!wrongGeneration.ok) assert.equal(wrongGeneration.code, "capability_binding_mismatch");

		const wrongSecret = verifyCapability(token, "x".repeat(48), EXPECTATION, NOW);
		assert.equal(wrongSecret.ok, false);
		if (!wrongSecret.ok) assert.equal(wrongSecret.code, "capability_signature_invalid");
	});

	it("refuses out-of-bounds TTLs and bindings", () => {
		assert.throws(() => issueCapability({ secret: SECRET, expectation: EXPECTATION, ttlSeconds: 0, now: NOW }), /TTL/);
		assert.throws(() => issueCapability({ secret: SECRET, expectation: EXPECTATION, ttlSeconds: 3601, now: NOW }), /TTL/);
		assert.throws(() => issueCapability({ secret: SECRET, expectation: { ...EXPECTATION, generation: 0 }, now: NOW }), /generation/);
		assert.throws(() => issueCapability({ secret: SECRET, expectation: { ...EXPECTATION, operation: "BAD OP" }, now: NOW }), /operation/);
	});

	it("burns a consumed capability exactly once", () => {
		const token = issueCapability({ secret: SECRET, expectation: EXPECTATION, ttlSeconds: 60, now: NOW });
		const first = consumeCapability({
			controllerStateDir: TMP,
			token,
			secret: SECRET,
			expectation: EXPECTATION,
			now: new Date(NOW.getTime() + 1_000),
		});
		assert.equal(first.ok, true);
		const replay = consumeCapability({
			controllerStateDir: TMP,
			token,
			secret: SECRET,
			expectation: EXPECTATION,
			now: new Date(NOW.getTime() + 2_000),
		});
		assert.equal(replay.ok, false);
		if (!replay.ok) assert.equal(replay.code, "capability_replayed");

		const other = issueCapability({ secret: SECRET, expectation: EXPECTATION, ttlSeconds: 60, now: NOW });
		assert.equal(consumeCapability({
			controllerStateDir: TMP,
			token: other,
			secret: SECRET,
			expectation: EXPECTATION,
			now: new Date(NOW.getTime() + 3_000),
		}).ok, true);
	});
});

describe("controller protocol", () => {
	it("accepts only versioned, allowlisted requests", () => {
		const valid = parseControllerRequestText(JSON.stringify({ v: 1, id: "req_12345678", op: "ping" }));
		assert.equal(valid.ok, true);
		assert.equal(parseControllerRequestText(JSON.stringify({ v: 2, id: "req_12345678", op: "ping" })).ok, false);
		assert.equal(parseControllerRequestText(JSON.stringify({ v: 1, id: "short", op: "ping" })).ok, false);
		assert.equal(parseControllerRequestText(JSON.stringify({ v: 1, id: "req_12345678", op: "shell.exec" })).ok, false);
		assert.equal(parseControllerRequestText("{not json").ok, false);
		assert.equal(parseControllerRequestText("x".repeat(MAX_FRAME_BYTES + 1)).ok, false);
	});

	it("encodes and decodes partial length-prefixed frames", () => {
		const first = { v: 1, id: "req_12345678", ok: true, body: { ready: true } };
		const second = { v: 1, id: "req_87654321", ok: true };
		const encoded = Buffer.concat([encodeFrame(first), encodeFrame(second)]);
		const decoder = new FrameDecoder();
		assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
		assert.deepEqual(decoder.push(encoded.subarray(3, 10)), []);
		assert.deepEqual(decoder.push(encoded.subarray(10)), [first, second]);
		assert.equal(decoder.pendingBytes(), 0);
	});

	it("rejects an oversized declared frame before reading its payload", () => {
		const header = Buffer.alloc(4);
		header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
		assert.throws(
			() => new FrameDecoder().push(header),
			(error: unknown) => error instanceof ProtocolError && error.code === "frame_too_large",
		);
	});

	it("validates response envelopes", () => {
		const ok = parseControllerResponse({ v: 1, id: "req_12345678", ok: true, body: {} });
		assert.equal(ok.ok, true);
		const failure = parseControllerResponse({
			v: 1,
			id: "req_12345678",
			ok: false,
			error: { code: "registry_busy", message: "retry", retryable: true },
		});
		assert.equal(failure.ok, true);
		assert.equal(parseControllerResponse({ v: 1, id: "req_12345678", ok: false, error: { code: "x" } }).ok, false);
	});
});
