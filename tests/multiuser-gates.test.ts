import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextResponse, NextRequest, type NextFetchEvent } from "next/server";
import { createProxy } from "../src/server/multiuser-proxy.ts";
import { createPluginDocumentRoute } from "../src/server/plugin-transport.ts";

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
	try { return await run(); }
	finally { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; }
}

const env = { LH_DEPLOYMENT_MODE: "multiuser-web" as string | undefined, LH_DESKTOP_SERVER: undefined, LH_DESKTOP_API_SECRET: undefined, LH_ALLOWED_HOSTS: undefined };
const event = { waitUntil() {} } as unknown as NextFetchEvent;

describe("multiuser request policy", () => {
	it("runs Host/CSRF before Clerk and does not call the Clerk adapter in local mode", async () => withEnv(env, async () => {
		let clerkCalls = 0;
		const proxy = createProxy(async () => { clerkCalls++; return NextResponse.next(); });
		const hostile = await proxy(new NextRequest("http://invalid.example/api/chats", { method: "POST" }), event);
		assert.equal(hostile.status, 403);
		assert.equal(hostile.headers.get("cache-control"), "no-store");
		const csrf = await proxy(new NextRequest("http://localhost/api/chats", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }), event);
		assert.equal(csrf.status, 403);
		assert.equal(clerkCalls, 0);
		await withEnv({ ...env, LH_DEPLOYMENT_MODE: "single-user" }, async () => {
			assert.equal((await proxy(new NextRequest("http://localhost/api/chats"), event)).headers.get("x-middleware-next"), "1");
		});
		assert.equal(clerkCalls, 0);
	}));

	it("returns JSON no-store 503s for invalid API configuration and plain text for pages", async () => withEnv({ ...env, LH_DEPLOYMENT_MODE: "not-a-mode" }, async () => {
		const proxy = createProxy(async () => { throw new Error("invalid deployment never reaches Clerk"); });
		const api = await proxy(new NextRequest("http://localhost/api/chats"), event);
		assert.equal(api.status, 503);
		assert.match(api.headers.get("content-type") ?? "", /json/);
		assert.equal(api.headers.get("cache-control"), "no-store");
		const page = await proxy(new NextRequest("http://localhost/"), event);
		assert.equal(page.status, 503);
		assert.match(page.headers.get("content-type") ?? "", /text\/plain/);
	}));

	it("allows a fake signed-in adapter to mark only the server-derived public pathname", async () => withEnv(env, async () => {
		const proxy = createProxy(async request => {
			const headers = new Headers(request.headers);
			headers.set("x-learnharness-internal-pathname", request.nextUrl.pathname);
			return NextResponse.next({ request: { headers } });
		});
		const response = await proxy(new NextRequest("http://localhost/sign-in", { headers: { "x-learnharness-internal-pathname": "/" } }), event);
		assert.equal(response.headers.get("x-middleware-request-x-learnharness-internal-pathname"), "/sign-in");
		assert.equal(response.headers.get("x-middleware-request-x-learnharness-internal-pathname"), "/sign-in");
		assert.equal(response.headers.get("x-middleware-request-x-learnharness-internal-pathname")?.includes("bogus"), false);
	}));
});

describe("multiuser streamed document denial", () => {
	for (const [status, account] of [
		[401, async () => Response.json({ error: "Sign in" }, { status: 401 })],
		[403, async () => Response.json({ error: "Active account required" }, { status: 403 })],
		[503, async () => Response.json({ error: "Unavailable" }, { status: 503 })],
	] as const) it(`returns ${status} before params, body, and transport`, async () => {
		let paramsReads = 0, transportCalls = 0;
		const request = new Request("http://localhost/api/plugins/one/documents/markdown", { method: "POST", body: "must remain unread", duplex: "half" } as RequestInit);
		Object.defineProperty(request, "body", { get() { throw new Error("denied before body access"); } });
		const route = createPluginDocumentRoute({ convertDocument: async () => { transportCalls++; return Response.json({}); } }, {
			mode: async () => "multiuser-web",
			account,
		});
		const response = await route.POST(request, { get params(): Promise<{ id: string }> { paramsReads++; throw new Error("denied before params"); } });
		assert.equal(response.status, status);
		assert.deepEqual(await response.json(), { error: ["Sign in", "Active account required", "Unavailable"][status === 401 ? 0 : status === 403 ? 1 : 2] });
		assert.equal(paramsReads, 0);
		assert.equal(transportCalls, 0);
		assert.equal(request.bodyUsed, false);
	});
});
