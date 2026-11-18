/**
 * Narrow server entry point for the account-authentication composition.
 *
 * Do not re-export the main `src/server/index.ts` barrel here: that barrel
 * statically reaches the single-user stores, agent services, and plugins.
 * This entry is safe for the multiuser-web root and contains no learning-data
 * store fallback. The real controller remains injected by A06.
 */
export { webAccountService } from "./account-web.ts";
export { webAccountController } from "./web-account-composition.ts";
export { readRequestThemeBoot } from "./theme-boot-request.ts";
export { createClerkWebhookRoute } from "./clerk-webhook.ts";
export { messageForAccountMutation } from "./account-mutation-route.ts";
