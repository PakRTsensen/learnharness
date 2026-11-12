# Stage 7: Critic Re-audit

* **Target**: `/root/learnharness-code/docs/designs/per-user-accounts.md`
* **Scope**: FeatureRange, lines 1–277 (feature specification through Alternatives Considered)
* **Round**: Re-audit after the 22 approved initial remediation groups
* **Reviewers**: `egm-design` (completed), `egm-structural` (completed), `egm-style` (completed)
* **Design verdict**: Not clean; unresolved Blocker and Major findings require resolution or explicit accepted trade-offs
* **Initial audit**: `docs/reviews/per-user-accounts/critic_report_initial.md`
* **Initial resolution**: `docs/reviews/per-user-accounts/goldfish_review_report_initial.md`

The first design re-audit output was incomplete in the orchestration context and was retried once in a fresh reviewer session. The final design and style results below are complete reports from fresh reviewer sessions. The structural result is the completed re-audit report. No production code was changed during this review.

## Design Critique

**Severity counts:** Blocker: 2; Major: 11; Nit: 1.

### D7-01 — Blocker: Bootstrap is not crash-atomic across components

**Lines:** 62, 92–96, 134–138.

The controller transaction depends on root-helper filesystem work, but no recovery protocol joins secret consumption, UID/GID allocation, registry commit, and home creation. A crash can strand a consumed secret, allocated identity, or directory, or permit a second bootstrap attempt.

**Recommendation:** Specify a durable bootstrap state machine with transaction IDs, idempotent helper operations, journaled results, and mandatory reconciliation before retries, registration, or legacy claim; prove exactly one administrator across crash-point tests.

### D7-02 — Blocker: Generation fencing does not stop surviving writers

**Lines:** 138–142, 154–160, 188–192, 204–218.

Capabilities reject new work, but old workers and same-UID plugins can retain descriptors, fork children, and write account files directly. This invalidates single-writer, snapshot, restore, and deletion guarantees.

**Recommendation:** Require per-generation process/mount containment, reliable descendant termination such as cgroup killing, descriptor hygiene, and verification that no writer survives before snapshot, commit, or deletion. Include hostile-plugin survival tests.

### D7-03 — Major: Capability semantics are incomplete

**Lines:** 92, 115–120, 138–140, 146, 178, 192.

Every capability is subject-bound, yet recovered background work may have no current Clerk subject. Expiry, audience, parameter binding, nonce persistence, and replay recovery are unspecified. Offline execution and restart create authorization and replay ambiguities.

**Recommendation:** Separate interactive subject/session capabilities from durable account-work authority; bind audience, account, generation, operation parameters, expiry, and nonce. Define atomic consumption, revocation, restart behavior, and prohibition on reassignment after Clerk deletion or recreation.

### D7-04 — Major: Privilege separation lacks an enforceable helper contract

**Lines:** 92–96, 119–121, 134–138.

The controller can mint capabilities while the helper exposes identity, ownership, namespace, and descriptor authority, but permitted commands and post-exec privilege state are not bounded. Controller compromise could become broad root-mediated access; retained capabilities could undermine UID dropping.

**Recommendation:** Specify an allowlisted protocol with fixed roots and targets, helper-only execution permissions, cleared permitted/effective/ambient capabilities in children, `no_new_privs` after launch, seccomp, and tests for malicious controller requests.

### D7-05 — Major: Workspace confinement needs race-safe filesystem semantics

**Lines:** 160–168, 188–190.

Rejecting traversal, escaping symlinks, and renamed directories does not define how checks remain valid while a same-account plugin mutates paths. Check-then-use resolution can redirect reads or writes into account-private records.

**Recommendation:** Require descriptor-relative operations throughout, using `openat2` with beneath/magic-link constraints or an equivalent, covering reads, writes, traversal, promotion, and downloads. Prohibit reopening by absolute path and test concurrent rename/symlink attacks.

### D7-06 — Major: Same-account plugin credential trust is ambiguous

