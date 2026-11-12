# Per-User Accounts — Implementation Progress

**Scope of this PR:** Milestone 1 (Phases 1–2) only.

**Design status:** unchanged — the primary design remains *In Review*. This ledger records implementation evidence; it is not design approval and does not authorize Phases 3–8.

## Milestone 1 checklist

### Phase 1 — Separate web, controller, worker, and desktop composition roots

| Item | Status | Reference |
| --- | --- | --- |
| Explicit `desktop` / `single-user-web` / `multiuser-web` selection; invalid values fail closed | Done | `src/runtime/deployment-mode.ts` |
| Multiuser configuration: host paths, UID/GID ranges, mounts, limits, runtime auth | Done | `src/runtime/multiuser-config.ts` |
| Startup readiness, mandatory mount/config checks, local-dev directory preparation | Done | `src/runtime/readiness.ts`, `instrumentation.ts` |
| Host paths separated from `LH_DATA_DIR` defaults | Done | `config.ts` (`RUNTIME_PATHS`) |
| Global store composition refuses multiuser-web | Done | `src/server/stores.ts` |
| Sanctioned multiuser app→controller relay barrel | Done | `src/multiuser/index.ts`, `eslint.config.mjs` |
| Request-scoped relay/session context with learning gate | Done | `src/accounts/request-context.ts`, `src/server/index.ts` |
| Instrumentation dispatches by mode; no plugin host in multiuser | Done | `instrumentation.ts` |
| Docker runtime configuration documented | Done | `.env.example`, `docker-compose.yml`, `docker-entrypoint.sh`, `docs/docker.md` |
| Payload leak guard for controller/account state | Done | `scripts/build-server.mjs`, `tests/desktop-payload.test.ts` |
| Focused mode/config/readiness tests | Done | `tests/deployment-mode.test.ts` |

### Phase 2 — Clerk identity, bootstrap, and controller-owned provisioning

| Item | Status | Reference |
| --- | --- | --- |
| Account registry contracts and strict validation | Done | `src/accounts/contracts.ts` |
| Serialized registry, UID/GID allocation, non-reuse ledger, lifecycle | Done | `src/controller/registry.ts` |
| Single-commit first-admin bootstrap and secret consumption/retry | Done | `src/controller/provisioning.ts` |
| Runtime Clerk session verification (issuer/JWKS/subject/azp) | Done | `src/controller/clerk-identity.ts` |
| Offline/local HS256 session provider and Clerk token exchange | Done | `src/controller/session-token.ts`, `app/api/auth/**` |
| Verified Clerk deletion webhook (disablement only) | Done | `src/controller/clerk-webhook.ts`, `app/api/webhooks/clerk/route.ts` |
| Account status, deletion/recovery, administrator transfer APIs | Done | `app/api/account/**` |
| Sign-in/sign-up/first-admin/account surfaces | Done | `app/sign-in/**`, `app/sign-up/**`, `app/first-admin/page.tsx`, `app/account/page.tsx`, `components/auth/**`, `components/account/**` |
| Multiuser auth gate; existing host/cross-site defenses retained | Done | `proxy.ts` |
| Minimal multiuser layout (no single-user store/theme reads) | Done | `app/layout.tsx`, `src/core/themes.ts` (`defaultThemeBoot`) |
| Capability and controller-protocol primitives | Done | `src/controller/capabilities.ts`, `src/controller/protocol.ts` |
| Registry/provisioning/lifecycle/auth tests | Done | `tests/account-registry.test.ts`, `tests/account-provisioning.test.ts`, `tests/account-lifecycle.test.ts`, `tests/clerk-auth.test.ts`, `tests/controller-protocol.test.ts`, `tests/multiuser-proxy.test.ts` |

## Verification performed

Commands run from the repository root on 2026-11-12:

