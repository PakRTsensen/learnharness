# Clerk Per-User Accounts: 39-Agent Execution Plan

**Status:** planning artifact only. This is not approval to implement.

**Authoritative design:** [`../../designs/per-user-accounts.md`](../../designs/per-user-accounts.md)

**Review status:** [`README.md`](./README.md)

This plan is subordinate to the design. If they conflict, the design wins.

## Execution gate

- The design is currently **In Review, not approved**. Stage 7 has unresolved findings; Stages 8–9 have not run.
- Do not run `A01` or later until the human explicitly clears the review gate (or the design is marked Approved).
- `A00` is read-only investigation/planning and may run before approval.
- Do not infer approval from this plan, the `clerk` branch, or any review artifact.

## Branch and remote

- Work on branch `clerk` (base: `Experimental`).
- `origin` is the fork `PakRTsensen/learnharness`, not upstream `amosblomqvist/learnharness`.
- Commit on `clerk`; the final push target is `git push origin clerk` (create it on the first push).
- Never push to `Experimental`, `main`, or upstream.
- Hold commits and pushes until all phases pass their gates and final checks are green.
- The existing `AGENTS.md` change is part of the final `clerk` commit unless the human says otherwise.

## Execution protocol

- Run agents strictly in order: `A00 -> A01 -> ... -> A38`.
- No parallel agents may write files. Sequential execution is mandatory.
- Each agent must:
  1. Read the active phase in the design and the previous handoff.
  2. Inspect the current source before editing; the source tree is authoritative over old review reports.
  3. Edit only its assigned scope.
  4. Run focused checks for its scope.
  5. Write a handoff note (Serena `s.mem`) with decisions, changed files, commands, results, and remaining risks.
- Every test or review agent must persist its final report as Markdown under `docs/reviews/per-user-accounts/`, with its scope, commands/results, findings, verdict, and remaining risks. Intermediate progress may be recorded in the same place; the final report must not claim a passing gate before every required check has finished.
- Serena is a shared toolset, not an agent. Use it for symbol/reference search, precise symbolic edits, diagnostics, and phase handoff memories.
- The test agent runs after all implementation agents in a phase. It must reproduce the design's **Resolution Step** and relevant checks.
- If the test agent finds a defect, it reports back; the implementation agent fixes it. Do not weaken, skip, or delete a test to make a phase pass.
- A phase is complete only when its resolution step, typecheck, relevant tests, lint, and any required build/Docker checks pass.
- A38 is the final independent integration/security review. Only after A38 passes may the final commit and `origin/clerk` push happen.

## Agent distribution

### Preflight — 1 agent

- **A00 — Recon and baseline (read-only)**
  - Read the design, review status, current `AGENTS.md`, `docs/development.md`, `docs/architecture.md`, and the active source tree.
  - Map the design's phase file lists to actual files; record missing/renamed paths and current composition roots.
  - Record baseline commands/results: typecheck, focused tests available before changes, lint, build prerequisites.
  - Produce the phase dependency order and the first implementation handoff.
  - Output: go/no-go memo, file map, baseline evidence, Serena memory.

### Phase 1 — 4 agents

- **A01 — Runtime modes/config**
  - `src/runtime/deployment-mode.ts`, `multiuser-config.ts`, `readiness.ts`, `config.ts`, `.env.example`.
  - Explicit mode selection, fail-closed validation, account roots, IPC paths, writable mounts, secret-free diagnostics.
- **A02 — Composition/build**
  - `src/server/index.ts`, `src/server/stores.ts`, `instrumentation.ts`, `next.config.ts`, package scripts/dependencies, `scripts/build-server.mjs`, desktop payload tests.
  - Keep the existing single-account/desktop composition root; do not initialize global account stores in multi-user web mode.
- **A03 — Docs/tests for the deployment skeleton**
  - `docs/architecture.md`, `docs/docker.md`, `.gitignore`, deployment/readiness tests.
- **A04 — Phase 1 test agent**
  - Reproduce the Phase 1 resolution step: valid/invalid modes, fail-closed startup, unchanged desktop stores, desktop payload checks.
  - Run typecheck, focused tests, lint; report evidence.

### Phase 2 — 4 agents

- **A05 — Clerk UI/routes**
  - Sign-in/sign-up pages, first-admin setup UI, Clerk webhook route, `proxy.ts`, layout/sidebar/settings account surfaces.
  - Preserve host/cross-site defenses and the desktop capability branch.