**Lines:** 160, 176–190, 202.

Plugins share the worker UID and may access data available to it, while personal credentials inhabit worker-owned files and environment. The stated plugin trust boundary does not explicitly include credentials, worker memory, or IPC. Installation warnings cannot communicate an undefined authority grant.

**Recommendation:** Explicitly decide whether plugins receive these powers. If not, use separate identity/mount boundaries and broker provider calls without inherited secrets or ptrace access; if yes, document and prominently warn about that accepted risk.

### D7-07 — Major: Credential deletion conflicts with retained job configuration

**Lines:** 74, 142, 178–184, 202.

Running work retains resolved configuration while credential deletion only fences obsolete snapshots. Revocation of direct BYOK requests, provider capabilities, environment copies, and active streams is undefined. Deleted or compromised keys may remain usable.

**Recommendation:** Distinguish non-emergency updates/rotation from revocation. Require deletion to revoke capabilities, cancel affected work, remove worker copies, and define in-flight behavior. Add crash-safe, resumable key-rotation and retirement tests.

### D7-08 — Major: Encrypted credential portability and archive decryption are unspecified

**Lines:** 182–184, 196–206, 210–218.

Source-instance-encrypted credentials must become passphrase-protected portable data and then target-instance ciphertext, but the decryption, unpacking, and re-encryption trust path is absent. Plaintext keys or archives could reach unsafe staging, parsers, logs, or crash remnants.

**Recommendation:** Specify fenced authenticated decryption before extraction, controlled plaintext descriptors, direct controller-mediated credential re-encryption, resource limits, cleanup, and crash recovery without live-account exposure.

### D7-09 — Major: Restored unfinished work can replay authority or side effects

**Lines:** 178–180, 192–200, 218.

Archives include unfinished jobs and configuration snapshots, but no rule excludes provider capabilities, IPC/session artifacts, or stale shared-provider entitlements. Restoration may replay external actions, incur charges, or execute with obsolete authority.

**Recommendation:** Exclude all ephemeral capabilities and session artifacts; import jobs paused, invalidate old execution tokens, re-resolve provider configuration, require explicit resume for side-effecting work, and define idempotency/replay handling.

### D7-10 — Major: Deletion lacks a durable, complete lifecycle

**Lines:** 134–142, 182, 196–210, 214–224.

Seven-day cleanup has no durable scheduler, actor, retry semantics, or inventory covering controller/provider state, staging, snapshots, archives, rollback generations, working directories, and logs. Crashes or orphaned artifacts can retain credentials/content indefinitely.

**Recommendation:** Define a durable deletion journal and tombstone, retention deadline, restart-safe cleanup, completion criteria, ledger retention, and administrator-recovery interactions. Explicitly accept that downloaded archives cannot be recalled.

### D7-11 — Major: Legacy environment credentials have no migration policy

**Lines:** 156, 176–184, 220–226.

Legacy `auth.json` is addressed, but environment-supplied provider keys, custom bindings, OAuth/subscription material, and their shared-versus-personal classification are not. Existing environment precedence could silently reintroduce global credentials or lose personal configuration.

**Recommendation:** Require explicit one-time classification and migration of every legacy credential source, quarantine host environment keys from account workers, prohibit implicit fallback, and document reconnect requirements and migration evidence.

### D7-12 — Major: Category replacement lacks a complete dependency transaction

**Lines:** 196–200, 210–218.

Category archives include assets and sources while other categories and workspace remain unchanged, but shared references, ID collisions, and assets referenced by both replaced and retained data are unresolved. Multi-directory swaps can leave valid individual stores with broken cross-category files.

**Recommendation:** Define category ownership, dependency/reference graphs, collision and shared-asset rules, the exact transactional unit, and journal recovery covering every file and store; test interruption at each swap.

### D7-13 — Major: Disk-exhaustion risk is understated

**Lines:** 156, 170, 204, 214–216.

