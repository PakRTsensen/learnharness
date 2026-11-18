# A05 Phase 2 Implementation Continuation — Source Review

**Date:** 2026-11-16  
**Status:** Source review incomplete; A05 is not approved or gate-passed, and no verification was run.

## Constraints observed

No tests, typecheck, lint, build, Docker, browser, or other verification were run in this continuation. No additional subagent was started. No commit or push was made. Existing worktree changes were preserved. Source-only configuration, route and boundary changes plus targeted tests were added for the newly approved trusted-origin setting; none have been run.

## Source changes in this continuation

- Added `src/server/plugin-document-route.ts` as a narrow streamed endpoint policy module. It does not import `plugin-transport.ts`, whose `plugin-host.ts` dependency reaches store/plugin composition. It evaluates host/cross-site desktop/local API policy, explicit deployment mode, and account policy before reading route params/body or invoking plugin transport. Multi-user requests are intentionally denied with no-store responses even for an active account because Phase 2 has no isolated plugin transport.
- Changed `src/server/plugin-document-entry.ts` to import the route policy directly from `plugin-document-route.ts`. The local/desktop transport remains dynamically imported only after mode policy accepts the request.
- Reworked `eslint.config.mjs` into separate flat-config scopes for ordinary app files, `app/_account/**`, and the exact bracketed streamed route. Ordinary routes retain only the core/server barrels, account composition gets only its narrow server entry, and the streamed route gets only `src/server/plugin-document-entry.ts`. The dynamic plugin-route tree is excluded from the ordinary scope to prevent exceptions from leaking to sibling endpoints. Source configuration has not been evaluated by ESLint.
- `src/server/multiuser-proxy.ts` now evaluates the desktop capability only outside multiuser mode, and applies browser Host/write-origin checks to multiuser pages and APIs before Clerk. `proxy.ts` also supplies the validated trusted-origin allowlist to Clerk middleware. The streamed route's own policy mirrors the mode split: browser policy in multiuser, desktop/local capability otherwise, then backend-verified session-token proof and controller resolution in multiuser.
- `src/runtime/multiuser-config.ts` now requires and validates the operator-provided `LH_CLERK_AUTHORIZED_PARTIES` origins in multiuser-web; `.env.example`, `docs/architecture.md`, and `docs/docker.md` describe it. `tests/deployment-mode.test.ts` has source-only validation/redaction cases for this setting. The parser returns no trusted parties for incomplete or duplicate lists rather than retaining valid-looking entries from a refused configuration.
- Restored the unrelated `puppeteer-core`, `zod`, and `concurrently` lockfile root ranges to their committed values; the remaining manifest changes are the Clerk dependency and package-key ordering only.
- `docs/reviews/per-user-accounts/a05-phase2-implementation-report.md` records this continuation.

## Findings

### Streamed route authentication

The exact streamed route remains excluded from Proxy to preserve its incoming request body. Consequently it cannot call Clerk's Next.js `auth()` helper, which requires `clerkMiddleware()` request context. The route uses the Clerk backend `clerkClient().authenticateRequest(request, { secretKey, authorizedParties })` directly, then explicitly requires a signed-in session and `tokenType === "session_token"` before forwarding the verified token to `webAccountController.resolve`. Clerk's current docs require `secretKey` or `jwtKey` for request authentication; the route supplies the configured secret key and the canonical operator allowlist. The intended policy prevents trust in request-supplied identity and preserves denial before body/params/plugin work. SDK syntax was checked against current Context7 docs; installed declarations and runtime behavior remain unverified because dependencies are not installed.

**Trusted-origin configuration decision and source change:** the operator-approved `LH_CLERK_AUTHORIZED_PARTIES` setting is now required in multiuser-web. It accepts comma-separated canonical HTTPS origins (plus HTTP localhost origins for development), rejects paths, credentials, queries, fragments, duplicate or empty items, and returns no origin list when any item is invalid. Parsing is part of readiness/configuration validation. The exact values are never logged; only the configured count is included in the redacted summary. Both the Clerk Proxy and the streamed route pass this allowlist as `authorizedParties`; the streamed route also restricts accepted token type to `session_token`. Origins are not derived from request headers. This implementation has not been verified.

### Package changes

`package.json`'s Clerk pin (`@clerk/nextjs` 7.10.0) is present with corresponding package and transitive lock entries. Its dependency ordering is now alphabetical. The ordering-only `mermaid` / `micromark-extension-math` movement does not alter dependency semantics. The `puppeteer-core`, `zod`, and `concurrently` lockfile root ranges are restored to `HEAD`; `npm ci` was not run.

### A05 limitations remain

- `web-account-composition.ts` still binds the production web account controller to an unavailable fail-closed adapter. Bootstrap, registration, account resolution and deletion disablement are not operational until A06.
- Multi-user learning routes remain intentionally unavailable and no account-isolated store/worker transport exists. The UI/provider tree and route gates are not evidence of Linux process/filesystem isolation.
- The design is still In Review; this report does not imply approval of Phase 2 or any later phase.

## Remaining gate blockers

1. The implementation is unverified and source review has remaining findings. Explicit user approval is required before tests, typecheck, lint, build, Docker, browser, or related verification.
2. A05/A06 controller integration and the independent A08 Phase 2 Resolution Step have not occurred. In particular, controller lifecycle, bootstrap concurrency/replay/rollback, registration transition, deletion/recovery, UID/GID allocation and process identity are outside this partial A05 source work.
3. The exact Proxy bypass, Clerk trusted-origin setup, and streamed route policy require focused testing to prove matcher/body preservation and auth behavior; this report provides no such evidence.
4. Shared-store and import boundaries have been source-inspected only. No ESLint or production bundle verification was run; the separate ESLint scopes remain unverified.

## Next action

Stop for explicit verification approval before running checks. If approved, agree the exact focused check set first; then conduct implementation and independent gate work sequentially, preserving each subagent final report under `docs/reviews/per-user-accounts/`. Do not start A06/A07 or claim A05 pass without the corresponding human-authorized plan and Resolution Step evidence.