- **A06 — Registry/provisioning**
  - `src/accounts/contracts.ts`, `src/controller/clerk-identity.ts`, `registry.ts`, `provisioning.ts`, `capabilities.ts`.
  - Serialized bootstrap, UID/GID allocation, lifecycle, roles, deletion/recovery, non-reuse ledger.
- **A07 — Request context/IPC protocol**
  - `src/accounts/request-context.ts`, `src/controller/protocol.ts`, supporting contracts and test seams.
  - Session proof is forwarded; account authority is never trusted from the client.
- **A08 — Phase 2 test agent**
  - Closed registration before bootstrap, secret replay/retry/consumption, concurrent bootstrap, role transfer, webhook forgery, deletion/recovery, recreated identities, UID/GID non-reuse, desktop without Clerk.
  - Run the Phase 2 resolution step and full focused checks.

### Phase 3 — 5 agents

- **A09 — Narrow helper/path primitives**
  - `helper/`, `helper/IDENTITY_TOOLS.md`, `src/helper/paths.ts`.
  - Descriptor-relative/no-link operations, ownership checks, fixed executable launch, no general root surface.
- **A10 — Controller lifecycle**
  - `src/controller/main.ts`, `identity.ts`, `worker-manager.ts`.
  - Registry/capability verification, worker start/stop/fencing/restart/deletion, generation ownership.
- **A11 — IPC and worker runtime**
  - `src/controller/ipc-server.ts`, `src/server/account-client.ts`, `src/worker/main.ts`, `service.ts`, `resources.ts`.
  - Bounded authenticated IPC, cancellation/backpressure, sanitized worker entry, account-local stores, admission/resource controls.
- **A12 — Docker/deployment identity model**
  - `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.yml`, `scripts/build-server.mjs`.
  - Root-owned helper, distinct unprivileged identities, read-only root, designated writable mounts, no Docker socket.
- **A13 — Phase 3 test agent**
  - Real Docker UID/GID/group inspection, cross-home traversal, symlink/hardlink/descriptor attacks, forged IPC/capability replay, generation fencing, idle/restart/delete behavior, unchanged desktop execution.
  - Run the Phase 3 resolution step.

### Phase 4 — 5 agents

- **A14 — File contracts/store/library**
  - `src/files/contracts.ts`, `src/store/files.ts`, `src/files/library.ts`, `src/files/validation.ts`.
  - Portable file IDs, categories, reference tracking, validation composition, private downloads.
- **A15 — Upload channel/parser**
  - `src/helper/upload-channel.ts`, `src/parser/main.ts`, `app/api/graph/import/route.ts`.
  - Root-locked staging, account-owned descriptors, byte/disk limits, immutable parser input, atomic promotion.
- **A16 — Agent file/temp paths**
  - `src/agent/tools/fs-shared.ts`, `file-access.ts`, `src/server/file-access.ts`, PDF/image/Claude Code/Chromium temporary producers.
  - Workspace-only web behavior; no shared predictable temp paths; retain desktop policy.
- **A17 — File routes/UI**
  - `app/api/files/**`, file library, graph sources/deletion, attachments, notes import UI, image references.
  - Authenticated private/no-store streams; no public static file URLs.
- **A18 — Phase 4 test agent**
  - Upload/processing/download as two users; ownership/mode at creation, races, links, special files, descriptor reopening, interrupted streams, cross-account IDs, all file types, export/re-import.
  - Run the Phase 4 resolution step.

### Phase 5 — 5 agents

- **A19 — Provider policy/executor/capabilities**
  - `src/providers/policy.ts`, `shared-executor.ts`, `capabilities.ts`.
  - Shared/BYOK resolution, generation snapshots, allowlisted provider operations, opaque capabilities, no key disclosure.
- **A20 — Personal secrets/shared settings**
  - `src/controller/personal-secrets.ts`, `shared-settings.ts`, admin provider routes/UI.
  - Versioned encryption, rotation, revocation, controller-only shared state, no private-account admin APIs.
- **A21 — Provider server routes**
  - `src/server/keys.ts`, `src/store/auth.ts`, custom-provider/model catalog/search/subscription/STT routes and call sites.
  - Replace shared `process.env` mutation with request/job-scoped policy; preserve desktop behavior.
- **A22 — Plugin/event/job isolation**
  - `src/server/plugins.ts`, plugin host/backends, `src/core/events.ts`, event stream, activity/job delivery, plugin UI.
  - Account-scoped initialization/events/jobs; same-account plugin trust stated accurately; no shared registries.
