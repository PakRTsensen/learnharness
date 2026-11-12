/**
 * THE MULTIUSER SERVER BARREL (per-user accounts, Phase 2, 2026-11-12).
 *
 * The single sanctioned server edge for `app/` in multiuser mode. It must
 * never import `src/server/stores.ts`, `src/store/*`, or `src/agent/*`: the
 * web process is a relay, not the account authority, and account content
 * belongs to the Phase 3 worker. `proxy.ts` and `instrumentation.ts` import
 * the individual runtime/controller modules directly because they are not
 * `app/` modules.
 *
 * This barrel deliberately exposes only authentication, account lifecycle,
 * runtime readiness/configuration, and account contracts. Learning services
 * remain behind the gated worker runtime.
 */

export * from "../accounts/contracts.ts";
export * from "../accounts/request-context.ts";
export * from "../controller/clerk-identity.ts";
export * from "../controller/clerk-webhook.ts";
export * from "../controller/http.ts";
export * from "../controller/provisioning.ts";
export * from "../controller/registry.ts";
export * from "../controller/session-token.ts";
export * from "../runtime/deployment-mode.ts";
export * from "../runtime/multiuser-config.ts";
