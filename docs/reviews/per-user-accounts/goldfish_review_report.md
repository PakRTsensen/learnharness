# Goldfish Annotated Review Report

**Target:** `/root/learnharness-code/docs/designs/per-user-accounts.md` (re-audit FeatureRange, lines 1–277)
**Status:** pending resolution
**Source:** `/root/learnharness-code/docs/reviews/per-user-accounts/critic_report.md`

## Prioritized Findings & AI Suggestions

### 1. Crash-safe bootstrap state machine [Design D7-01] - Severity: Blocker
* **Affected Scope:** CUJ 1; Components; Legacy Data and Rollout.
* **Discrepancy Description:** Controller and root-helper effects lack a cross-component crash recovery protocol.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Exactly one administrator and retry-before-commit require durable reconciliation rather than an assumed atomic cross-process transaction.
* ***Proposed Edit:*** Add transaction IDs and a controller-owned bootstrap journal: verify secret; reserve a pending UID/GID; idempotently prepare the home; durably commit registry, ledger, administrator binding, and secret consumption together; then idempotently finalize/health-check. On startup reconcile journal and helper state before retry, registration, or claim. Absent a commit record, roll back pending effects without committing an account/allocation; after commit, complete rather than retry bootstrap. Test crashes at every step.

### 2. Stop surviving account writers [Design D7-02] - Severity: Blocker
* **Affected Scope:** Worker runtime; plugins; snapshots; restore; deletion.
* **Discrepancy Description:** Capability fencing rejects new requests but cannot stop retained descriptors or descendants from writing.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Single-writer, immutable snapshots, restore, and erasure depend on process containment.
* ***Proposed Edit:*** Require one root-controlled cgroup v2 subtree per worker generation containing every plugin/descendant; close all non-allowlisted descriptors on exec; forbid cgroup migration; freeze and verify the generation for snapshots; kill and verify the complete cgroup before restore, replacement, or permanent deletion. Do not commit while any old-generation writer survives. Add hostile-plugin and crash/restart tests.

### 3. Interactive and background capability contracts [Design D7-03] - Severity: Major
* **Affected Scope:** Controller capabilities; authentication; provider execution; background work.
* **Discrepancy Description:** Subject binding, replay, expiry, and offline background authority are underspecified.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Recovered work may have no active Clerk session and nonces must survive restart.
* ***Proposed Edit:*** Separate short-lived subject/session capabilities for interactive admission from account-bound durable work authority for admitted background jobs. Bind audience, account, generation, operation and normalized parameter digest, expiry, and nonce; consume atomically with durable replay records; revoke on deletion/disablement/generation change; never reassign work after Clerk deletion/recreation.

### 4. Enforceable root-helper protocol and post-exec state [Design D7-04] - Severity: Major
* **Affected Scope:** Deployment and trust boundaries; Components.
* **Discrepancy Description:** Helper command authority and retained privilege are not bounded.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** A compromised controller must not obtain general root operations.
* ***Proposed Edit:*** Define fixed command allowlists, roots, targets, descriptor types, and executable paths; helper executable is root-owned and callable only through its authenticated controller channel. Children clear permitted/effective/ambient capabilities and supplementary groups, set `no_new_privs`, retain seccomp, and receive only explicitly authorized descriptors. Test malicious controller requests and `/proc` credential state.

### 5. Race-safe workspace operations [Design D7-05] - Severity: Major
* **Affected Scope:** Filesystem tools; uploads; library downloads; promotion.
* **Discrepancy Description:** Path rejection does not prevent same-account rename/symlink races.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Checks must apply to the object actually opened.
* ***Proposed Edit:*** Require descriptor-relative resolution throughout with `openat2` beneath/no-magic-link constraints or a proven equivalent, for reads, writes, traversal, promotion, and downloads. Never reopen validated objects by absolute path. Add concurrent rename, symlink, hardlink, and descriptor-reopening tests.