The accepted risk claims availability loss without integrity loss, although plugins can fill shared storage needed by registries, journals, snapshots, and synchronous writes. ENOSPC can interrupt security and recovery metadata, not merely deny service.

**Recommendation:** Place registry/journal metadata on a reserved filesystem or otherwise guarantee reserve usage, fail closed before mutation, test ENOSPC at commit points, or revise the accepted-risk statement.

### D7-14 — Nit: Alternative rejections lack required references

**Lines:** 240, 246, 252, 258, 264, 270, 276; feature-spec standard lines 19–21.

Each option says “Rejected by author” without an issue, discussion, or PR link. The technical trade-offs are documented, but the standard expressly prohibits unattributed maintainer-based rejection.

**Recommendation:** Add the governing decision reference to each alternative, or remove the author-attribution wording while retaining the concrete technical rationale.

## Structural Review

**Severity counts:** Blocker: 0; Major: 1; Nit: 0.

### S7-01 — Major: Risks and mitigations are dispersed rather than consolidated

**Lines:** 88–234, particularly 228 and 234.

The specification lacks a distinct, top-level **Risks & Mitigations** section required by the feature-specification standard. Risk-related material is dispersed across architecture and resource-control subsections. Failure Handling and Security Evidence addresses events and tests but does not consolidate security, scalability, availability, data-loss, and complexity risks with mitigations.

**Recommendation:** Add a top-level risk register before Alternatives Considered, covering the major security, availability, data-loss, recovery, plugin-trust, credential-loss, and implementation-complexity risks and their mitigations or explicit acceptance.

No other structural discrepancies were found. Required sections, heading hierarchy, lists, and the architecture diagram are otherwise coherent.

## Style Review

**Severity counts:** Blocker: 0; Major: 4; Nit: 2.

### ST7-01 — Major: Alternatives use unattributed rejection authority

**Lines:** 240, 246, 252, 258, 264, 270, 276.

Every rationale begins “Rejected by author” without linking an issue, discussion, or PR. The standard prohibits this attribution even where technical reasons follow.

**Action:** Delete “Rejected by author:” and retain the concrete technical rationale, or add a decision-record link to each attribution.

### ST7-02 — Major: Worker group membership is contradictory

**Lines:** 68, 138.

CUJ 2 says a worker has “that account’s UID/GID and groups,” while the helper contract requires dropping all supplementary groups. Acceptance tests cannot determine whether account-specific supplementary groups are expected or forbidden.

**Action:** Align CUJ 2 with the helper contract: the worker has that account’s effective UID/GID and no supplementary groups.

### ST7-03 — Major: UID/GID non-reuse requirement has an unspecified exception

**Line:** 134.

“Never reused automatically” leaves manual reuse undefined despite the non-reuse ledger and per-account isolation requirements. Reusing identities can grant a later account access to stale files or descriptors.

**Action:** Replace with “is never reused after account deletion,” or explicitly define who may authorize manual reuse and the required safeguards.

### ST7-04 — Major: Deletion leaves work-termination behavior discretionary

**Line:** 142.

“Cancels or drains jobs, plugin processes, and provider work” supplies no criterion for choosing cancellation or draining, nor a completion boundary before erasure. Implementations can produce materially different behavior while both claiming compliance.

**Action:** State the required behavior for each work class and when cleanup may proceed, using a bounded lifecycle table if useful.

### ST7-05 — Nit: Legacy credential statement asserts impossibility instead of prohibition

**Line:** 176.

“The current pattern … cannot cross account boundaries” reads as a capability claim, although the paragraph is prohibiting retention of that pattern.

**Action:** Replace with: “In web mode, replace the current pattern of copying `auth.json` into `process.env`; retaining it would violate account credential boundaries.”

### ST7-06 — Nit: Browser/desktop protection sentence is duplicated

**Lines:** 23, 148.

Both lines state that browser host/cross-site protections remain in web mode and the desktop capability check remains in desktop mode. Line 148 already places the statement in its authorization context.

**Action:** Drop the sentence from line 23 and retain line 148.
