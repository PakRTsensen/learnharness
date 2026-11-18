// This transport-free handler is injected only by the server route adapter.

import type { WebAccountController } from "./account-web.ts";

/** Verify the exact raw Request before any controller mutation or payload is
 * trusted. The event is deletion -> disablement only: never create/admin/erase. */
export function createClerkWebhookRoute(deps: {
	verify(request: Request): Promise<{ type: string; data: { id?: string } }>;
	controller: Pick<WebAccountController, "disableFromClerkWebhook">;
}) {
	return async function POST(request: Request): Promise<Response> {
		let event: Awaited<ReturnType<typeof deps.verify>>;
		try { event = await deps.verify(request); }
		catch { return Response.json({ error: "Webhook verification failed." }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
		if (event.type !== "user.deleted") {
			return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
		}
		if (typeof event.data?.id !== "string" || !event.data.id) {
			return Response.json({ error: "Deletion event has no Clerk subject." }, { status: 400, headers: { "Cache-Control": "no-store" } });
		}
		try {
			await deps.controller.disableFromClerkWebhook(event.data.id);
		} catch { return Response.json({ error: "Account lifecycle service is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
		return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
	};
}
