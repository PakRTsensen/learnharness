import { webAccountService } from "@/app/_account/server";
import { messageForAccountMutation } from "@/app/_account/server";

export const dynamic = "force-dynamic";

export async function POST() {
	const result = await webAccountService.mutate("register", {});
	const { error, status } = messageForAccountMutation(result);
	return Response.json(status === 200 ? {} : { error }, { status, headers: { "Cache-Control": "no-store" } });
}