### 6. Same-account plugin credential authority [Design D7-06] - Severity: Major
* **Affected Scope:** Plugins; personal credentials; worker IPC and memory.
* **Discrepancy Description:** Same-UID plugin trust does not state whether it includes BYOK, worker memory, and private IPC.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected restricted plugin access.
* ***Proposed Edit:*** Run plugins with the account UID/GID for kernel ownership, but in restricted mount/PID namespaces with a workspace-only view and no personal plaintext credentials, private worker IPC, worker memory, ptrace access, or inherited provider secrets. Plugins receive only explicit scoped provider capabilities and intentionally exposed account resources. State this boundary in the UI, architecture, implementation plan, and adversarial tests.

### 7. Personal credential revocation versus running work [Design D7-07] - Severity: Major
* **Affected Scope:** Provider configuration; personal-secret updates/deletion; streams and jobs.
* **Discrepancy Description:** Retained configuration snapshots conflict with immediate key deletion/revocation.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Deleted or compromised credentials must not remain usable through an active worker or provider stream.
* ***Proposed Edit:*** Distinguish non-emergency default changes from explicit personal-key revocation. Deletion immediately revokes associated capabilities, cancels affected new and active work/streams, removes worker plaintext copies, and records completion; updates may atomically replace a snapshot at the next operation. Make key rotation/resumption crash-safe and test in-flight revocation.

### 8. Archive credential decryption and re-encryption [Design D7-08] - Severity: Major
* **Affected Scope:** Personal credentials; archive export/import; staging.
* **Discrepancy Description:** The trust path from source-instance ciphertext to archive ciphertext and target-instance ciphertext is absent.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Plaintext credentials must not reach ordinary parsers, logs, or uncontrolled files.
* ***Proposed Edit:*** Use a fenced unprivileged archive-crypto service with authenticated decryption before extraction, bounded KDF/resources, memory/private-descriptor-only plaintext handling, and no credential access for generic parsers. Controller-mediated export supplies personal credentials directly to that service; import sends validated credential records directly to the target controller for new-instance encryption before commit. Define crash cleanup and no-live-account exposure.

### 9. Restored job replay and provider entitlements [Design D7-09] - Severity: Major
* **Affected Scope:** Full archives; unfinished jobs; provider snapshots; restore.
* **Discrepancy Description:** Restored work could replay external side effects, old capabilities, or stale shared-provider entitlements.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected all restored jobs initially paused.
* ***Proposed Edit:*** Exclude all ephemeral capabilities, IPC/session artifacts, and stale shared-provider entitlements. Import every unfinished job paused with old execution tokens invalidated; require explicit owner resume after provider configuration re-resolution. Define idempotency/replay records so resume does not repeat a completed side effect where the prior result is known; unknown outcomes require user acknowledgment before retry.

### 10. Durable and complete account deletion [Design D7-10] - Severity: Major
* **Affected Scope:** Account lifecycle; archives; snapshots; controller/provider state; cleanup.
* **Discrepancy Description:** Seven-day deletion lacks a durable scheduler, actor, retries, and complete artifact inventory.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Cleanup must finish after crashes without creating private-content administrator APIs.
* ***Proposed Edit:*** Add a controller-owned deletion tombstone/journal and durable deadline. A non-content cleanup worker retries idempotently after restart and orchestrates root-helper removal of homes, staging, snapshots, archives, rollback generations, private working directories, provider/controller records, and credentials. Completion requires verified writer termination and an empty artifact inventory; retain only the non-reuse ledger and permitted non-content audit metadata. Record that downloaded archives cannot be recalled.

### 11. Legacy environment credential migration [Design D7-11] - Severity: Major
* **Affected Scope:** Legacy claim; provider support; environment precedence.
* **Discrepancy Description:** Host environment keys and non-`auth.json` credentials have no classification or migration path.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected explicit host-operator CLI classification.
* ***Proposed Edit:*** Require the host migration CLI to inventory and explicitly classify every legacy environment, custom-endpoint, and CLI credential as shared administrator-managed or first-admin personal BYOK. Unclassified or ambiguous credentials block the relevant claim/migration; no host environment value falls through implicitly into workers. OAuth/subscription material is not migrated and requires reconnection. Record non-secret migration evidence and test missing/ambiguous classifications.