- **A23 — Phase 5 test agent**
  - Shared-key leak scans across browser/files/env/archives/logs, admin-default generation behavior, personal-secret rotation/loss, admin boundary, plugin UID, OAuth exclusion.
  - Run the Phase 5 resolution step.

### Phase 6 — 5 agents

- **A24 — Archive contracts/snapshot/export**
  - `src/archive/contracts.ts`, `snapshot.ts`, `export.ts`.
  - Versioned manifest, portable references, quiescence/flush, cache exclusion, full/chat/graph exports.
- **A25 — Encryption/validation/migrations**
  - `src/archive/encryption.ts`, `validate.ts`, `migrations.ts`.
  - Memory-hard KDF bounds, authenticated payload/header, traversal/link/duplicate/checksum/version rejection, non-mutating validation.
- **A26 — Import/restore/rollback**
  - `src/archive/import.ts`, generation pointer, category journal, fsync ordering, startup reconciliation, rollback.
  - Full replacement and category-only replacement; disabled restored plugins; no automatic job replay.
- **A27 — Archive routes/UI/store/job integration**
  - `app/api/account/export|import`, account archive UI, store/job/settings/theme/prompt integration.
  - Replacement confirmation, passphrase handling, private/no-store downloads, restore/reconnect instructions.
- **A28 — Phase 6 test agent**
  - Full/chat/graph round trips across UIDs/Clerk IDs, wrong/lost passphrase, tampering, archive bombs, future/corrupt versions, full disk, crashes at journal/pointer/fsync points, rollback, excluded artifacts.
  - Run the Phase 6 resolution step.

### Phase 7 — 6 agents

- **A29 — Legacy inventory/claim/CLI**
  - `src/legacy/inventory.ts`, `claim.ts`, `scripts/legacy-repair.mjs`.
  - Journaled all-or-nothing claim, non-destructive validated copy, reference rewrite, startup reconciliation.
- **A30 — Legacy route/UI/docs**
  - `app/api/account/legacy-claim/route.ts`, `components/settings/legacy-claim.tsx`, deployment troubleshooting.
  - Failure codes/counts only; no private-content repair API.
- **A31 — Chat/study/Claude Code routes**
  - Remaining chat, side-chat, study, Claude Code, subscription routes/services not converted earlier.
- **A32 — Graph/plugin/settings routes**
  - Graph costs/coverage/status/positions/render settings, plugin documents/assets, settings/themes/prompts.
- **A33 — Resource controls/deployment**
  - `src/worker/resources.ts`, controller/helper launch limits, `docker-compose.yml`, `.env.example`, docs.
  - Per-account/global limits, backpressure, fail-closed unsupported mandatory controls, disk-risk documentation.
- **A34 — Phase 7 test agent**
  - Legacy claim complete/missing/ambiguous/invalid files, crash injection, no partial migration; all-route account-scope inventory; two-account load/resource limits; full suite + desktop compatibility.
  - Run the Phase 7 resolution step.

### Phase 8 — 3 agents

- **A35 — Security/archive docs and Docker smoke**
  - `docs/multiuser-security.md`, `docs/account-archives.md`, `scripts/smoke-multiuser.mjs`.
- **A36 — User/deployment docs alignment**
  - `README.md`, `docs/architecture.md`, `docs/docker.md`, `.env.example`, settings/help copy.
- **A37 — Release evidence test agent**
  - Build, typecheck, lint, unit/integration tests, Docker isolation, archive round trips, failure injection, desktop payload.
  - Record exact commands and outcomes for the final PR/commit evidence.

### Final — 1 agent

- **A38 — Independent integration/security review**
  - Read-only review of the entire diff against the design and phase gates.
  - Verify no multi-user route still uses global stores, no agent/plugin can traverse another account, no shared/personal secret leak, no desktop regression, no missing mandatory gate.
  - Produce final go/no-go. Only then commit and push `origin clerk`.

## Totals

| Kind | Count |
|---|---:|
| Implementation agents | 29 |
| Phase test agents | 8 |
| Preflight recon | 1 |
| Final independent review | 1 |
| **Total** | **39** |

## Phase gate checklist

For every phase, record in the handoff:

- Resolution Step reproduced by the test agent.
- `npm run typecheck`.
- Relevant focused tests, plus the broader suite where practical.
- `npm run lint`.
- `npm run build` when the phase touches build/runtime packaging.
- Docker/real-identity checks where the design requires them.
- Any skipped or unverified item, with the reason.
