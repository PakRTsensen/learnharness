# Stage 6: Comprehension Test

* **Target**: `docs/designs/per-user-accounts.md`
* **FeatureRange**: Lines 1–247
* **DetailedRange**: Lines 248–end
* **Reviewer**: `egm-comprehension`
* **Status**: Complete

## What this proposes

LearnHarness will add Clerk-authenticated accounts to a single Docker-hosted web deployment, with the first locally provisioned account becoming administrator while desktop mode remains local and single-user. A root-owned broker will allocate non-reused Linux UID/GIDs, launch fenced per-account workers, and mediate files, jobs, plugins, and provider access so that kernel-enforced ownership isolates accounts rather than relying only on application route checks. Administrators will manage shared provider defaults without reading users’ private data; shared keys will be used through opaque brokered capabilities, while personal keys will be encrypted at rest and released only to their owning worker. Users will receive validated, replace-not-merge export/import for complete encrypted archives or chat-only and graph/knowledge-only archives, with migration and rollback support but no scheduled backups. Legacy shared data will remain quarantined until the first administrator completes an all-or-nothing claim, and public multi-user mode will fail closed until the phased isolation and security gates pass.

## How the existing system works, per this document

LearnHarness currently has no user accounts, and its Docker deployment expects an external access gate. Chats, graph ledgers, jobs, settings, plugins, and credentials occupy shared application-data paths, while the web process, agent tools, and trusted plugins operate with shared server filesystem privileges rather than per-user Linux identities. The existing store ports and JSON/JSONL adapters will initially be retained inside account workers, and the existing desktop composition root and local storage behavior will remain supported; legacy shared web data will not be assigned automatically during upgrade.

## Findings

### C-1 — Major: Category-only restore does not define the resulting dependency state

**Affected scope**: CUJ 5; file dependencies; archive contents; import/replacement; Phase 6; integration tests.

The document says category-only replacement leaves other categories unchanged, but also requires dependency resolution without defining the user-visible outcome. It is unclear whether required assets are bundled, must already exist, are copied from another category, or remain references. It is also unclear whether dependency resolution may modify records in a non-selected category. “Retain or explicitly rebuild” does not specify which occurs or how conflicts and missing dependencies are handled.

A reader can understand that validation and a dependency plan precede commit, but cannot reliably describe the resulting account state after category-only restore.

### C-2 — Major: Legacy repair workflow has an unstated prerequisite

**Affected scope**: Legacy Data and Rollout; Phase 7.

A legacy claim is blocked when a referenced file is missing, inaccessible, ambiguous, or invalid, and the administrator is told to repair paths and retry. Legacy data is inaccessible to every account until claim success, and the UI supplies only non-content-bearing diagnostics. The document does not explain whether repair requires the Docker host operator, direct volume access, a separate repair interface, or another privilege.

### C-3 — Major: Existing access-gate context is not self-contained

**Affected scope**: The Problem; Authentication and Request Authorization; Phase 2.

The existing deployment’s external access gate is introduced as a trust boundary, but the design does not say whether Clerk replaces it, supplements it, or assumes its removal. This affects public sign-up and first-admin exposure. Retained browser host/cross-site protections and the desktop capability check are named without explaining their purposes and guarantees or linking their documentation.

### C-4 — Major: Account deletion and cleanup semantics are undefined

**Affected scope**: Account lifecycle/webhooks; Phase 2; end-to-end tests.

A verified Clerk deletion webhook disables access and schedules an explicit, non-immediate cleanup flow, but the actor, trigger, retention behavior, and completion semantics are missing. A reader cannot determine whether cleanup erases files and personal credentials, whether separate confirmation is required, or how it interacts with archives, jobs, and an administrator account. Only initial disablement is clear.

### C-5 — Nit: Initial upload placement contradicts staging

**Affected scope**: Account Storage and Worker Runtime; Phase 4 upload channel.

One paragraph says every uploaded file is written directly beneath its designated category, while the following paragraphs describe creation in root-locked staging followed by atomic promotion. Ownership from creation is consistent, but initial placement is not.

### C-6 — Nit: “Administrator-owned” shared-key storage is ambiguous

**Affected scope**: Shared/Personal Provider Configuration; Security and Privacy.

“Administrator-owned, broker-readable location” can mean logical admin control or Linux ownership by the administrator account UID. The latter conflicts with shared keys being outside account storage and inaccessible to account UIDs. The intended broker-controlled storage outside account homes needs unambiguous wording.

## Assessment

* **Major findings**: 4
* **Nits**: 2

The reviewer could restate the main architecture and current system. The unresolved comprehension issues concern exact restore outcomes, legacy recovery prerequisites, existing request-security boundaries, and account deletion behavior.