```bash
npm ci
npm run plugins:setup
npx tsc --noEmit
node_modules/.bin/tsx --test tests/deployment-mode.test.ts \
  tests/account-registry.test.ts tests/account-provisioning.test.ts \
  tests/account-lifecycle.test.ts tests/clerk-auth.test.ts \
  tests/controller-protocol.test.ts tests/multiuser-proxy.test.ts \
  tests/browser-api-access.test.ts tests/desktop-api.test.ts \
  tests/plugin-document-proxy.test.ts tests/plugin-document-browser-access.test.ts
```

Results recorded at implementation time:

- Typecheck: **pass** (`tsc --noEmit`, exit 0).
- ESLint on every changed/new TypeScript file (including the new barrel): **pass**, 0 problems.
- Desktop payload leak guard: **10 pass, 0 fail**, including the new controller/account state case.
- New Phase 1–2 tests: **63 pass, 0 fail** (15 deployment, 10 registry, 8 provisioning, 6 lifecycle, 9 identity, 8 capability/protocol, 7 proxy).
- Adapted existing suites: **24 pass, 0 fail** (browser API 11, desktop API 4, plugin documents 8 + 1).
- `npm run build`: **pass** (production Next build; `/sign-in`, `/sign-up`, `/first-admin`, `/account`, auth/account APIs, and `/api/webhooks/clerk` emitted).
- Built standalone server smoke in `multiuser-web` + local provider (isolated `/tmp` paths): unauthenticated `/api/account` → 401; pre-bootstrap local sign-in → 200 `bootstrapRequired:true` with no account; bootstrap secret → 200 administrator with UID/GID 200000; authenticated `/api/account` → 200; authenticated `/api/chats` → 503 `worker_runtime_unavailable`; registry mode `0600`.
- No Docker/UID integration test was possible in the implementation sandbox: the Docker socket is not accessible and the session is non-root. This is the Phase 3 resolution step and remains outstanding; the local-provider smoke above exercises the same HTTP paths without Docker.

## Deviations and limitations in this milestone

- **Learning routes are gated.** Multiuser mode serves only authentication, bootstrap, account lifecycle, sign-out, and the verified Clerk webhook. Chats/graph/files/plugins/settings/jobs/events return `503 worker_runtime_unavailable`; no shared-store fallback exists.
- **Clerk UX is a session-token exchange, not `@clerk/nextjs` components.** This follows the approved runtime-verification approach: the host configures issuer/JWKS/origin at runtime, no publishable key is baked at build time, and the offline provider uses the same session contract. The sign-in page links to a configured Clerk hosted URL and accepts a session token (or a same-origin `__session` cookie) for exchange.
- **Account-root ownership is advisory until Phase 3.** Existence, directory-ness, symlink rejection, read-only-root declaration, and mounts are mandatory now; root ownership/private mode is reported as an advisory because the root helper does not exist yet. The Docker entrypoint keeps its transitional `node` ownership.
- **Physical deletion is deferred to the Phase 3 helper.** User-confirmed deletion disables the account and starts the seven-day registry window; after the window the registry record is retired and the UID/GID is burned, but the web process does not delete account content. Tests assert the content is still present.
- **Sidebar/settings account chrome is deferred.** The multiuser shell is minimal, so sign-out/account/deletion status lives at `/account`; adding rows to the single-user sidebar/settings dialog would be unreachable dead UI until Phase 3 admits the learning shell.
- **Legacy claim is not implemented.** Bootstrap records legacy-claim eligibility for the first administrator; the inventory/claim journal is Phase 7.
- **Resource limits are validated configuration only.** No cgroup/process enforcement exists before the account-worker runtime; the design's fail-closed resource startup refusal belongs to Phases 3 and 7.
- **Archives, provider executors, and per-account plugins are not implemented.** Their modules/routes remain Phase 4–7 work.

## Next gates (not part of this PR)

1. Phase 3: non-root controller, narrow root helper, per-account worker generations, real Docker UID/GID/filesystem evidence.
2. Phase 4–5: account-owned files/FileStore and provider/plugin separation.
3. Phase 6–7: versioned archives, crash-safe replacement, legacy claim, resource enforcement, full route migration.
4. Phase 8: security documentation, repeatable two-account Docker smoke scenario, release evidence.
