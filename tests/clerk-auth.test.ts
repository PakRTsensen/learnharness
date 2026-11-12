/**
 * SESSION + CLERK IDENTITY (per-user accounts, Phase 2).
 *
 * The offline provider mints the same HS256 cookie shape as the Clerk
 * exchange. Clerk tokens are verified locally against an injected JWKS
 * resolver, so these tests need no network and prove issuer, subject,
 * authorized-party, expiry, and algorithm enforcement.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	SignJWT,
} from "jose";
import { verifyClerkSessionToken } from "../src/controller/clerk-identity.ts";
import { verifyClerkWebhook } from "../src/controller/clerk-webhook.ts";
import {
	signSessionToken,
	verifySessionToken,
} from "../src/controller/session-token.ts";

const SESSION_SECRET = "s".repeat(48);
const ISSUER = "https://clerk.example.com";
const ORIGIN = "https://learn.example.com";

async function clerkFixture() {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
	const jwks = createLocalJWKSet({ keys: [jwk] });
	const config = {
		issuer: ISSUER,
		jwksUrl: `${ISSUER}/.well-known/jwks.json`,
		authorizedParties: [ORIGIN],
	};
	const sign = async (claims: Record<string, unknown>, options: { subject?: string; issuer?: string; expires?: number; algorithm?: string } = {}) => {
		const now = Math.floor(Date.now() / 1000);
		const token = new SignJWT(claims)
			.setProtectedHeader({ alg: options.algorithm ?? "RS256", kid: "test-key", typ: "JWT" })
			.setIssuer(options.issuer ?? ISSUER)
			.setSubject(options.subject ?? "user_abc123")
			.setIssuedAt(now);
		return token.setExpirationTime(options.expires ?? now + 300).sign(privateKey);
	};
	return { jwks, config, sign };
}

describe("application session token", () => {
	it("round-trips the offline provider claims", async () => {
		const now = new Date("2026-11-12T00:00:00.000Z");
		const token = await signSessionToken({
			subject: "local_abc",
			provider: "local",
			email: "learner@example.com",
			name: "Learner",
			ttlSeconds: 600,
			now,
		}, SESSION_SECRET);
		const verified = await verifySessionToken(token, SESSION_SECRET, new Date(now.getTime() + 60_000));
		assert.equal(verified.ok, true);
		if (!verified.ok) return;
		assert.equal(verified.session.subject, "local_abc");
		assert.equal(verified.session.provider, "local");
		assert.equal(verified.session.email, "learner@example.com");
		assert.equal(verified.session.expiresAt, now.getTime() + 600_000);
	});

	it("rejects expired, tampered, wrong-secret, and malformed tokens", async () => {
		const now = new Date("2026-11-12T00:00:00.000Z");
		const token = await signSessionToken({ subject: "local_abc", provider: "local", ttlSeconds: 60, now }, SESSION_SECRET);
		const expired = await verifySessionToken(token, SESSION_SECRET, new Date(now.getTime() + 120_000));
		assert.equal(expired.ok, false);
		if (!expired.ok) assert.equal(expired.code, "session_expired");
		const wrongSecret = await verifySessionToken(token, "x".repeat(48), now);
		assert.equal(wrongSecret.ok, false);
		const tampered = await verifySessionToken(`${token}x`, SESSION_SECRET, now);
		assert.equal(tampered.ok, false);
		const malformed = await verifySessionToken("not-a-jwt", SESSION_SECRET, now);
		assert.equal(malformed.ok, false);
	});

	it("refuses to mint a session for a non-account subject", async () => {
		await assert.rejects(
			() => signSessionToken({ subject: "../../etc/passwd", provider: "local", ttlSeconds: 60 }, SESSION_SECRET),
			/Invalid session subject/,
		);
	});
});

describe("Clerk session verification", () => {
	it("accepts a correctly signed, correctly scoped session", async () => {
		const { jwks, config, sign } = await clerkFixture();
		const token = await sign({ email: "learner@example.com", azp: ORIGIN, sid: "sess_1" });
		const verified = await verifyClerkSessionToken(token, config, { jwks });
		assert.equal(verified.ok, true);
		if (!verified.ok) return;
		assert.equal(verified.identity.subject, "user_abc123");
		assert.equal(verified.identity.email, "learner@example.com");
		assert.equal(verified.identity.sessionId, "sess_1");
	});

	it("rejects the wrong issuer, wrong authorized party, non-user subject, and expiry", async () => {
		const { jwks, config, sign } = await clerkFixture();
		const wrongIssuer = await sign({ azp: ORIGIN }, { issuer: "https://attacker.example.com" });
		assert.equal((await verifyClerkSessionToken(wrongIssuer, config, { jwks })).ok, false);

		const wrongParty = await sign({ azp: "https://attacker.example.com" });
		const partyResult = await verifyClerkSessionToken(wrongParty, config, { jwks });
		assert.equal(partyResult.ok, false);
		if (!partyResult.ok) assert.equal(partyResult.code, "clerk_authorized_party_invalid");

		const localSubject = await sign({ azp: ORIGIN }, { subject: "local_abc" });
		const subjectResult = await verifyClerkSessionToken(localSubject, config, { jwks });
		assert.equal(subjectResult.ok, false);
		if (!subjectResult.ok) assert.equal(subjectResult.code, "clerk_subject_invalid");

		const expired = await sign({ azp: ORIGIN }, { expires: Math.floor(Date.now() / 1000) - 120 });
		const expiredResult = await verifyClerkSessionToken(expired, config, { jwks });
		assert.equal(expiredResult.ok, false);
		if (!expiredResult.ok) assert.equal(expiredResult.code, "clerk_token_expired");
	});

	it("does not accept an HS256 token through the JWKS verifier", async () => {
		const { jwks, config } = await clerkFixture();
		const token = await new SignJWT({ azp: ORIGIN })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuer(ISSUER)
			.setSubject("user_abc123")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(new TextEncoder().encode("x".repeat(48)));
		const result = await verifyClerkSessionToken(token, config, { jwks });
		assert.equal(result.ok, false);
	});
});

describe("Clerk webhook verification", () => {
	const key = Buffer.from("webhook-test-key-0123456789", "utf8");
	const secret = `whsec_${key.toString("base64")}`;
	const payload = JSON.stringify({ type: "user.deleted", data: { id: "user_abc123" } });
	const id = "msg_test_1";
	const timestamp = () => String(Math.floor(Date.now() / 1000));
	const signature = (body: string, ts: string, msgId = id) =>
		createHmac("sha256", key).update(`${msgId}.${ts}.${body}`, "utf8").digest("base64");
	const headers = (ts: string, sigs: string) => new Headers({
		"svix-id": id,
		"svix-timestamp": ts,
		"svix-signature": sigs,
	});

	it("accepts a valid Svix signature", () => {
		const ts = timestamp();
		const result = verifyClerkWebhook({ payload, headers: headers(ts, `v1,${signature(payload, ts)}`), secret });
		assert.equal(result.ok, true);
	});

	it("accepts one valid signature among several and rejects tampering", () => {
		const ts = timestamp();
		const result = verifyClerkWebhook({
			payload,
			headers: headers(ts, `v1,${signature("other", ts)} v1,${signature(payload, ts)}`),
			secret,
		});
		assert.equal(result.ok, true);
		const tampered = verifyClerkWebhook({
			payload: `${payload} `,
			headers: headers(ts, `v1,${signature(payload, ts)}`),
			secret,
		});
		assert.equal(tampered.ok, false);
		if (!tampered.ok) assert.equal(tampered.code, "webhook_signature_invalid");
	});

	it("rejects stale timestamps, missing headers, and missing configuration", () => {
		const stale = verifyClerkWebhook({
			payload,
			headers: headers(String(Math.floor(Date.now() / 1000) - 600), `v1,${signature(payload, timestamp())}`),
			secret,
		});
		assert.equal(stale.ok, false);
		if (!stale.ok) assert.equal(stale.code, "webhook_timestamp_invalid");
		const missing = verifyClerkWebhook({ payload, headers: new Headers(), secret });
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.equal(missing.code, "webhook_signature_missing");
		const unconfigured = verifyClerkWebhook({ payload, headers: headers(timestamp(), "v1,x"), secret: undefined });
		assert.equal(unconfigured.ok, false);
		if (!unconfigured.ok) assert.equal(unconfigured.code, "webhook_configuration_missing");
	});
});
