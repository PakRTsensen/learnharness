import { webAccountService } from "@/app/_account/server";
import { messageForAccountMutation } from "@/app/_account/server";

export const dynamic = "force-dynamic";

// Secret validation/commit belongs to A06; this route never compares or stores
// it. Until that controller adapter is composed, all applicants stay closed.
export async function POST(request: Request) {
	let body: unknown;
	try { body = await request.json(); }
	catch { return Response.json({ error: "Expected a JSON object." }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "Expected a JSON object." }, { status: 400, headers: { "Cache-Control": "no-store" } });
	}
	const { hostSecret } = body as { hostSecret?: unknown };
	const result = await webAccountService.mutate("bootstrap", { hostSecret: typeof hostSecret === "string" ? hostSecret : "" });
	const { error, status } = messageForAccountMutation(result);
	return Response.json(status === 200 ? {} : { error }, { status, headers: { "Cache-Control": "no-store" } });
}
