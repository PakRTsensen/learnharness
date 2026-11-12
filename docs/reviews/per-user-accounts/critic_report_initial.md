# Stage 7: Critic Review

* **Target**: `docs/designs/per-user-accounts.md`
* **Scope**: FeatureRange, lines 1–247
* **Reviewers**: `egm-design` (completed), `egm-structural` (completed), `egm-style` (completed)
* **Design verdict**: Fail until blockers and major gaps are resolved or explicitly accepted

## Design Critique

### D-1 — Blocker: Public first registration can let an attacker claim an upgraded instance

**Affected scope**: First-account provisioning and legacy claim.

The first public registrant becomes administrator and may claim all legacy data. Serialization prevents races but does not establish legitimate installation ownership. An exposed upgraded instance can be claimed before its owner registers.

The reviewer recommends deployment-supplied bootstrap authorization or an expected Clerk subject, closing public registration until bootstrap completes, and explicit host-operator authorization for legacy claims.

### D-2 — Blocker: Web-only broker authentication creates a confused-deputy path

**Affected scope**: Web/broker trust boundary and request credentials.

The document does not specify who mints single-use request credentials or how the broker verifies that the authenticated Clerk subject authorizes the requested account. Authenticating only the web UID lets a route bug or compromised web process request another account's worker.

Define an unforgeable account-scoped protocol: verify the Clerk-bound subject/account mapping or validate a narrowly scoped capability issued from independently verified session proof.

### D-3 — Blocker: Multi-directory restore and legacy claim are not crash atomic

**Affected scope**: Archive replacement and legacy claim.

Independent directory renames can leave mixed generations after a crash. Post-commit startup failure handling does not cover broker/container/power failure. Legacy copies/moves and reference updates also lack durable transaction and recovery semantics.

Specify durable import/claim state, startup reconciliation, flush requirements, and recovery at every interruption point. Use a top-level generation switch where supported or a journaled rollback protocol; never destructively move legacy data before commit.

### D-4 — Major: Existing Docker privilege behavior must be replaced explicitly

**Affected scope**: Deployment, worker runtime, rollout, Dockerfile, and entrypoint.

The current entrypoint recursively changes all `/data` ownership to `node` and permanently drops root. Retaining it would defeat account ownership and leave no root broker. Persistent root supervision/restart, exact capabilities, and IPC setup also need definition.

### D-5 — Major: Per-account limits do not bound aggregate load

**Affected scope**: Resource controls and provider execution.

Unlimited accounts and simultaneously active workers, streams, snapshots, imports, and provider requests can oversubscribe one host. The broker/provider executor is also a central bottleneck and single point of failure.

Add global admission limits for registered/active accounts, workers, streams, provider connections, archive work, and temporary storage, with queuing/backpressure and broker-failure behavior.

### D-6 — Major: Application reservation is not a disk boundary against plugins

**Affected scope**: Disk-limit fallback.

Account plugin code can bypass application reservation checks and fill the shared filesystem. Require kernel/filesystem quotas for multi-user mode or fail closed. A weaker fallback is only best-effort availability and needs a protected global reserve; it cannot be represented as an enforced account disk limit.

### D-7 — Major: Untrusted parsing and provider traffic need unprivileged execution identities

**Affected scope**: Uploads, provider execution, credential release, and archive migration.

Root processing of documents, archives, and network responses enlarges the privilege boundary. Inherited descriptors can also let account code modify validated input through `/proc/self/fd` if descriptor access is not controlled.

Keep the privileged broker limited to registry, namespace, ownership, and descriptor operations. Use fenced unprivileged helpers for parsing/migration with explicitly controlled descriptors and immutable validated input.

### D-8 — Major: Account-owned snapshots are not immutable

**Affected scope**: Export snapshot consistency.

An account worker or plugin can chmod or modify an account-owned snapshot after work resumes. Pausing work also needs to cover plugin sidecars, child processes, in-flight responses, and buffered writes.

Place snapshots under a root-controlled non-traversable parent and expose them read-only only to packaging. Define complete quiescence and flushing before snapshot creation.

### D-9 — Major: Existing temporary-file producers are not inventoried

**Affected scope**: Workspace/files, snapshots, PDF conversion, and read-only root filesystem.

Current PDF rendering uses predictable `/tmp/lh-pdf-<hash>` paths. This conflicts with account-owned private creation and can collide across accounts. Inventory every temporary/cache/render location and define broker-created per-account temporary directories, private modes, safe creation, cleanup, quotas, and writable mounts.

### D-10 — Major: Relative archive paths do not make embedded record references portable

**Affected scope**: Archives, file records, category dependencies, and restore.

Chats, sources, attachments, jobs, and plugin data may contain local paths or path-derived identities. Define portable record references and rewriting rules for every file-backed type. Specify which category dependencies are embedded, retained, rebuilt, or rejected, and validate every post-restore reference.

### D-11 — Major: Disablement does not revoke active work

**Affected scope**: Streams, worker lifecycle, plugins, jobs, and provider calls.

Reauthorization on reconnection does not terminate an existing stream. Deletion/disablement needs bounded stream lifetimes/session revalidation, immediate stream termination, and defined worker/job/plugin/provider cancellation or draining, including in-flight shared-provider spending.

### D-12 — Major: Credential updates and instance-key lifecycle are unspecified

