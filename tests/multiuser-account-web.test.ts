import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebAccountService, type WebAccountController, type ClerkSessionProof } from "../src/server/account-web.ts";
import { createClerkWebhookRoute } from "../src/server/clerk-webhook.ts";
import { messageForAccountMutation } from "../src/server/account-mutation-route.ts";

const active = { kind: "active" as const, account: { role: "member" as const, lifecycle: "active" as const, recoveringUntil: null } };

describe("multiuser web account service", () => {
	it("does not call the controller/registries for a signed-out proof", async () => {
		let resolutions = 0;
		const controller: WebAccountController = {
			resolve: async () => { resolutions++; return active; },
			bootstrap: async () => active,
			register: async () => active,
			disableFromClerkWebhook: async () => {},
		};
		const service = createWebAccountService({ controller, proof: { read: async () => null } });
		assert.deepEqual(await service.current(), { kind: "unauthenticated" });
		assert.equal(resolutions, 0);
		assert.deepEqual(await service.mutate("register", {}), { kind: "unauthenticated" });
		assert.equal(messageForAccountMutation({ kind: "unauthenticated" }).status, 401);
	});

	it("passes only the opaque server proof and submitted bootstrap secret to the controller", async () => {
		const calls: unknown[] = [];
		const controller: WebAccountController = {
			resolve: async proof => { calls.push(proof); return active; },
			bootstrap: async (proof, secret) => { calls.push(proof, secret); return active; },
			register: async proof => { calls.push(proof); return active; },
			disableFromClerkWebhook: async () => {},
		};
		const proof: ClerkSessionProof = { sessionToken: "server-obtained-fixture-proof" };
		const service = createWebAccountService({ controller, proof: { read: async () => proof } });
		assert.equal((await service.current()).kind, "active");
		assert.equal((await service.mutate("bootstrap", { hostSecret: "fixture-secret" })).kind, "active");
		assert.equal((await service.mutate("register", {})).kind, "active");
		assert.deepEqual(calls, [proof, proof, "fixture-secret", proof]);
		assert.equal(JSON.stringify(active).includes("sessionToken"), false);
	});

	it("fails closed on proof errors, controller errors, and invalid registration status", async () => {
		const failing: WebAccountController = {
			resolve: async () => { throw new Error("private failure"); },
			bootstrap: async () => { throw new Error("private failure"); },
			register: async () => ({ kind: "registration-required" }),
			disableFromClerkWebhook: async () => {},
		};
		const proof = { sessionToken: "server-only" };
		assert.deepEqual(await createWebAccountService({ controller: failing, proof: { read: async () => { throw new Error("Clerk unavailable"); } } }).current(), { kind: "unavailable" });
		assert.deepEqual(await createWebAccountService({ controller: failing, proof: { read: async () => proof } }).current(), { kind: "unavailable" });
		assert.deepEqual(await createWebAccountService({ controller: failing, proof: { read: async () => proof } }).mutate("register", {}), { kind: "registration-required" });
		assert.equal(messageForAccountMutation({ kind: "unavailable" }).status, 503);
	});
});

describe("verified Clerk deletion webhook", () => {
	it("verifies before mutation, ignores other verified events, and only disables deletion", async () => {
		const calls: string[] = [];
		const controller = { disableFromClerkWebhook: async (id: string) => { calls.push(id); } };
		const invalid = createClerkWebhookRoute({ verify: async () => { throw new Error("forged"); }, controller });
		const invalidResponse = await invalid(new Request("http://localhost/api/webhooks/clerk", { method: "POST", body: "raw" }));
		assert.equal(invalidResponse.status, 400);
		assert.equal(invalidResponse.headers.get("Cache-Control"), "no-store");
		assert.deepEqual(calls, []);
		const ignored = createClerkWebhookRoute({ verify: async () => ({ type: "user.created", data: { id: "subject", unsafeMetadata: { role: "admin" } } }), controller });
		assert.equal((await ignored(new Request("http://localhost/api/webhooks/clerk", { method: "POST" }))).status, 200);
		assert.deepEqual(calls, []);
		const deleted = createClerkWebhookRoute({ verify: async request => { assert.equal(request.bodyUsed, false); return { type: "user.deleted", data: { id: "subject" } }; }, controller });
		const response = await deleted(new Request("http://localhost/api/webhooks/clerk", { method: "POST", body: "raw-body" }));
		assert.equal(response.status, 200);
		assert.deepEqual(calls, ["subject"]);
		assert.equal((await createClerkWebhookRoute({ verify: async () => ({ type: "user.deleted", data: {} }), controller })(new Request("http://localhost/api/webhooks/clerk", { method: "POST" }))).status, 400);
	});

	it("does not turn an unavailable controller into successful deletion or erasure", async () => {
		const route = createClerkWebhookRoute({ verify: async () => ({ type: "user.deleted", data: { id: "subject" } }), controller: {
			disableFromClerkWebhook: async () => { throw new Error("unavailable"); },
		} });
		assert.equal((await route(new Request("http://localhost/api/webhooks/clerk", { method: "POST" }))).status, 503);
	});
});