### 12. Atomic category dependency replacement [Design D7-12] - Severity: Major
* **Affected Scope:** Chat/graph archives; portable file references; import commit and rollback.
* **Discrepancy Description:** Shared assets, collisions, and multi-directory category dependencies lack one recoverable commit unit.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Retained and imported records must reference a complete consistent file/store set after every crash.
* ***Proposed Edit:*** Build every import as a complete candidate account generation on one filesystem: replace only the selected logical category, retain non-target category content, and materialize all required assets under portable IDs. Reject collisions with retained IDs unless content digest and ownership semantics match; copy-on-write shared assets so neither category can mutate the other's immutable archived object. Validate the full dependency graph, then use the same durable generation-pointer commit/health/rollback protocol as full restore. Non-target categories remain logically unchanged.

### 13. Reserved recovery metadata and ENOSPC integrity [Design D7-13] - Severity: Major
* **Affected Scope:** Resource controls; registry/journals; snapshots; restore commits.
* **Discrepancy Description:** Availability-only disk-exhaustion risk ignores ENOSPC during security and recovery metadata writes.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Confidentiality and integrity cannot be weakened by the accepted availability trade-off.
* ***Proposed Edit:*** Put registry, bootstrap/deletion/import journals, generation pointers, and their rollback metadata on a root-only reserved filesystem/mount that accounts cannot fill; account data/staging/snapshots use separately bounded mounts. Reserve transaction space and fail closed before mutation on ENOSPC. Test exhaustion at every commit/journal/fsync point and preserve the prior complete generation.

### 14. Consolidated risks and mitigations [Structural S7-01] - Severity: Major
* **Affected Scope:** Technical Plan; before Alternatives Considered.
* **Discrepancy Description:** Required risks and mitigations are dispersed.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** A fresh reader needs an explicit risk register.
* ***Proposed Edit:*** Add top-level Risks & Mitigations covering hostile plugins/writers, controller/helper compromise, credential and archive disclosure, lost keys/passphrases, unrecoverable downloads, synchronous-store latency, disk exhaustion, crash recovery, deletion retention, legacy migration, and implementation complexity. Distinguish mitigations from accepted limits and trusted-host boundaries.

### 15. Alternative rejection attribution [Design D7-14; Style ST7-01] - Severity: Nit
* **Affected Scope:** Alternatives Considered.
* **Discrepancy Description:** “Rejected by author” lacks a decision-record link.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Concrete technical rationales already exist and need no unattributed authority claim.
* ***Proposed Edit:*** Delete “Rejected by author:” from every alternative while retaining the concrete trade-offs.

### 16. Supplementary-group contradiction [Style ST7-02] - Severity: Major
* **Affected Scope:** CUJ 2; helper identity transition.
* **Discrepancy Description:** CUJ 2 implies supplementary groups while the helper drops all of them.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** The security contract is one account effective UID/GID with no supplementary groups.
* ***Proposed Edit:*** State that workers have the account's real/effective/saved UID and GID and no supplementary groups; assert this in integration tests.

### 17. UID/GID non-reuse exception [Style ST7-03] - Severity: Major
* **Affected Scope:** Registry and non-reuse ledger.
* **Discrepancy Description:** “Never reused automatically” leaves an undefined manual exception.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Reuse can grant access to stale objects.
* ***Proposed Edit:*** State that allocated UID/GID values are never reused after account deletion or committed provisioning; no manual reuse path exists in this version.

### 18. Deterministic deletion work termination [Style ST7-04] - Severity: Major
* **Affected Scope:** Account deletion lifecycle.
* **Discrepancy Description:** “Cancels or drains” leaves termination behavior discretionary.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Recovery and erasure need a deterministic boundary.
* ***Proposed Edit:*** On user-confirmed deletion immediately stop admission and streams; cancel jobs and provider work; terminate the complete plugin/worker cgroup. Do not drain new output into private data. Seven-day recovery retains the last committed durable state only; permanent cleanup starts only after writer termination and cancellation records complete.

### 19. Remaining style precision [Style ST7-05, ST7-06] - Severity: Nit
* **Affected Scope:** The Problem; Shared and Personal Provider Configuration.
* **Discrepancy Description:** Legacy environment wording asserts impossibility and browser/desktop protection is duplicated.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Editorial corrections preserve behavior.
* ***Proposed Edit:*** Say web mode must replace copying `auth.json` into `process.env` because retaining it violates account credential boundaries; remove the duplicate protection sentence from The Problem and retain it under Authentication.