**Affected scope**: Personal credentials, provider bindings, and instance encryption.

Define how additions, rotation, and deletion reach a running worker; persistent Docker key location; key rotation, loss, and upgrade behavior; and a support/isolation matrix for API keys, custom endpoints, subscriptions, CLI authentication, search, and dictation.

### D-13 — Major: Administrator deletion can strand instance management

**Affected scope**: Admin lifecycle and deletion webhooks.

Define sole-admin deletion safeguards, explicit ownership transfer, and host-operated recovery without routine access to private user content.

### D-14 — Major: Archive compatibility is deferred despite being core behavior

**Affected scope**: Open Questions, archive validation/migration, and graph formats.

Establish the initial source-format matrix and migration acceptance criteria, including missing/corrupt version stamps, future versions, and proof that validation cannot mutate staged input.

### D-15 — Nit: Archive KDF needs cost and resource bounds

**Affected scope**: Archive encryption.

Require a memory-hard KDF, authenticated parameter/header binding, minimum passphrase guidance, and bounded accepted KDF parameters. Detailed algorithm selection can remain an implementation decision.

## Structural Review

No Blocker, Major, or Nit discrepancies.

The reviewed scope contains the required problem, goals/non-goals, architecture, alternatives, risks, constraints, security/failure handling, and mitigations. Heading hierarchy is sequential and logically nested. Bullets, metadata, inline code, and the fenced diagram are well formed. No malformed links or unsupported maintainer attributions were found.

## Style Review

### S-1 — Major: Read-only root filesystem caveat is unbounded

**Affected scope**: Lines 89–91. **Action**: CALIBRATE.

“Where compatible” does not identify acceptable exceptions or whether startup must fail. Name supported exceptions and their deployment decision, or make the control mandatory for multi-user mode.

### S-2 — Major: Cleanup timing is not verifiable

**Affected scope**: Line 124. **Action**: CALIBRATE or RELOCATE.

“Explicit, non-immediate cleanup flow” lacks actor, trigger, and delay. Specify those requirements or move the unresolved timing to Open Questions.

### S-3 — Major: “Ordinary application requests” creates an undefined exception

**Affected scope**: Line 128. **Action**: CALIBRATE.

Delete “ordinary” if no exception exists, or name the operations permitted to bypass the worker.

### S-4 — Nit: Archive-version Open Question repeats settled validation requirements

**Affected scope**: Lines 50, 184, 190. **Action**: DROP duplicated second sentence and simplify the first.

### S-5 — Nit: “Conservative” resource defaults are unmeasurable

**Affected scope**: Line 51. **Action**: CALIBRATE with measured values/rationale or DROP the adjective.

### S-6 — Nit: “Small” broker is subjective

**Affected scope**: Line 89. **Action**: DROP; restricted responsibilities define scope objectively.

### S-7 — Nit: “Forever” is imprecise

**Affected scope**: Line 134. **Action**: DROP and state fresh reconnection authorization.

### S-8 — Nit: Non-traversable root does not name restricted identities

**Affected scope**: Line 140. **Action**: CALIBRATE to web and non-owning account identities.

### S-9 — Nit: Upload categories and creation wording are redundant

**Affected scope**: Line 148. **Action**: DROP redundancy; use “Every uploaded, imported, or agent-created file” and “created with the account UID/GID and private permissions.”

### S-10 — Nit: Resource-enforcement sentence has subjective and overlapping wording

**Affected scope**: Line 154. **Action**: DROP “small” and CALIBRATE to refusal of multi-user mode when limits cannot be enforced.

### S-11 — Nit: Shared-key restriction is repeated

**Affected scope**: Line 162. **Action**: DROP redundant clauses; workers/plugins/tools receive only the capability.

### S-12 — Nit: Snapshot and encryption wording includes uncalibrated brevity/minimality

**Affected scope**: Line 180. **Action**: DROP “briefly” and “minimal,” or provide a measurable pause bound and test conditions.

### S-13 — Nit: “Silently” and “exactly” weaken or duplicate requirements

**Affected scope**: Line 186. **Action**: DROP both.

### S-14 — Nit: Startup refusal should be assigned to the system

**Affected scope**: Line 196. **Action**: CALIBRATE to mandatory startup failure and prohibition of shared-storage fallback.

### S-15 — Nit: Evidence should contain tests/results, not accounts

**Affected scope**: Line 202. **Action**: CALIBRATE to tests in which two accounts attempt the listed actions.

### S-16 — Nit: Alternative C has subjective and unsupported availability wording

**Affected scope**: Line 221. **Action**: DROP “careful”; CALIBRATE availability to runtime/kernel prerequisites or supported-host evidence.

### S-17 — Nit: Administrator selection is not necessarily review

**Affected scope**: Line 238. **Action**: CALIBRATE to “packages selected by the instance administrator.”

## Consolidated Assessment

* **Blockers**: 3
* **Major findings**: 14 (D-4 through D-14 and S-1 through S-3)
* **Nits**: 13 (D-15 and S-4 through S-17)
* **Structural findings**: 0

The three blockers concern bootstrap ownership, broker authorization, and crash-safe replacement. These are not editorial issues. They require explicit product/architecture decisions before the design can be considered ready. Stage 5 findings remain separately unresolved and should be reconciled during remediation, especially broker scope, registry ownership, provider-executor separation, and snapshot handling.
