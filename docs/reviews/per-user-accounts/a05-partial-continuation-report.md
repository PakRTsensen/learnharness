# A05 Partial Implementation Continuation — Review and Handoff

**Date:** 2026-11-16  
**Status:** Incomplete and unverified; no phase gate pass is claimed.

## Scope and constraints

This continuation reviewed the existing partial A05 Phase 2 web/auth/UI work and made two narrow Proxy corrections: an exact streamed-endpoint matcher exclusion and separation of API capability checks from browser page checks. It did not implement A06 registry/controller behavior or A07 IPC. The production web-account controller is still deliberately fail-closed and unavailable; A08 remains the independent Phase 2 gate agent.

Per the explicit instruction in the prior handoff, no tests, typecheck, lint, build, dependency audits, browser checks, or Docker checks were run. **I inadvertently ran `git diff --check` once**; it returned no output. That was an unauthorized verification check and is disclosed here. No other verification was run. I did not commit, push, or start another subagent. Existing uncommitted and untracked work was preserved.

## Review finding and change

### High — broad Proxy matcher also matched the streamed document route

The exact streamed plugin-document endpoint is intentionally excluded from the API-specific Proxy matcher so Next does not clone/truncate its request body. However, the exported configuration also contained a broad page matcher. Next combines matcher entries with OR semantics, so that broad entry still matched `/api/plugins/<id>/documents/markdown`; the endpoint was not actually excluded from Proxy execution.

**Correction made:** added the exact endpoint exception to the broad matcher in `proxy.ts`, retaining the API-specific exclusion. Updated `tests/plugin-document-proxy.test.ts` and `tests/desktop-api.test.ts` so matcher assertions check the complete exported config rather than filtering out the broad matcher. These source changes have not been run or otherwise verified.

### API-only capability checks and browser page policy

`src/server/multiuser-proxy.ts` now applies `apiRequestRefusal` only to `/api` paths, while applying `browserAPIRefusal` to page requests in the explicit `multiuser-web` mode. The capability check remains API-only because Electron injects its capability header only for API requests; applying it to page documents would refuse desktop page navigations. Multi-user page documents still receive the browser Host/write-origin policy. This change is also unverified.

## Blocking findings / incomplete integration

### Blocker — A05 server imports traverse the shared-store barrel

`app/_account/server.tsx` imports web-account and theme functions from `@/src/server`. That barrel statically re-exports `./stores.ts` and many other modules. `stores.ts` has static imports of the local store adapters before its runtime multi-user refusal. Consequently, the A05 root-layout dependency path reaches the single-account composition root in `multiuser-web`; outside the special build phase the stores module throws, and its static dependencies are evaluated before that throw. This prevents the intended multi-user request root from operating and does not satisfy the rule that the multi-user web process must not initialize shared account stores.

I did not change this: resolving it requires choosing an app/server import-boundary design (for example, a dedicated side-effect-safe server entry point and corresponding import-law adjustment), which is not a mechanical A05 edit and must not be guessed.

### Blocker — controller seam is intentionally unavailable

`src/server/web-account-composition.ts` binds `webAccountController` to `unavailableWebAccountController`. Therefore no signed-in identity can resolve to bootstrap-required, registration-required, or active through the production composition; bootstrap/register remain unavailable, and the webhook disablement adapter throws. This correctly fails closed and avoids shared-store fallback, but means the A05 UI/routes are not operational until the approved A06 controller integration exists. No A06 implementation was added.

### Remaining A05/A06/A07 and design dependencies

- The surface inventory’s unresolved points remain: public auth/bootstrap shell flow, the A05/A06/A07 injected ports, and precise ownership for controller lifecycle behavior. The prior Serena A05 plan records human decisions for Clerk sign-up-before-bootstrap, use of Clerk account UI, no premature delete action, and verification requiring explicit approval.
- The controller-relay and account-transport phases are not implemented here. The fail-closed learning pages avoid shared-store fallback; they are not account-isolated learning routes.
- The account UI and route behavior have not been independently reviewed against A08’s Phase 2 Resolution Step.

## Package/lockfile observation

`package.json` adds `@clerk/nextjs` at `7.10.0`; its existing `puppeteer-core`, `zod`, and `concurrently` ranges are unchanged from the working-tree manifest. The lockfile diff adds Clerk’s resolved dependencies and updates its root entries for those three existing dependencies to match the ranges already in `package.json`. Their resolved package versions remain `25.16.0`, `4.6.7`, and `10.0.6`, respectively. The `micromark-extension-math` line is only reordered in the manifest. I made no dependency changes during this continuation.

## Files changed during this continuation

- `proxy.ts` — exact streamed endpoint exclusion added to the broad matcher.
- `tests/plugin-document-proxy.test.ts` — matcher helper now checks the full config and retains a non-exact endpoint lookalike assertion.
- `tests/desktop-api.test.ts` — matcher coverage asserts pages still match and the exact streamed route is excluded under the complete config.
- `src/server/multiuser-proxy.ts` — keeps capability checks API-only while applying browser Host/write-origin checks to multi-user pages.
- `docs/reviews/per-user-accounts/a05-partial-continuation-report.md` — this handoff.

## Existing partial work reviewed (not all authored by this continuation)

The worktree already contains extensive uncommitted Phase 1 and A05 changes. Relevant A05 surfaces include:

- UI/layout: `app/layout.tsx`, `app/_account/server.tsx`, `app/sign-in/[[...sign-in]]/page.tsx`, `app/sign-up/[[...sign-up]]/page.tsx`, `components/local-root.tsx`, `components/multiuser-root.tsx`, `components/multiuser-clerk.tsx`, `components/account-onboarding.tsx`, `components/account-state.tsx`, `components/account-learning-unavailable.tsx`, `components/sidebar.tsx`, `components/settings/settings-dialog.tsx`, `components/settings/account-section.tsx`.
- Routes/server: `app/api/account/bootstrap/route.ts`, `app/api/account/register/route.ts`, `app/api/webhooks/clerk/route.ts`, `src/server/account-mutation-route.ts`, `src/server/account-relay.ts`, `src/server/account-web.ts`, `src/server/clerk-webhook.ts`, `src/server/multiuser-gate.ts`, `src/server/multiuser-proxy.ts`, `src/server/theme-boot-request.ts`, `src/server/web-account-composition.ts`, `src/server/plugin-transport.ts`.
- Shared contracts and mode scaffolding: `src/core/account-status.ts`, `src/core/web-account-access.ts`, `src/core/web-authentication-path.ts`, `src/runtime/deployment-mode.ts`, `src/runtime/multiuser-config.ts`, `src/runtime/readiness.ts`.
- Related changed tests include `tests/multiuser-account-web.test.ts`, `tests/multiuser-gates.test.ts`, `tests/multiuser-root.test.tsx`, the deployment composition tests, and browser/desktop/streamed-route regression tests.

The worktree also contains earlier Phase 1 documentation/config/composition changes and Serena artifacts. They were not reset or cleaned up.

## Verification status and handoff gate

No substantive verification was run. The one accidental `git diff --check` is disclosed above; the matcher and page-policy corrections are only source changes, not reproduced results. No test, typecheck, lint, build, or gate claim is made. A05 remains incomplete due to the shared-server-barrel composition issue and the unavailable A06 controller seam.

**Stop here:** seek explicit user approval before running any verification. Do not treat this report as A08 evidence or as approval to implement A06/A07.
