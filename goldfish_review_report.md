# Goldfish Annotated Review Report

**Target:** `/root/learnharness-code/docs/designs/per-user-accounts.md` (full document)
**Status:** resolved

## Resolution Outcome

* **Resolution gate:** Auto accept, approved by the author on 2026-11-12.
* **Accepted and applied:** 22 grouped PROPOSE FIX items.
* **Contested:** 0.
* **Escalated:** 0.
* **Declined:** 0.
* **Remaining unaddressed issues from this report:** 0.
* **Applied target:** `/root/learnharness-code/docs/designs/per-user-accounts.md`.
* **Verification:** Re-read the remediated document; checked sequential headings, balanced fenced code blocks, implementation/test alignment, and removal of stale broker-era and uncalibrated wording. Archive compatibility is now decided; only numeric resource-limit defaults remain open for host measurement.

## Prioritized Findings & AI Suggestions

### 1. Bootstrap ownership and legacy claim [Design Critic D-1] - Severity: Blocker
* **Affected Scope:** CUJ 1; Components; Legacy Data and Rollout.
* **Discrepancy Description:** The first public registrant could become administrator and claim legacy data without proving installation ownership.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected a host-issued bootstrap secret.
* ***Proposed Edit:*** Require a single-commit bootstrap secret before first-admin assignment; public registration and legacy claim remain closed until commit. Failed provisioning rolls back completely and permits retry only while no account/admin or UID/GID allocation committed. Successful assignment permanently consumes the secret.

### 2. Clerk-to-account broker authorization [Design Critic D-2] - Severity: Blocker
* **Affected Scope:** Deployment and Trust Boundaries; Components; Authentication.
* **Discrepancy Description:** Web-peer authentication alone does not bind a Clerk subject to the requested account.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected an independent non-root controller as registry owner.
* ***Proposed Edit:*** Make the controller independently verify Clerk sessions, own the registry and UID/GID ledger, and issue short-lived single-use capabilities bound to subject, account, operation, and generation. Web is a relay; the root helper checks controller peer/capability and performs only narrow privileged operations.

### 3. Crash-safe full restore and legacy claim [Design Critic D-3] - Severity: Blocker
* **Affected Scope:** Export, Import, and Replacement; Legacy Data.
* **Discrepancy Description:** Independent directory renames are not crash atomic.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected a durable generation pointer for full restore.
* ***Proposed Edit:*** Build and fsync a complete new generation on one filesystem, atomically switch one durable pointer, reconcile it on startup, and retain the old generation until health checks pass. Use a durable journal/rollback for category-only replacement and non-destructive legacy copies.

### 4. Privileged broker scope and unprivileged provider execution [Zoom Out ZO-1; Inventive Catalyst IC-2; Design D-7] - Severity: Major
* **Affected Scope:** Components; uploads; provider execution; archive migration; Phases 3–6.
* **Discrepancy Description:** Complex parsing, credential handling, and network traffic enlarge the root failure domain.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Keep root limited to identity, ownership, namespace, and descriptor operations.
* ***Proposed Edit:*** Split web relay, non-root controller/registry/credential custody, narrow root helper, account workers, unprivileged provider executor, and fenced unprivileged parsers. Controller holds the instance key. No provider response, document parser, archive parser, or migration executes as root. Validated input is immutable and inherited descriptors cannot reopen writable input through `/proc/self/fd`.

### 5. Registry ownership contradiction [Zoom Out ZO-2] - Severity: Major
* **Affected Scope:** Component diagram; account registry; Security and Privacy.
* **Discrepancy Description:** Web, broker, and controller responsibilities were inconsistent.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected controller ownership.
* ***Proposed Edit:*** State that only the non-root controller writes registry and non-reuse ledger; web and account UIDs cannot modify them. The root helper does not parse Clerk tokens or own registry transactions.

### 6. Existing privilege-drop tools [Zoom Out ZO-3] - Severity: Major
* **Affected Scope:** Phase 3; Dockerfile; entrypoint.
* **Discrepancy Description:** A new native identity-transition helper was proposed without evaluating shipped `gosu` or `setpriv`.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Reuse reduces security-sensitive implementation.
* ***Proposed Edit:*** Require a recorded evaluation of `gosu`/`setpriv` for sanitized fixed worker launch. Commission native code only for descriptor-relative/no-link operations those tools cannot provide.

