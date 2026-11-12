/**
 * CONTROLLER PROTOCOL (per-user accounts, Phase 2, 2026-11-12).
 *
 * Versioned, length-prefixed, size-bounded frames for the private
 * web ↔ controller channel. Phase 2 defines and tests the contract; Phase 3
 * carries it over the authenticated local IPC transport.
 *
 * Limits are part of the security boundary: an oversized or malformed frame
 * is rejected before any handler sees it. No provider content, credentials,
 * or archive payloads belong in this channel's metadata.
 */

export const CONTROLLER_PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 64 * 1024;

export const CONTROLLER_OPERATIONS = [
	"ping",
	"account.status",
	"account.ensure",
	"account.bootstrap",
	"account.disable",
	"capability.verify",
] as const;

export type ControllerOperation = (typeof CONTROLLER_OPERATIONS)[number];

export interface ControllerRequest {
	v: typeof CONTROLLER_PROTOCOL_VERSION;
	id: string;
	op: ControllerOperation;
	body?: unknown;
}

export interface ControllerError {
	code: string;
	message: string;
	retryable: boolean;
}

export type ControllerResponse =
	| { v: typeof CONTROLLER_PROTOCOL_VERSION; id: string; ok: true; body?: unknown }
	| { v: typeof CONTROLLER_PROTOCOL_VERSION; id: string; ok: false; error: ControllerError };

export type ProtocolFailureCode = "frame_too_large" | "frame_malformed" | "request_invalid" | "response_invalid";

export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; code: ProtocolFailureCode; message: string };

export class ProtocolError extends Error {
	readonly code: ProtocolFailureCode;

	constructor(code: ProtocolFailureCode, message: string) {
		super(message);
		this.name = "ProtocolError";
		this.code = code;
	}
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseControllerRequest(payload: unknown): ProtocolResult<ControllerRequest> {
	if (!isRecord(payload)) {
		return { ok: false, code: "request_invalid", message: "A controller request must be a JSON object." };
	}
	if (payload.v !== CONTROLLER_PROTOCOL_VERSION) {
		return { ok: false, code: "request_invalid", message: "Unsupported controller protocol version." };
	}
	if (typeof payload.id !== "string" || !ID_PATTERN.test(payload.id)) {
		return { ok: false, code: "request_invalid", message: "Controller request id is invalid." };
	}
	if (typeof payload.op !== "string" || !(CONTROLLER_OPERATIONS as readonly string[]).includes(payload.op)) {
		return { ok: false, code: "request_invalid", message: "Controller operation is not allowed." };
	}
	return {
		ok: true,
		value: {
			v: CONTROLLER_PROTOCOL_VERSION,
			id: payload.id,
			op: payload.op as ControllerOperation,
			...(payload.body !== undefined ? { body: payload.body } : {}),
		},
	};
}

export function parseControllerRequestText(text: string): ProtocolResult<ControllerRequest> {
	if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
		return { ok: false, code: "frame_too_large", message: "The controller frame exceeds its size limit." };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, code: "frame_malformed", message: "The controller frame is not valid JSON." };
	}
	return parseControllerRequest(parsed);
}

export function parseControllerResponse(payload: unknown): ProtocolResult<ControllerResponse> {
	if (!isRecord(payload)) {
		return { ok: false, code: "response_invalid", message: "A controller response must be a JSON object." };
	}
	if (payload.v !== CONTROLLER_PROTOCOL_VERSION || typeof payload.id !== "string" || !ID_PATTERN.test(payload.id)) {
		return { ok: false, code: "response_invalid", message: "Controller response envelope is invalid." };
	}
	if (payload.ok === true) {
		return {
			ok: true,
			value: {
				v: CONTROLLER_PROTOCOL_VERSION,
				id: payload.id,
				ok: true,
				...(payload.body !== undefined ? { body: payload.body } : {}),
			},
		};
	}
	if (payload.ok === false && isRecord(payload.error)) {
		const error = payload.error;
		if (
			typeof error.code === "string" && error.code.length > 0 && error.code.length <= 64 &&
			typeof error.message === "string" && error.message.length > 0 && error.message.length <= 512 &&
			typeof error.retryable === "boolean"
		) {
			return {
				ok: true,
				value: {
					v: CONTROLLER_PROTOCOL_VERSION,
					id: payload.id,
					ok: false,
					error: { code: error.code, message: error.message, retryable: error.retryable },
				},
			};
		}
	}
	return { ok: false, code: "response_invalid", message: "Controller response body is invalid." };
}

/** Length-prefixed frame: 4-byte big-endian payload length + UTF-8 JSON. */
export function encodeFrame(message: unknown): Buffer {
	const json = JSON.stringify(message);
	const payload = Buffer.from(json, "utf8");
	if (payload.length > MAX_FRAME_BYTES) {
		throw new ProtocolError("frame_too_large", "The controller frame exceeds its size limit.");
	}
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32BE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

/**
 * Incremental decoder for a byte stream. It rejects a declared or accumulated
 * frame above the limit immediately, without waiting for the rest.
 */
export class FrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): unknown[] {
		if (chunk.length > 0) this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const messages: unknown[] = [];
		for (;;) {
			if (this.buffer.length < 4) break;
			const length = this.buffer.readUInt32BE(0);
			if (length > MAX_FRAME_BYTES) {
				this.buffer = Buffer.alloc(0);
				throw new ProtocolError("frame_too_large", "The controller frame exceeds its size limit.");
			}
			if (this.buffer.length < 4 + length) break;
			const payload = this.buffer.subarray(4, 4 + length);
			this.buffer = this.buffer.subarray(4 + length);
			let parsed: unknown;
			try {
				parsed = JSON.parse(payload.toString("utf8"));
			} catch {
				throw new ProtocolError("frame_malformed", "The controller frame is not valid JSON.");
			}
			messages.push(parsed);
		}
		return messages;
	}

	pendingBytes(): number {
		return this.buffer.length;
	}
}
