# A05 — Surface inventory (read-only reconnaissance)

**Date:** 2026-11-15  
**Agent:** Read-only exploration agent  
**Status:** Inventory only; no implementation or approval implied.

## Authoritative scope

`docs/designs/per-user-accounts.md` Phase 2 (lines 305–325) and `docs/reviews/per-user-accounts/EXECUTION_PLAN.md` A05. Multi-user mode is selected only by `LH_DEPLOYMENT_MODE=multiuser-web`; desktop and single-user must retain their existing composition roots. The larger design remains In Review; the human-approved phase-gate workflow is not a blanket approval for unrelated implementation.

## Surfaces and required work

1. **`app/layout.tsx` / `src/server/theme-boot.ts`**
   - `RootLayout` currently calls synchronous `readThemeBoot()` unconditionally after `connection()`.
   - A request-scoped theme bootstrap must preserve `connection()` and prevent cross-user caching; the shared desktop/single-user path must remain unchanged.
   - Clerk provider/context must be explicitly mode-gated, not inferred from Clerk variables.
   - Public sign-in/sign-up/bootstrap routes use the same root layout; ambient UI must not issue protected requests before sign-in.
   - `readThemeBoot()` imports shared synchronous stores. A scoped factory/port is needed rather than exporting Clerk metadata or adding a multi-user fallback to shared stores.

2. **`components/sidebar.tsx`**
   - `AppShell` is the global account-context integration point. The sidebar footer near Activity/Settings is a candidate location for account/sign-out controls.
   - Desktop UA detection (`IS_ELECTRON`) is presentation only and must not become deployment authority.
   - `window.lh` bridges, shortcuts, native updates, localStorage, and chat behavior must remain unchanged outside multi-user mode.
   - A decision is required for the account control: use Clerk's supplied account control or a narrower application account/sign-out surface.
   - Account switching must not retain another account's chat/settings/plugin/SSE client state.

3. **`components/settings/settings-dialog.tsx`**
   - Settings uses `GET /api/settings` and `PUT /api/settings/:section` via the single `write` seam. This boundary remains; no client-supplied account ID is permitted.
   - A multi-user-only Account section must provide account, sign-out, and lifecycle/deletion status. Exact recovery/deletion action scope must follow the approved plan.
   - Preserve `initialSection`, plugin deep links, `WriteOrderContext`, theme updates, and native settings navigation.

4. **`app/page.tsx`, `app/chat/new/page.tsx`, `app/chat/[id]/page.tsx`**
   - Home/new/chat currently bootstrap chat/theme/settings through shared process-global stores/services.
   - Phase 2 says these entry points must read authenticated account data rather than global stores. Phase 3 provides the real account transport; the multi-user learning UI must remain fail-closed, never fall back to shared stores.
   - `ChatPage` additionally reads process-global turn and compaction state. Do not mask this as completed isolation by only replacing settings access.

5. **`proxy.ts` / `src/server/desktop-access.ts`**
   - The current Proxy matcher covers APIs only. Browser host and write-origin checks must precede multi-user Clerk handling; desktop capability authorization remains exactly desktop-only.
   - Explicit public routes are sign-in, permitted sign-up/bootstrap surfaces, and the verified Clerk webhook. APIs must return authentication denials as API responses rather than HTML redirects.
   - Proxy is only one layer: controller verification and account binding in A06/A07 remain mandatory.

6. **`src/server/plugin-transport.ts` / `createPluginDocumentRoute`**
   - The exact streamed document route bypasses Proxy to avoid a truncated request-body clone and applies `apiRequestRefusal` itself. The shared multi-user defense must be applied there before params/body/converter work; widening the matcher to include this route is unsafe.

## Relevant regression tests

- `tests/browser-api-access.test.ts`: host, CSRF, Proxy, and desktop behavior.
- `tests/desktop-api.test.ts`: all API methods, capability, trusted-origin header injection.
- `tests/plugin-document-browser-access.test.ts`: refusal before streamed route work.
- `tests/plugin-document-proxy.test.ts`: exact matcher exception and sibling/lookalike routes.
- `tests/deployment-mode.test.ts`, `tests/deployment-composition.test.ts`: explicit mode and unchanged original stores.
- `tests/render-layout.test.tsx`, `tests/render-sidebar.test.tsx`, `tests/render-settings.test.tsx`, `tests/settings-dialog-interaction.test.tsx`, `tests/render-update-settings.test.tsx`, `tests/page-surface-integration.test.tsx`: browser/Electron surfaces.
- `tests/desktop-payload.test.ts`: standalone Electron payload.

## Unresolved design decisions before implementation

- How to reconcile pre-bootstrap closed registration with the first person using Clerk sign-up/sign-in before supplying the host secret.
- Public account fields and UI controls, including whether managed Clerk profile/account deletion is offered in A05.
- The A05/A06/A07 in-process/test ports for bootstrap, registration state, account lifecycle, and session proof; never create an HTTP-trusted account or Clerk identity field.
- Explicit public/auth-shell behavior to prevent protected layout/provider requests on sign-in/sign-up/bootstrap.

## Security/desktop requirements

1. No unconditional Clerk provider/hooks in desktop or single-user mode.
2. No desktop capability bypass in multi-user mode; no account IDs accepted as client authority.
3. No fallback to original shared stores when Clerk, registry, controller, or relay fails.
4. The account UI is not a claim of completed multi-user learning routes. That remains gated by Phases 3–5.