### 7. File metadata architecture [Zoom Out ZO-4] - Severity: Major
* **Affected Scope:** Phase 4.
* **Discrepancy Description:** File metadata bypassed the established storage-port pattern.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Preserve existing composition boundaries.
* ***Proposed Edit:*** Add a semantic `FileStore` port to `src/core/ports.ts`, its adapter under `src/store/`, and wire it in the account-worker composition root; keep the library as coordinator.

### 8. Archive workspace scope [Zoom Out ZO-5] - Severity: Major
* **Affected Scope:** Full archive; snapshot; capacity; Phase 6.
* **Discrepancy Description:** Archiving reproducible caches adds cost and stale state.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author changed the earlier decision to exclude rebuildable caches.
* ***Proposed Edit:*** Exclude reproducible caches, but include durable files, unfinished work, and non-regenerable temporary files. Manifest records classifications and regeneration requirements.

### 9. Synchronous-store execution [Inventive Catalyst IC-1] - Severity: Major
* **Affected Scope:** Account Storage; Performance.
* **Discrepancy Description:** Synchronous adapters can delay same-account cancellation and events.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author explicitly retained synchronous stores initially rather than adding a storage thread.
* ***Proposed Edit:*** Retain JSON/JSONL synchronous adapters, document the same-account latency trade-off, and require latency/size measurements and record/archive bounds. No database or storage-thread migration is added.

### 10. Docker privilege replacement and read-only root [Design D-4; Style S-1] - Severity: Major
* **Affected Scope:** Deployment; Docker rollout; Phase 3.
* **Discrepancy Description:** Existing recursive `chown` and permanent root drop are incompatible; read-only caveat was unbounded.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected mandatory read-only root for public multi-user mode.
* ***Proposed Edit:*** Replace entrypoint behavior, define persistent root supervision and minimal capabilities, require read-only root, and enumerate only registry/account, staging/snapshot, instance state, and private working mounts as writable. No fallback to shared storage.

### 11. Aggregate and per-account resource controls [Design D-5, D-6] - Severity: Major
* **Affected Scope:** Resource controls; provider execution; capacity.
* **Discrepancy Description:** Per-account limits alone do not bound aggregate load; application reservation does not stop plugins filling shared storage.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected configurable global limits and explicitly accepted best-effort disk reservation.
* ***Proposed Edit:*** Add configurable global limits for active accounts, workers, streams, provider connections, archive work, and temporary storage with queueing/backpressure. Keep root-owned global reserve; label account disk reservation best-effort and document accepted availability risk from disk exhaustion. Confidentiality/integrity requirements remain mandatory.

### 12. Snapshot immutability and quiescence [Design D-8] - Severity: Major
* **Affected Scope:** Export snapshot.
* **Discrepancy Description:** Account-owned snapshots remain mutable after resume.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Consistency requires control outside account code.
* ***Proposed Edit:*** Stop/fence jobs, plugin sidecars and children, drain streams and buffered writes, flush data, then snapshot under a root-controlled non-traversable parent. Packaging receives read-only access only; snapshots are excluded from later archives.

### 13. Temporary-file inventory [Design D-9] - Severity: Major
* **Affected Scope:** Uploads; PDF/extraction; Claude Code; read-only root.
* **Discrepancy Description:** Existing predictable/shared `/tmp` producers were not fully inventoried.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Baseline includes PDF paths, `lh-import-*`, and `claude-code-*` temporary directories.
* ***Proposed Edit:*** Inventory all temp/cache/render locations, including PDF ops, extraction, image processing, Claude Code turn files/install execution, Chromium, and atomic writes. Use broker-created per-account private directories, safe creation, cleanup, reservation checks, and explicit writable mounts.

### 14. Portable references and category dependencies [Design D-10; Comprehension C-1] - Severity: Major
* **Affected Scope:** CUJ 5; archives; file records; import.
* **Discrepancy Description:** Relative archive paths did not define embedded reference portability or final category state.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected self-contained category assets while leaving non-target categories unchanged.
* ***Proposed Edit:*** Use stable portable file IDs and rewrite/validate every reference. Chat-only includes chats, attachments/images, and required source snapshots; graph stays unchanged and missing node links become historical ID/text snapshots. Graph-only includes graph, sources, source assets, coverage/positions/render settings; chats/workspace remain, missing chat-to-node links become historical, and old extraction jobs are cancelled rather than replaced.

### 15. Disablement, deletion, and administrator lifecycle [Design D-11, D-13; Comprehension C-4; Style S-2] - Severity: Major
* **Affected Scope:** Components; streams; jobs; webhooks; E2E tests.
* **Discrepancy Description:** Cleanup actors/timing, active-work revocation, and sole-admin handling were undefined.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected seven-day recovery and mandatory sole-admin transfer.
* ***Proposed Edit:*** User-confirmed deletion immediately disables/fences the account, terminates streams, and cancels/drains jobs/plugins/provider work; recovery is available for seven days, then non-content cleanup permanently erases data/credentials. External Clerk deletion only starts disablement. Sole admin must transfer first; host bootstrap recovery appoints a replacement without private-content APIs.

