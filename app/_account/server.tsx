import "server-only";

import { headers } from "next/headers";
import { MultiuserRoot } from "@/components/multiuser-root";
import { LocalRoot } from "@/components/local-root";
import { isPublicWebAuthenticationPath, type WebAccountAccess } from "@/src/core";
import { webAccountService, webAccountController, readRequestThemeBoot, createClerkWebhookRoute, messageForAccountMutation } from "@/src/server/account-entry";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";

export { messageForAccountMutation, webAccountService };

export async function readMultiuserAccess(): Promise<WebAccountAccess> {
	return webAccountService.current();
}

export async function readAccountThemeBoot(access?: WebAccountAccess) {
	return readRequestThemeBoot(access);
}

export async function MultiuserRequestRoot({ access, children }: { access: WebAccountAccess; children: React.ReactNode }) {
	const pathname = (await headers()).get("x-learnharness-internal-pathname") ?? "";
	return <MultiuserRoot access={access} publicRoute={isPublicWebAuthenticationPath(pathname)}>{children}</MultiuserRoot>;
}

export function LocalRequestRoot(props: Parameters<typeof LocalRoot>[0]) {
	return <LocalRoot {...props} />;
}

export const clerkWebhookPOST = createClerkWebhookRoute({
	verify: (request: Request) => verifyWebhook(request as NextRequest),
	controller: webAccountController,
});
