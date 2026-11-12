/**
 * MULTIUSER REQUEST GATE (per-user accounts, Phase 2).
 *
 * Signed-out denial, local session verification, provider switching,
 * fail-closed configuration, retained cross-site defenses, and the explicit
 * Phase 3 learning-route gate.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";

const TMP_MOUNT = "/tmp/lh-proxy";
const SESSION_SECRET = "s".repeat(48);
const BASE_ENV: Record<string, string> = {
	LH_DEPLOYMENT_MODE: "multiuser-web",
	LH_AUTH_PROVIDER: "local",
	LH_ALLOW_LOCAL_AUTH: "1",
	LH_LOCAL_AUTH_SECRET: SESSION_SECRET,
	LH_READ_ONLY_ROOT_FS: "1",
	LH_WRITABLE_MOUNTS: TMP_MOUNT,
	LH_ACCOUNT_ROOT: `${TMP_MOUNT}/accounts`,
	LH_CONTROLLER_STATE_DIR: `${TMP_MOUNT}/controller`,
	LH_STAGING_DIR: `${TMP_MOUNT}/staging`,
	LH_SNAPSHOT_DIR: `${TMP_MOUNT}/snapshots`,
	LH_PRIVATE_WORK_DIR: `${TMP_MOUNT}/work`,
	NODE_ENV: "test",
};

for (const [key, value] of Object.entries(BASE_ENV)) process.env[key] = value;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;

const { proxy } = await import("../proxy.ts");
const { signSessionToken } = await import("../src/controller/session-token.ts");

async function sessionCookie(
	provider: "local" | "clerk" = "local",
	options: { subject?: string; secret?: string; now?: Date; ttlSeconds?: number } = {},
): Promise<string> {
	const token = await signSessionToken({
		subject: options.subject ?? "local_user",
		provider,
		ttlSeconds: options.ttlSeconds ?? 600,
		...(options.now ? { now: options.now } : {}),
	}, options.secret ?? SESSION_SECRET);
	return `lh_session=${token}`;
}

async function withEnv<T>(
	values: Record<string, string | undefined>,
	run: () => T | Promise<T>,
): Promise<T> {
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function request(url: string, init: { method?: string; cookie?: string; headers?: Record<string, string> } = {}) {
	const headers: Record<string, string> = { ...(init.headers ?? {}) };
	if (init.cookie) headers.cookie = init.cookie;
	return new NextRequest(url, { method: init.method ?? "GET", headers });
}

function redirectTarget(response: Response): URL {
	const location = response.headers.get("location");
	assert.ok(location, "expected a redirect location");
	return new URL(location);
}

async function jsonBody(response: Response): Promise<{ error?: { code?: string } }> {
	return await response.json() as { error?: { code?: string } };
}

describe("multiuser proxy", () => {
	it("redirects signed-out page requests to sign-in and denies APIs", async () => {
		const page = await proxy(request("http://localhost:3000/account"));
		assert.equal(page.status, 307);
		assert.equal(redirectTarget(page).pathname, "/sign-in");
		assert.equal(redirectTarget(page).searchParams.get("redirect_url"), "/account");

		const api = await proxy(request("http://localhost:3000/api/chats"));
		assert.equal(api.status, 401);
		assert.equal((await jsonBody(api)).error?.code, "session_required");

		const accountApi = await proxy(request("http://localhost:3000/api/account"));
		assert.equal(accountApi.status, 401);
	});

	it("fails closed when authentication configuration is incomplete", async () => {
		await withEnv({ LH_READ_ONLY_ROOT_FS: undefined }, async () => {
			const api = await proxy(request("http://localhost:3000/api/chats"));
			assert.equal(api.status, 503);
			assert.equal((await jsonBody(api)).error?.code, "auth_not_configured");
			const page = await proxy(request("http://localhost:3000/account"));
			assert.equal(page.status, 503);
			assert.match(await page.text(), /not configured/i);
		});
	});

	it("fails closed on an invalid deployment selector", async () => {
		await withEnv({ LH_DEPLOYMENT_MODE: "multi-user" }, async () => {
			const api = await proxy(request("http://localhost:3000/api/chats"));
			assert.equal(api.status, 503);
			assert.equal((await jsonBody(api)).error?.code, "invalid_deployment_mode");
			const page = await proxy(request("http://localhost:3000/account"));
			assert.equal(page.status, 503);
		});
	});

	it("verifies the local session and gates every learning route", async () => {
		const cookie = await sessionCookie();
		const home = await proxy(request("http://localhost:3000/", { cookie }));
		assert.equal(home.status, 307);
		assert.equal(redirectTarget(home).pathname, "/account");

		const account = await proxy(request("http://localhost:3000/account", { cookie }));
		assert.equal(account.status, 200);
		assert.equal(account.headers.get("x-middleware-next"), "1");

		const bootstrap = await proxy(request("http://localhost:3000/first-admin", { cookie }));
		assert.equal(bootstrap.headers.get("x-middleware-next"), "1");

		const page = await proxy(request("http://localhost:3000/chat/new", { cookie }));
		assert.equal(page.status, 503);
		assert.match(page.headers.get("content-type") ?? "", /text\/html/);
		assert.match(await page.text(), /Learning runtime pending/);

		const api = await proxy(request("http://localhost:3000/api/chats", { cookie }));
		assert.equal(api.status, 503);
		assert.equal((await jsonBody(api)).error?.code, "worker_runtime_unavailable");

		const settings = await proxy(request("http://localhost:3000/api/settings", { cookie }));
		assert.equal(settings.status, 503);
	});

	it("does not show auth forms to a signed-in browser and rejects provider switching", async () => {
		const cookie = await sessionCookie();
		const signIn = await proxy(request("http://localhost:3000/sign-in", { cookie }));
		assert.equal(signIn.status, 307);
		assert.equal(redirectTarget(signIn).pathname, "/account");

		const clerkCookie = await sessionCookie("clerk");
		const switched = await proxy(request("http://localhost:3000/account", { cookie: clerkCookie }));
		assert.equal(switched.status, 307);
		assert.equal(redirectTarget(switched).pathname, "/sign-in");
	});

	it("rejects expired sessions and keeps the existing cross-site defense", async () => {
		const expired = await sessionCookie("local", {
			now: new Date(Date.now() - 3_600_000),
			ttlSeconds: 60,
		});
		const page = await proxy(request("http://localhost:3000/account", { cookie: expired }));
		assert.equal(page.status, 307);

		const cookie = await sessionCookie();
		const crossSite = await proxy(request("http://localhost:3000/api/account/bootstrap", {
			method: "POST",
			cookie,
			headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" },
		}));
		assert.equal(crossSite.status, 403);
		assert.match(await crossSite.text(), /Cross-site requests/);
	});

	it("keeps single-user/desktop mode free of the auth gate", async () => {
		await withEnv({ LH_DEPLOYMENT_MODE: undefined, LH_DESKTOP_SERVER: undefined, LH_DESKTOP_API_SECRET: undefined }, async () => {
			const page = await proxy(request("http://localhost:3000/chat/new"));
			assert.equal(page.headers.get("x-middleware-next"), "1");
			const api = await proxy(request("http://localhost:3000/api/chats"));
			assert.equal(api.headers.get("x-middleware-next"), "1");
		});
	});
});