### 16. Credential update and key lifecycle [Design D-12] - Severity: Major
* **Affected Scope:** Personal credentials; provider matrix; instance encryption.
* **Discrepancy Description:** Updates, rotation, loss, and support boundaries were unspecified.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected controller custody and gradual multi-key rotation.
* ***Proposed Edit:*** Controller pushes/fences updates to running workers without browser/shared-key disclosure; persist versioned keys outside accounts, write with the new key, gradually re-encrypt old ciphertext, and retire old keys only after migration. Loss of every required key makes stored BYOK unrecoverable. Document support/isolation for API keys, custom endpoints, subscriptions, CLI auth, search, and dictation; OAuth/subscription tokens remain excluded.

### 17. Legacy repair and external access gate [Comprehension C-2, C-3] - Severity: Major
* **Affected Scope:** The Problem; Authentication; Legacy Data.
* **Discrepancy Description:** Repair privilege and Clerk/external-gate relationship were unclear.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected host-only legacy repair.
* ***Proposed Edit:*** UI reports only failure codes/counts; host repairs volume/path with CLI and claim never destructively moves source. Clerk replaces the old external access gate as application authentication; an optional outer proxy may add network policy but is not an account authority. Link/describe retained host/cross-site and desktop capability protections.

### 18. Initial archive compatibility [Design D-14; Style S-4] - Severity: Major
* **Affected Scope:** Open Questions; archive versions; migrations.
* **Discrepancy Description:** Core compatibility was deferred.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Author selected current formats only.
* ***Proposed Edit:*** Initial release accepts archive format v1 containing data formats understood by that build. Missing graph sidecar means graph v1 per existing contract; corrupt/missing required stamps and future/unknown formats fail before mutation. Older versions require an explicit tested migration added later; validation cannot mutate staged input.

### 19. Initial upload placement and shared-key ownership wording [Comprehension C-5, C-6; Style S-3, S-8, S-9] - Severity: Major
* **Affected Scope:** Account Storage; upload staging; shared providers.
* **Discrepancy Description:** Direct-to-category contradicted staging; administrator-owned could imply admin UID; ordinary-request and non-traversable exceptions were vague.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Clarify existing security intent without adding exceptions.
* ***Proposed Edit:*** Every uploaded/imported/agent-created file is account-owned/private at creation; incoming files begin in locked staging then promote atomically. Shared keys are logically administrator-managed but stored in controller/provider-executor state outside account homes. Web never directly reads account files for application requests; roots deny traversal to web and non-owning account identities.

### 20. Cross-process locking and validation reuse [Zoom Out ZO-6, ZO-7] - Severity: Nit
* **Affected Scope:** Store reuse; file validation.
* **Discrepancy Description:** Locking lacked a second writer; new validators could duplicate existing rules.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Generation fencing is the primary exclusion mechanism.
* ***Proposed Edit:*** State fencing/restore exclusion coordinates writers and add store locking only for a named writer fencing cannot exclude. Compose existing graph-import, image, PDF, and notes-limit validation rather than recreating it.

### 21. Archive KDF bounds [Design D-15] - Severity: Nit
* **Affected Scope:** Archive encryption.
* **Discrepancy Description:** Password encryption lacked resource and parameter bounds.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Unbounded KDF parameters create denial-of-service risk.
* ***Proposed Edit:*** Require a versioned memory-hard KDF, authenticated parameter/header binding, minimum passphrase guidance, and bounded accepted KDF cost parameters; algorithm selection remains implementation work.

### 22. Remaining style precision [Style S-5 through S-7, S-10 through S-17] - Severity: Nit
* **Affected Scope:** Open Questions; architecture; alternatives; evidence.
* **Discrepancy Description:** Subjective/unbounded or duplicated wording reduces verifiability.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:*** Editorial corrections do not change approved behavior.
* ***Proposed Edit:*** Remove unmeasured “conservative,” subjective “small/careful,” “forever,” redundant key restrictions, uncalibrated “briefly/minimal,” “silently/exactly,” and duplicated category wording. Assign startup refusal to the system; describe two-account tests rather than evidence containing accounts; retain explicit UID-map/runtime prerequisites for namespaces; say packages selected by the administrator.
