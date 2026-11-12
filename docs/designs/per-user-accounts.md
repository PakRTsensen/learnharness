# Per-User Accounts, Linux Ownership, and Portable Archives

* **Author:** PakRTsensen
* **Status:** In Review
* **Date:** 2026-11-12

---

## Overview

LearnHarness will become a multi-user web application on one Docker-hosted server. Clerk will authenticate users, while a host-issued bootstrap secret will authorize creation of the first local administrator account. Each account will own its chats, knowledge graph, files, jobs, settings, plugins, and personal provider credentials. Linux user and group ownership will enforce these boundaries for files and agent processes, rather than relying only on checks in application routes.

An independent, non-root controller will verify Clerk identities, own the account registry and UID/GID non-reuse ledger, and issue account-bound operation capabilities. Next.js will relay requests without serving as the account authority. A narrowly scoped root helper will perform only the identity, ownership, namespace, and descriptor operations that require privilege. Account workers and their plugins will run as per-account Linux identities. Shared-provider execution and untrusted document/archive processing will run in separate unprivileged services.

The administrator will supply shared provider defaults, including API keys for models, search, and other supported services. Other users can use those defaults or configure their own keys. Shared keys will remain hidden from non-administrator users, while personal keys will remain private to their owner. Administrator privileges will not include browsing, impersonating, exporting, restoring, or modifying users' private data.

Users will be able to export and import a complete account archive, chats only, or graph/knowledge only. A complete archive will include durable account data, personal configuration, and personal provider credentials, but not the administrator's shared credentials or personal OAuth/subscription tokens. The application will not create scheduled backups.

## The Problem

LearnHarness currently has no user accounts. Its Docker deployment expects an external access gate and stores chats, graph ledgers, jobs, settings, plugins, and credentials in shared application data paths. Agent tools and trusted plugins run with the server's filesystem privileges. As a result, adding Clerk login without changing process identity and storage ownership would only hide data in the interface; it would not prevent one user's work from reaching another user's files.

Clerk will replace the old external access gate as application authentication. An optional outer proxy may still supply network policy, but it is not an account authority. The existing browser host and cross-site protections will remain in web mode, and the desktop capability check will remain in desktop mode.

The product needs separate ownership for every account while retaining a single Docker deployment. Authentication must identify the caller, and the operating system must enforce which files and processes that caller's work can reach. Provider defaults must be usable by many accounts without disclosing the underlying shared keys. Personal provider keys must not become shared merely because the application has an administrator.

Users also need a way to move or recover their own data. Export without import would not provide recovery or migration. The archive must therefore have a supported import path and must distinguish personal credentials, which belong in a complete archive, from shared administrator credentials, which do not.

## Goals

* Authenticate every web user with Clerk and require a host-issued, single-commit bootstrap secret for the first administrator before public registration opens.
* Give each account a distinct Linux UID/GID and ensure its agent work runs with that identity inside the Docker deployment.
* Make Linux file ownership and permissions prevent cross-account reads, writes, deletion, and agent filesystem access, including access through background jobs and plugins.
* Scope chats, graph/knowledge records, jobs, settings, plugin data, generated files, and personal credentials to their owning account.
* Let the administrator manage shared provider keys and defaults without gaining access to other users' data, personal keys, or archives.
* Let users select shared provider defaults or their own provider keys without revealing shared key material to non-administrator users.
* Support export and import for a complete account archive, chats only, or graph/knowledge only.
* Include personal settings and personal provider credentials in a complete archive; exclude shared administrator credentials.
* Preserve account ownership and access checks across HTTP routes, event streams, background work, imports, exports, and restore operations.

## Non-Goals

* Protecting application data or credentials from the server's root user, the Docker host operator, or someone with equivalent host access.
* Giving the instance administrator a way to browse, impersonate, restore, export, or change another user's private data or personal provider keys.
* Creating automatic or scheduled backups.
* Including the administrator's shared provider credentials in another user's archive.
* Treating authentication middleware alone as proof of filesystem or process isolation.
* Replacing host-level disaster recovery; user-initiated archives serve account portability and recovery.
* Sandboxing a user's plugin from that same user's data. User-installed plugins run as the account UID and must be trusted by that account.
* Enforcing a separate API spending or usage quota for each consumer of the administrator's shared provider keys in the first version.

## Open Questions

* Exact resource-limit defaults require measurement on the supported Docker host. The first version must expose configurable limits rather than claim unlimited multi-user capacity. The controls, failure behavior, and required measurements are specified below; only their default numeric values remain open.

## Critical User Journeys (CUJs)

### CUJ 1: Bootstrap, First Account, and Legacy Data Claim

* **Given**: A new web instance has no registered local account, a host operator has supplied a single-commit bootstrap secret, and a previous single-user installation may have left a legacy data directory.
* **When**: The host-authorized first person completes Clerk registration, signs in, and supplies the bootstrap secret through the first-admin setup flow.
* **Then**: Public registration and legacy claim remain closed until one serialized bootstrap transaction binds that Clerk identity to the administrator account, commits its UID/GID allocation, and creates its private account directory. The successful operation permanently consumes the secret, opens ordinary registration, and makes only this administrator eligible to claim legacy data. Failed provisioning leaves no account/administrator or UID/GID allocation committed and permits retry only while that remains true. Concurrent attempts cannot both succeed.

### CUJ 2: Isolated Learning Work

* **Given**: Two different signed-in accounts have their own chats, graph records, files, and provider settings.
* **When**: Each user starts a conversation, imports notes, runs an agent, or executes a plugin/background job.
* **Then**: Every operation resolves to the caller's account worker. The worker has only that account's UID/GID and groups, and its filesystem tools are confined to the account workspace. Attempts to read another account's paths fail even when a valid record identifier is known.

### CUJ 3: Shared Provider Default or Personal Key

* **Given**: The administrator has configured a shared provider key and a user has selected either the shared default or a personal key.
* **When**: The user starts new provider-backed work.
* **Then**: The selected configuration is resolved for that work. Shared key material never appears in the user's browser, account directory, archive, logs, or plugin environment. A running job retains its resolved configuration; changed administrator defaults affect only newly admitted work.

### CUJ 4: Complete Account Export and Restore

* **Given**: A user has chats, graph/knowledge data, workspace files, settings, personal provider keys, prompt/theme customizations, and installed plugins.
* **When**: The user exports a complete archive, then imports it into the same account on another installation.
* **Then**: The archive contains all durable account content and personal credentials, with a manifest and format versions; rebuildable caches are excluded. Import validates the entire archive before replacing the account space. A successful restore recreates the same durable account content without including shared administrator keys or transferring the original Clerk identity or UID/GID.

### CUJ 5: Category-Only Restore

* **Given**: An account already contains chats and graph/knowledge data.
* **When**: The user imports a chat-only or graph/knowledge-only archive and confirms replacement.
* **Then**: Only the selected category is replaced. Other categories remain unchanged. The system stops conflicting active work and resolves category dependencies before committing the replacement; a failed validation or write leaves the previous category data available.

## Technical Plan (Architecture)

### Deployment and Trust Boundaries

The web deployment retains one Docker application container, but no longer runs all work under the shared `node` identity. Next.js runs as a dedicated unprivileged web identity and relays authenticated operations. An independent non-root controller verifies Clerk sessions, owns the account registry and UID/GID non-reuse ledger, and issues short-lived single-use capabilities bound to the verified Clerk subject, internal account, operation, and worker generation. A root-owned helper is the only application component that changes Linux identity, sets ownership, prepares namespaces, and supplies directory-bound file descriptors. Account workers run as dynamically allocated, per-account UIDs/GIDs. A separate unprivileged provider executor handles shared-provider traffic, and fenced unprivileged parser/migration services handle untrusted documents and archives.

The controller does not become root, and the root helper does not parse Clerk tokens, own registry transactions, handle provider credentials or traffic, or parse documents, provider responses, archives, or migrations. Shared keys and the instance encryption key belong to the controller or provider-executor state outside account homes. Validated parser input is immutable, and inherited descriptors cannot be used to reopen writable input through `/proc/self/fd` or an equivalent descriptor path.

The Docker socket is never mounted into the application container. The image and privileged executables are root-owned and not writable by the web, controller, provider, parser, or account identities. Public multi-user mode requires a read-only root filesystem. Only explicitly designated registry/account, staging/snapshot, instance-state, and private-working mounts are writable; there is no fallback to shared account storage. The container drops capabilities not required by the narrowly scoped root helper and applies seccomp, resource limits, and a dedicated PID namespace. The privilege-changing path must be compatible with these controls; Docker `no-new-privileges` must not be enabled on a path that relies on setuid or file capabilities.

Root on the Docker host remains trusted. Linux ownership isolates accounts from one another and from the web process; it does not conceal data from the host operator. Desktop mode keeps its existing local, single-user launch and does not require Clerk.

### Components

```text
Browser
   |
   | Clerk session and requested operation
   v
Next.js web relay (unprivileged web UID)
   |
   | private local IPC; forwards session proof and operation
   v
Non-root account controller
   |-- independently verifies Clerk subject and account mapping
   |-- solely owns registry, lifecycle state, and UID/GID non-reuse ledger
   |-- holds the instance encryption key and shared-instance policy
   |-- issues single-use subject/account/operation/generation capabilities
   |
   | verified capability over authenticated local IPC
   v
Narrow root helper
   |-- checks controller peer and capability; no Clerk or registry parsing
   |-- prepares identity, ownership, namespaces, and directory descriptors
   |-- starts/reuses only the matching account worker generation
   |
   +--> Account A worker (UID A/GID A; home /data/accounts/A-id)
   |      chats, graph, jobs, settings, plugins, workspace, personal auth
   |
   +--> Account B worker (UID B/GID B; home /data/accounts/B-id)
          chats, graph, jobs, settings, plugins, workspace, personal auth

Controller/provider state --> unprivileged shared-provider executor
Root-locked immutable input --> unprivileged fenced parser/migration services
```

The account registry maps immutable Clerk user IDs to random internal account IDs, allocated Linux UID/GID values, lifecycle state, and the administrator role. Registry entries never use email addresses, usernames, or archive-supplied values as filesystem paths. Only the controller writes the registry and non-reuse ledger; web and account UIDs cannot modify them. UID/GID allocation comes from a configured non-overlapping range, is serialized by the controller, and is never reused automatically after account deletion.

First-account bootstrap is one serialized controller transaction gated by the host-issued secret. Public registration and legacy claim remain closed until it commits. The controller consumes the secret permanently only on success, and retries are permitted only before any account/administrator or UID/GID allocation commits. A Clerk webhook is not the authority for creating local privileged state: the verified, signed-in Clerk identity initiates provisioning, while a verified external deletion webhook only disables the account and revokes active work. Recreated Clerk accounts do not inherit old local state.

The root helper authenticates its controller peer and verifies the single-use capability's account, operation, and requested worker generation before performing privileged work. It checks that the resolved account directory has the expected owner, is not a symlink, and remains beneath the fixed account root. It drops all supplementary groups, sets the account GID and UID with no saved or regained privileged identity, sanitizes the environment, and starts the worker with a fixed executable and arguments. It never accepts an executable path, UID, GID, home path, or arbitrary environment from an HTTP caller.

A worker starts on demand for an authenticated request or unfinished background work. It exits after an idle timeout; pending jobs keep it alive. The web process does not directly read account files for application requests. It forwards authorized operations through the controller to the account worker over authenticated local channels and returns only the operation's explicit response. Account responses and streams carry the account identity internally, but no bearer token is exposed to browser code, plugins, or agent tools.

User-confirmed deletion immediately disables and fences the account, terminates streams, and cancels or drains jobs, plugin processes, and provider work. A non-content recovery flow remains available for seven days, after which a non-content cleanup operation permanently deletes account data and credentials. External Clerk deletion only starts disablement; it does not erase data. The sole administrator must transfer the role before deletion. Host bootstrap recovery can appoint a replacement administrator without adding private-content APIs.

### Authentication and Request Authorization

Clerk middleware protects web pages and API routes while allowing only the required sign-in, sign-up, and verified webhook endpoints to remain public. Before bootstrap commits, registration and legacy-claim endpoints remain closed; afterward, ordinary registration opens without another bootstrap secret. Route handlers forward the authenticated server-side session proof to the controller; middleware is not the only authorization check. The controller independently verifies Clerk sessions and binds each API, streamed response, plugin call, export, and background-job operation to that subject's account, never to a client-supplied account ID.

The existing browser host and cross-site protections remain in web mode, and the desktop capability check remains in desktop mode. The account worker replaces the web process's shared global stores for web requests. Event streams only carry notifications for the authenticated account, and each reconnection requires fresh authorization. Account disablement or deletion terminates active streams and fences new work immediately.

The administrator role authorizes shared provider settings, shared model defaults, instance policy, and resource-limit configuration only. It grants no API to read another account's content, invoke its worker, download its archive, or obtain its personal credentials.

### Account Storage and Worker Runtime

Each account receives a private home under a root-owned account root that denies traversal to the web UID and non-owning account identities. Only the root helper creates the top-level account home and sets its owner and mode. Its account data and workspace are inaccessible to the web UID and other account UIDs through ownership and mode, not through filenames kept secret.

Existing store ports remain the domain boundary inside the account worker. The existing synchronous JSON/JSONL adapters initially run unchanged within that worker, using its account-specific `LH_DATA_DIR` and `LH_AUTH_FILE`. This avoids a simultaneous database or storage-thread migration. Synchronous store work can delay same-account cancellation and event delivery; the initial implementation must measure those latencies and store sizes and enforce record and archive size bounds. Generation fencing and restore exclusion are the primary writer-coordination mechanisms. Add cross-process store locking only for a specifically named writer that fencing cannot exclude.

The account worker owns chats, graph operations, job recovery, event production, settings, provider resolution, themes, prompt overrides, and plugin initialization for one account. Only one active worker generation may mutate a given account at a time. Controller-issued generation capabilities and root-helper fencing prevent an old worker from accepting new work after restart, restore, or account disablement.

Filesystem tools in web mode use an allowlisted account workspace root, opened relative to a trusted directory descriptor. They reject absolute paths, traversal, symlinks that escape the workspace, and access through renamed directories. Account-private application records and personal credential files are outside the agent-readable workspace even though the worker UID owns them. Read-only application assets are separately mounted or opened by trusted worker startup code; the general server home and Docker host paths are unavailable to tools.

Every uploaded, imported, or agent-created file is created with the account UID/GID and private permissions at creation time. There is no shared temporary directory, web-UID-owned intermediate file, world-readable upload, or post-upload period with different ownership. Incoming files begin in locked account-owned staging and are promoted atomically to their designated categories after validation. The web process streams bytes through authenticated local IPC rather than writing into account storage itself.

The root helper creates each incoming-file staging parent as a root-owned, non-traversable directory that the account cannot rename, replace, or read during validation. It supplies a one-operation, directory-bound upload channel. The channel creates only the declared regular file with the account UID/GID and private mode, verifies byte limits and the final descriptor's identity and ownership, and prevents links or other file types. Fenced unprivileged validation and conversion services operate on immutable, already-account-owned input descriptors. After validation, the root helper moves the file atomically into the correct account-owned category, then makes it visible to the account worker. A rejected or interrupted upload is removed without entering live account data. Account code cannot replace a file while it is being checked or reopen validated input for writing through inherited descriptors.

Persistent note metadata and graph source records live with the account's graph records. Original imported documents live in the account's private source-file category, not only as graph excerpts. Processed learner images, generated visual assets, and attachments live in their account-owned asset categories with their referencing chat/job records. A semantic `FileStore` port in `src/core/ports.ts`, implemented by an adapter under `src/store/` and wired in the account-worker composition root, owns file metadata and reference tracking; the private file library coordinates use cases rather than becoming a parallel store. Downloads are streamed by the owning worker through an authenticated route after checking the file record's ownership; files never receive public static URLs. The full archive includes all durable original and derived files, while category-only archive manifests declare their required assets and record dependencies.

The implementation must inventory every temporary, cache, render, installation, and atomic-write location, including PDF operations, extraction, image processing, Claude Code turn files and installation execution, Chromium, and store writes. The root helper creates per-account private working directories with private modes and safe file creation; cleanup, reservation checks, and the explicitly writable mounts cover all of them. No shared predictable `/tmp` path remains in multi-user mode.

Worker processes receive per-account process-count, CPU, memory, and concurrent-job limits. Public multi-user mode refuses to start when the selected process, CPU, or memory limits cannot be enforced on the host. Filesystem account quotas provide disk boundaries where supported. Where quotas are unavailable, application reservation is explicitly best-effort and cannot stop account plugins from filling shared storage. A root-owned global reserve remains outside account control; the accepted risk is cross-account availability loss through disk exhaustion, not weakened confidentiality or integrity.

Configurable global admission limits bound active accounts, active workers, streams, provider connections, archive work, and temporary storage, with queueing and backpressure rather than unbounded admission. Per-account and global limits apply to provider execution and parser/migration services as well as workers. API default spending quotas are not included in this version.

### Shared and Personal Provider Configuration

The current pattern of copying `auth.json` into `process.env` cannot cross account boundaries. In web mode, the account worker holds personal credentials only in its own protected environment and never receives the web process environment. Shared keys are logically administrator-managed but stored in controller/provider-executor state outside every account home and outside the administrator's personal UID.

A worker that uses a shared default receives an opaque, short-lived provider capability bound to the account, provider, operation, and resolved configuration generation. The unprivileged provider executor uses the shared key for the allowed provider request and returns only the provider response. It does not return the key or permit arbitrary destination URLs, arbitrary headers, file reads, or commands. Model streaming passes through this executor without logging credentials. Personal BYOK requests can execute directly within the owning worker under the same provider policy interface.

The provider resolution snapshot is attached to admitted work. Administrator changes take effect for new work only. Workers, plugins, and agent tools receive only the shared-provider capability, never shared key material. Usage and error records identify the account and configuration generation without containing secret values.

The controller pushes personal-credential additions, updates, and deletions to the owning running worker and fences obsolete snapshots without exposing personal or shared key contents to the browser. Versioned instance encryption keys persist in controller-only instance state outside accounts. New ciphertext uses the new key; rotation gradually re-encrypts old ciphertext, and an old key is retired only after migration completes. Loss of every key required by stored ciphertext makes the affected BYOK unrecoverable.

The provider support matrix covers personal API keys, custom endpoints, shared search and dictation credentials, CLI authentication, and personal OAuth/subscription connections. API keys and supported custom endpoint bindings are encrypted per account and included in full archives. Shared administrator keys remain only in provider-executor/controller state. Personal OAuth/subscription tokens are excluded from archives and require reconnection; CLI credentials receive the same account isolation and are exported only when they are personal API-key material rather than OAuth/subscription tokens.

### Plugins and Background Work

Users install and enable their own plugins. The root helper starts plugin backends only inside the owning account worker, with that account's UID/GID and workspace boundaries. Plugin installation writes are confined to the account plugin directory, and the web process never executes uploaded plugin code.

This is a boundary between accounts, not a sandbox between a user and their own plugin. A plugin can access the data made available to its owning worker and use the worker's provider capabilities according to policy. The installation interface must state this trust requirement. Plugin processes inherit account resource limits and receive neither controller/helper IPC credentials nor shared-provider secrets.

All background-job records, delivery obligations, and recovery state remain in the owning account. Worker startup recovers only that account's unfinished jobs. Controller capabilities and generation fencing prevent delivery to another account, and restored jobs are not automatically executed until archive validation and account restore complete.

### Export, Import, and Replacement Semantics

Exports run inside the owning account worker after obtaining a consistent account snapshot. The archive is a versioned, checksummed package with a manifest that lists categories, application/source versions, data-format versions, file sizes, and supported migration requirements. Paths are relative, portable, and free of original UID/GID, Clerk subject, local account ID, and server-specific absolute paths.

A full archive includes chats, graph/knowledge, recoverable job records, durable account files, unfinished work, non-regenerable temporary files, settings, prompt overrides, themes, personal API keys and provider bindings, installed plugins, and plugin data. Rebuildable caches are excluded. The manifest classifies every included or excluded workspace item and records regeneration requirements. Staging, snapshots, old generations and rollback copies, shared administrator credentials, shared provider policy, and personal subscription/OAuth tokens are excluded. After restore, users must reconnect subscription/OAuth services; restored configuration must not treat a missing token as an active connection. Restored plugin code and data are present, but every restored plugin is disabled until its owner explicitly reviews and enables it.

Chat-only archives include chats, attachments/images, and the source snapshots required by those chats; graph/knowledge remains unchanged. Missing graph-node links become historical ID/text snapshots. Graph-only archives include graph/knowledge, sources, source assets, coverage, positions, and render settings; chats and workspace remain unchanged. Missing chat-to-node links become historical ID/text snapshots, and old extraction jobs are cancelled rather than replaced. Every archive uses stable portable file IDs. Export rewrites file-backed references to those IDs, and import validates every rewritten reference and dependency before commit.

Personal credentials at rest are encrypted with an instance key held by the controller outside account storage. The controller releases decrypted personal credentials only to the matching worker through its private launch channel. This encryption limits disclosure from a copied account directory or volume alone; it does not protect against the trusted host/root operator, who can also obtain the instance key.

Export stops or fences jobs, plugin sidecars and their children, and account streams; drains buffered writes; flushes account data; and only then takes a consistent snapshot. The snapshot lives beneath a root-controlled, non-traversable parent and is not writable by the account. Packaging receives read-only access only. Work can resume after snapshot creation, while snapshots and packaging artifacts remain excluded from subsequent archives. Capacity checks account for snapshot and archive space.

A full archive always requires a user-supplied passphrase and encrypts its entire payload, including content, file names, and manifest, using a versioned password-based authenticated-encryption format. Only the format/KDF header is unencrypted, and its parameters are authenticated with the payload. The format uses a memory-hard KDF, provides minimum-passphrase guidance, and bounds accepted KDF cost parameters to prevent resource exhaustion; algorithm selection remains implementation work. The passphrase is never persisted or logged, and a lost passphrase makes the archive unrecoverable. Chat-only and graph/knowledge-only exports may be unencrypted packages with an explicit privacy warning.

The browser receives an archive only through a fresh authenticated download authorization. Responses are marked private and no-store. The interface warns that a full archive contains personal credentials and installed code. No scheduled backup service is added.

Import uploads to a root-locked staging directory outside the target account's live data and workspace. Individual staged files are created through the same directory-bound channel with the target account's UID/GID and private permissions; the account cannot access the staging parent or replace files during validation. Before replacement, the system rejects unsafe paths, links, special files, duplicate manifest entries, oversized expanded content, unexpected ownership requests, unsupported future versions, and checksum failures. Fenced unprivileged parser/migration services read immutable staged input and write separate migrated output through controlled descriptors. Validation never mutates staged input, and migrated stores are verified without opening them as live mutable stores. Existing graph-import, image, PDF, and notes-limit validation is composed rather than recreated.

The initial release accepts archive format v1 containing data formats understood by that build. A missing graph sidecar means graph format v1 under the existing graph contract. Corrupt or missing required version stamps and future or unknown archive/data formats fail before mutation. Older versions require an explicit tested migration added later; support is not inferred from a best-effort parse.

For a full archive, the target account's active worker and jobs are stopped and fenced. The system builds and fsyncs a complete new generation on one filesystem, then commits by atomically switching one durable generation pointer. Startup reconciles that pointer and any interrupted import journal before admitting work. The old generation remains intact until the new generation passes health checks; failed startup switches back to the retained generation and keeps new work disabled until reconciliation completes.

For chat-only or graph/knowledge-only imports, only the selected category is replaced after validation, dependency planning, and confirmation. The confirmation screen describes which categories will be lost. Category replacement uses a durable journal, same-filesystem swaps, fsync ordering, and rollback so any interruption leaves either the complete old category state or the complete new category state after startup reconciliation. Chats cannot leave active jobs operating on replaced records; graph replacement cancels old extraction work and applies the historical-link rules above.

Successful import discards staging and retired generations or rollback copies only after health checks, starts a new worker generation, and requires fresh authorization for subsequent operations. Restore does not change the target Clerk identity, local account ID, UID/GID, administrator role, or shared-provider entitlements. Archive plugin code is not executed during validation or migration.

### Legacy Data and Rollout

At upgrade, the previous shared data/auth paths are quarantined rather than exposed through the new account resolver. Legacy claim remains closed until bootstrap commits, after which only the first administrator may explicitly claim it. Every external file referenced by legacy chats, notes, images, attachments, jobs, or plugins must first be inventoried and validated. If any referenced file is missing, inaccessible, duplicated ambiguously, or fails validation, the entire claim is blocked without partial migration. The UI reports only failure codes and counts; host operators repair the volume or paths through a CLI and retry. The claim never destructively moves legacy source data.

Valid external files are copied non-destructively into their correct account-owned categories with the administrator's UID/GID and private modes. A durable claim journal and startup reconciliation coordinate copies, reference rewrites, migrations, and final activation; a crash cannot expose a partially claimed generation. Until the claim succeeds, no account can read the legacy data.

Web multi-user mode is enabled by explicit deployment configuration and requires Clerk, the controller, root helper, private IPC, read-only root filesystem, designated writable mounts, and supported resource controls to be ready. Missing or partial security configuration makes the system refuse public startup; shared-storage web fallback is prohibited. Desktop mode preserves the existing local composition root and data paths.

### Failure Handling and Security Evidence

The design treats cross-account access attempts, controller/helper authentication failures, unexpected worker identity, symlink/path escapes, and unauthorized administrator actions as security-relevant events. Logs contain account IDs and operation IDs but no chat content, archive contents, passphrases, or provider keys.

Release evidence must include tests in which two non-administrator accounts attempt direct and agent-mediated reads/writes against each other's data, plugin and background-job attempts to escape account boundaries, forged/expired controller capabilities, shared-key disclosure checks, unauthorized bootstrap and concurrent first-registration attempts, archive traversal cases, interrupted restores, upload ownership/race checks, active-work revocation on deletion, and web/desktop compatibility checks. A passing route-level `403` test alone is insufficient: the tests must demonstrate kernel-enforced ownership and effective process credentials.

## Alternatives Considered

### Alternative A: Clerk Authentication with Shared Application Storage

* **Pros**: Smaller change to the existing Next.js application; no account worker or privileged identity helper is required.
* **Cons**: Every agent, plugin, and store operation retains the web process's filesystem authority. A missed `userId` check can expose another account's records, and filesystem tools can reach shared server paths.
* **Reason for Rejection**: Rejected by author: login and route checks do not provide the requested Linux ownership and process-level isolation.

### Alternative B: One Container per Account

* **Pros**: Gives each account a separate process and filesystem namespace and reduces reliance on changing UID inside one container.
* **Cons**: Requires host-side orchestration and tightly controlled Docker API access. Idle containers, images, networking, upgrades, and resource accounting add operational cost. Mounting the Docker socket into the web application would create a host-level escape path.
* **Reason for Rejection**: Rejected by author: the selected deployment is one Docker container with a non-root controller and narrowly scoped root identity helper rather than a container-orchestration control plane.

### Alternative C: Per-Worker User Namespaces in One Container

* **Pros**: Can add namespace-level separation in addition to ownership.
* **Cons**: Requires explicit runtime and kernel support, UID/GID map and volume handling, and additional validation of provider networking and filesystem behavior. Deployment must verify these prerequisites on each supported host.
* **Reason for Rejection**: Rejected by author: the selected controller/helper model has fewer host prerequisites and fits the one-container deployment requirement.

### Alternative D: Move All Account Data to a Shared Database During This Change

* **Pros**: Could provide transactions and centralized record queries.
* **Cons**: A database `tenant_id` does not isolate arbitrary workspace files, plugin code, or process privileges. Rewriting every store while introducing account workers and archive formats would increase migration and rollback risk.
* **Reason for Rejection**: Rejected by author: retain the existing store ports and JSON/JSONL adapters inside isolated account workers first; a later database change must not replace OS ownership.

### Alternative E: Scheduled Server-Side Backups

* **Pros**: Could provide restore points without user action.
* **Cons**: Requires backup storage, retention policy, encryption, deletion semantics, and an administrative recovery interface. Those features can conflict with the requirement that the application administrator cannot read user archives.
* **Reason for Rejection**: Rejected by author: this version provides user-initiated export and import only, with no scheduled backups.

### Alternative F: Administrator-Installed Plugins for All Users

* **Pros**: Limits plugin code to packages selected by the instance administrator.
* **Cons**: Does not match the requested user control over account configuration and installed extensions.
* **Reason for Rejection**: Rejected by author: each user installs their own plugins, which run as that user's UID and are explicitly trusted with that user's accessible data.

### Alternative G: Merge Imported Archives into Existing Account Data

* **Pros**: Can retain both existing and imported records.
* **Cons**: Requires conflict resolution for record IDs, settings, graph provenance, credentials, plugins, and cross-category dependencies. A partial merge can leave the account in a state that neither archive nor previous data describes.
* **Reason for Rejection**: Rejected by author: full import replaces the full account space; category-only import replaces the selected category after validation and a confirmed dependency plan.

## Detailed Implementation Plan

The phases are security gates, not independent feature slices. Public multi-user mode remains unavailable until Phases 1–5 pass their isolation tests. No phase modifies production behavior merely by detecting that Clerk variables exist; an explicit `LH_DEPLOYMENT_MODE=multiuser-web` selects the new composition root.

### Phase 1: Separate Web, Controller, Worker, and Desktop Composition Roots

**Objective**: Introduce explicit deployment modes without changing the working desktop/single-user behavior.

* **Files to Create**:
  * `src/runtime/deployment-mode.ts` — parse and validate desktop, existing single-user development, and multi-user web modes.
  * `src/runtime/multiuser-config.ts` — validate account UID/GID ranges, account root, IPC paths, resource controls, required Clerk settings, read-only root, and designated writable mounts without exposing secrets.
  * `src/runtime/readiness.ts` — startup readiness and fail-closed checks.
  * `tests/deployment-mode.test.ts` — mode selection, invalid combinations, and startup refusal tests.
* **Files to Modify**:
  * `package.json` and `package-lock.json` — add the supported Clerk Next.js SDK and controller/runtime dependencies; add worker, controller, helper, and multi-user test scripts.
  * `config.ts` — separate immutable application assets, controller registry state, account roots, upload staging, snapshots, private working directories, and desktop data; prevent account-controlled paths from changing controller/helper configuration.
  * `src/server/index.ts` — expose a request-scoped account relay interface rather than requiring routes to import global mutable stores directly.
  * `src/server/stores.ts` — retain the existing adapter wiring as the single-account worker composition root; do not initialize it in the multi-user web process.
  * `instrumentation.ts` — dispatch initialization by deployment mode; remove global plugin initialization from the multi-user web process.
  * `next.config.ts` — trace worker/controller entry points and privileged helpers into the standalone payload; retain the multipart transport ceiling without treating it as storage validation.
  * `scripts/build-server.mjs` and `tests/desktop-payload.test.ts` — verify the additional multi-user payload while preserving the Electron payload.
  * `.env.example`, `.gitignore`, `docs/architecture.md`, and `docs/docker.md` — document modes, secret-bearing instance files, account volumes, and excluded generated artifacts.
* **Resolution Step**: On a throwaway checkout, run existing unit tests, typecheck, desktop payload tests, and the new readiness tests. Confirm that desktop mode still opens the original local stores and that multi-user web startup refuses to run with global account stores or without the required mount controls.

### Phase 2: Clerk Identity, Bootstrap, and Controller-Owned Provisioning

**Objective**: Authenticate every web caller, gate first-admin assignment with host authorization, and create exactly one private Linux identity per Clerk account.

* **Files to Create**:
  * `app/sign-in/[[...sign-in]]/page.tsx`, `app/sign-up/[[...sign-up]]/page.tsx`, and first-admin setup UI — Clerk authentication and host-authorized bootstrap surfaces.
  * `app/api/webhooks/clerk/route.ts` — verified deletion webhook that only starts disablement; never an administrator-creation or immediate-erasure authority.
  * `src/accounts/contracts.ts` — account records, roles, lifecycle states, internal IDs, and registry version contracts.
  * `src/controller/clerk-identity.ts` — independent server-side Clerk session verification with no client-supplied identity trust.
  * `src/controller/registry.ts` — sole-owner serialized bootstrap, UID/GID allocation, lookup, role transfer, disablement, seven-day deletion, and non-reuse ledger.
  * `src/controller/provisioning.ts` — atomic first-admin commit, secret consumption/retry rules, legacy-claim eligibility, and host recovery appointment.
  * `src/controller/capabilities.ts` — subject/account/operation/generation-bound, expiring single-use capabilities.
  * `src/accounts/request-context.ts` — relay request context that carries session proof but never asserts account authority.
  * `src/controller/protocol.ts` — versioned discriminated IPC messages, operation limits, stream framing, and error contracts.
  * `tests/account-registry.test.ts`, `tests/clerk-auth.test.ts`, `tests/account-provisioning.test.ts`, and `tests/account-lifecycle.test.ts`.
* **Files to Modify**:
  * `proxy.ts` — replace the old application access gate with Clerk route protection and explicit public routes while retaining host and cross-site defenses; preserve the desktop capability branch.
  * `app/layout.tsx`, `components/sidebar.tsx`, and the home/chat server-component entry points — obtain theme/bootstrap data through the authenticated account request rather than global stores; do not expose private Clerk metadata.
  * `components/settings/settings-dialog.tsx` — add sign-out/account/deletion status and make settings requests account-scoped.
  * `docs/architecture.md` — document independent Clerk verification, controller registry ownership, bootstrap, role transfer, and deletion timing.
* **Resolution Step**: Test closed registration before bootstrap, invalid and replayed bootstrap secrets, rollback/retry before commit, permanent consumption on success, concurrent first-admin attempts, subsequent open registration, signed-out denial, webhook forgery/deletion, active-work revocation, seven-day recovery/erasure, sole-admin transfer, host recovery, recreated Clerk identities, UID/GID non-reuse, and desktop requests without Clerk. Inspect `/proc` and filesystem metadata in integration fixtures to prove the provisioned identity rather than only checking registry JSON.

### Phase 3: Narrow Root Helper and On-Demand Account Workers

**Objective**: Move all account execution out of the web UID and enforce process/filesystem identity at the kernel boundary without making the root helper a general application service.

* **Files to Create**:
  * `helper/` — a memory-safe privilege-boundary helper limited to descriptor-based directory creation, ownership changes, UID/GID dropping, namespace preparation, and fixed-executable launch; keep Clerk, registry, provider, document, and archive parsing outside it.
  * `helper/IDENTITY_TOOLS.md` — recorded evaluation of shipped `gosu` and `setpriv` for sanitized fixed worker launch; commission native code only for descriptor-relative/no-link operations those tools cannot provide.
  * `src/controller/main.ts` — non-root authenticated local IPC service, registry/capability verification, and fixed request dispatcher.
  * `src/controller/identity.ts` — verified allocation handoff, group-removal instructions, and post-exec identity assertions.
  * `src/helper/paths.ts` — descriptor-relative path resolution, no-link traversal, ownership checks, and same-filesystem rename primitives.
  * `src/controller/worker-manager.ts` — on-demand start, idle stop, single-generation fencing, restart, deletion fencing, and shutdown.
  * `src/controller/ipc-server.ts` and `src/server/account-client.ts` — private stream transport with bounded messages, cancellation, backpressure, and peer-credential verification.
  * `src/worker/main.ts` — sanitized account-worker entry point with fixed application root and account-only `LH_DATA_DIR`/`LH_AUTH_FILE`.
  * `src/worker/service.ts` — account-local chat, graph, settings, files, provider, plugin, job, and archive request dispatcher.
  * `src/worker/resources.ts` — per-account and global process/job/stream/archive admission and cgroup/resource-limit integration.
  * `tests/controller-protocol.test.ts`, `tests/helper-paths.test.ts`, `tests/worker-lifecycle.test.ts`, and `tests/multiuser-isolation.test.ts`.
* **Files to Modify**:
  * `Dockerfile` — install root-owned helper and worker/controller payloads with non-writable permissions; retain unprivileged Next.js, controller, provider, and parser identities and evaluate the already shipped `gosu` before adding native identity code.
  * `docker-entrypoint.sh` — replace recursive `/data` ownership changes and permanent root drop with persistent root supervision of only the narrow helper; start Next.js and other services under their distinct unprivileged UIDs.
  * `docker-compose.yml` — require a read-only root; enumerate only registry/account, staging/snapshot, instance-state, and private-working writable mounts; configure IPC, the required capability allowlist, PID/resource controls, and required security options; never mount the Docker socket.
  * `scripts/build-server.mjs` — include and smoke-test worker, controller, and helper entry points.
  * `src/server/index.ts` and every `app/api/**/route.ts` — relay authenticated operations through the controller/account client; no direct global account-store reads or writes remain in multi-user mode.
* **Resolution Step**: In the real Docker image, create two accounts and inspect real/effective/saved UID/GID and supplementary groups. Attempt cross-home traversal, symlink/hardlink attacks, forged controller/helper IPC, capability replay, worker-generation reuse, arbitrary executable/environment injection, writable-input reopening through `/proc/self/fd`, and access after disablement. Verify read-only root and mount boundaries, idle shutdown, active-job retention, crash cleanup, restart recovery, global backpressure, and unchanged desktop execution.

### Phase 4: Account-Owned Files, Notes, Images, and Library

**Objective**: Ensure every user file enters the correct account category with the correct UID/GID from creation and remains privately downloadable.

* **Files to Create**:
  * `src/files/contracts.ts` — portable file IDs, category, owning record, original name, media type, size, digest, lifecycle, and archive inclusion metadata.
  * `src/store/files.ts` — `FileStore` adapter for account-local metadata and reference tracking.
  * `src/helper/upload-channel.ts` — root-locked staging parent, one-file directory-bound channel, account-owned descriptor creation, byte/disk limits, and atomic promotion.
  * `src/files/library.ts` — use-case coordinator for list/read/download/delete through the owning worker.
  * `src/files/validation.ts` — composition of existing regular-file, content, image/PDF/document, size, notes-limit, and decompression validation, separated from storage placement.
  * `src/parser/main.ts` — fenced unprivileged document/parser service using immutable inputs and controlled output descriptors.
  * `app/api/files/route.ts` and `app/api/files/[id]/route.ts` — authenticated private library and streaming downloads with private/no-store responses.
  * `components/file-library.tsx` — original-file list, metadata, download, and safe error states.
  * `tests/upload-ownership.test.ts`, `tests/file-library.test.ts`, and `tests/upload-races.test.ts`.
* **Files to Modify**:
  * `src/core/ports.ts` and `src/server/stores.ts` — add the semantic `FileStore` port and wire its adapter in the account-worker composition root.
  * `app/api/graph/import/route.ts` — stream each multipart file into its helper-issued channel; persist the original before extraction, associate source metadata, and avoid shared temporary files.
  * `app/api/graph/sources/route.ts` and source-deletion flows — include original-file metadata and explicit reference/deletion semantics.
  * `src/server/submission-images.ts`, `app/api/chats/[id]/images/[snapshotId]/route.ts`, `src/agent/tools/learner-image.ts`, and `src/agent/image-processing/**` — keep original and processed images in account-owned categories and associate them with chat/job records.
  * `src/agent/subagents/pdf-ops.ts`, `lh-import-*` producers, `claude-code-*` producers, Chromium/render paths, and related converters — replace OS/shared or predictable temp paths with helper-created per-account private working directories and descriptors; cleanup never removes the retained original.
  * `src/agent/tools/fs-shared.ts`, `src/agent/tools/file-access.ts`, and `src/server/file-access.ts` — use only the account workspace root in web mode; retain local policy behavior in desktop mode.
  * `src/server/chats.ts`, `src/server/graph.ts`, `src/server/source-organization.ts`, `src/server/source-deletion.ts`, `src/store/chats.ts`, `src/store/graph.ts`, and `src/core/contracts.ts` — add stable portable file references and preserve provenance across record operations.
  * `components/attach-files-button.tsx`, `components/notes-import-queue.ts`, `components/artifacts/**`, and relevant chat/file UI — use private file records and download routes rather than public paths.
  * `lib/notes-import-limits.ts` and `next.config.ts` — keep transport, expanded-content, per-file, per-operation, and account-disk reservation limits consistent.
* **Resolution Step**: Upload notes, Markdown, PDFs, images, attachments, and mixed batches as two users. At creation, validation, conversion, promotion, processing, download, and restart, verify owner/group/mode/category and the absence of shared or web-UID temporary artifacts. Race malicious account code against validation; test links, special files, descriptor reopening, oversized bodies, interrupted streams, missing files, cross-account IDs, and public URL access. Measure synchronous-store latency/size and verify record/archive bounds. Export and re-import every file type before completion.

### Phase 5: Provider Secrets, Shared Defaults, and Account Plugins

**Objective**: Support shared provider use and BYOK without disclosing shared keys or moving global plugins/secrets into the web process or root helper.

* **Files to Create**:
  * `src/providers/policy.ts` — resolved provider configuration, generation, shared/BYOK selection, allowlisted operations, and redacted public metadata.
  * `src/providers/shared-executor.ts` — unprivileged fixed-provider request execution using opaque capabilities; block arbitrary URLs, headers, commands, and file access.
  * `src/providers/capabilities.ts` — short-lived account/provider/operation/generation bindings and streaming cancellation.
  * `src/controller/personal-secrets.ts` — versioned authenticated encryption, gradual multi-key rotation, owning-worker release, and running-worker update/fencing.
  * `src/controller/shared-settings.ts` — administrator-only shared defaults and key writes into controller/provider-executor state outside account homes.
  * `app/api/admin/providers/route.ts` and `app/api/admin/providers/[id]/route.ts` — administrator management with no private-account APIs.
  * `components/settings/admin-providers.tsx` and `components/settings/account-providers.tsx` — separate shared-default selection from personal-secret management.
  * `tests/provider-isolation.test.ts`, `tests/provider-key-rotation.test.ts`, and `tests/plugin-account-isolation.test.ts`.
* **Files to Modify**:
  * `src/server/keys.ts`, `src/store/auth.ts`, `src/server/custom-provider*.ts`, `src/server/model-catalog.ts`, `src/server/search.ts`, `src/server/web-subscriptions*.ts`, `app/api/keys/**`, `app/api/models/route.ts`, `app/api/search/route.ts`, `app/api/custom-provider/route.ts`, and `app/api/stt/token/route.ts` — replace shared `process.env` mutation with request/job-scoped provider policy; implement the API-key/custom-endpoint/search/dictation/CLI/OAuth support and archive matrix.
  * `src/models.ts`, agent/provider call sites, and streaming consumers — execute through resolved shared capability or personal BYOK policy without logging secrets.
  * `src/server/plugins.ts`, `src/server/plugin-host.ts`, `src/server/plugin-*.ts`, `src/agent/plugin-*.ts`, `src/store/plugin-*.ts`, and `app/api/plugins/**` — initialize/install/run only within the owning worker; remove web-process plugin initialization and shared event/job registries.
  * `src/core/events.ts`, `src/server/events-stream.ts`, `app/api/events/route.ts`, and `app/api/activity/**` — scope subscriptions and job delivery to an authenticated worker/account stream and terminate active streams on disablement.
  * `components/plugins.tsx`, `components/plugin-renderers.tsx`, and plugin management UI — explain same-account trust and expose restored-disabled state.
* **Resolution Step**: Verify shared keys never appear in browser responses, account files, worker/plugin environments, archives, errors, or logs. Confirm admin defaults affect only new work, personal secrets decrypt only in the owning worker, updates fence obsolete snapshots, rotation re-encrypts before old-key retirement, complete key loss has the documented failure, admin APIs cannot invoke/read other accounts, user plugins run under the correct UID, and OAuth/subscription connections are never exported.

### Phase 6: Versioned Archives and Crash-Safe Replacement

**Objective**: Implement complete and category-only portability with immutable snapshots, validation, durable recovery, encryption, and disabled restored plugins.

* **Files to Create**:
  * `src/archive/contracts.ts` — archive v1, manifest, application/data versions, portable file references, categories, dependencies, classifications, checksums, and migration declarations.
  * `src/archive/snapshot.ts` — complete quiescence of jobs/plugins/children/streams/writes, flushing, root-controlled read-only snapshot access, resume, and capacity enforcement.
  * `src/archive/export.ts` — full/chat/graph export, durable-file inclusion, cache exclusion, category dependency embedding, reference rewriting, and streaming.
  * `src/archive/encryption.ts` — versioned memory-hard passphrase KDF, authenticated header/parameters, bounded accepted costs, and authenticated encryption of the complete full-archive payload; no persisted passphrase.
  * `src/archive/validate.ts` — package/KDF limits, paths, links, duplicates, checksums, versions, non-executing plugin inspection, and immutable staged input.
  * `src/archive/migrations.ts` — fenced unprivileged migration service, current-format acceptance matrix, missing graph-sidecar v1 rule, and rejection of corrupt/future/unknown formats.
  * `src/archive/import.ts` — root-locked staging, account-owned files, dependency plan, worker fencing, full-generation pointer switch, category journal/rollback, fsync ordering, startup reconciliation, and restart.
  * `app/api/account/export/route.ts` and `app/api/account/import/route.ts` — fresh authorization, passphrase transport handling, replacement confirmation, and private/no-store streaming.
  * `components/settings/account-archive.tsx` — export choices, passphrase confirmation, sensitive-data warning, replacement summary, restore/reconnect/re-enable instructions.
  * `tests/archive-roundtrip.test.ts`, `tests/archive-security.test.ts`, `tests/archive-restore-rollback.test.ts`, and `tests/archive-migrations.test.ts`.
* **Files to Modify**:
  * `src/store/**` and data-format version modules — expose read-only verification and explicit migrations without opening staged data as live stores or mutating validation input.
  * `src/server/jobs.ts`, `src/store/jobs.ts`, plugin job records, and worker recovery — quiesce/fence active work, cancel old graph extraction jobs, and serialize only recoverable records; never auto-run restored jobs before restore completion.
  * `src/store/files.ts` and chat/graph/source modules — preserve original/derived assets, rewrite portable references, create historical ID/text snapshots, and resolve category dependencies before commit.
  * `src/server/study.ts`, `src/store/study.ts`, themes, render settings, prompt overrides, source organization, and settings stores — include all durable account categories in full export while leaving non-target categories unchanged during category-only replacement.
  * `docs/architecture.md` and `docs/docker.md` — document archive sensitivity, passphrase loss, no scheduled backups, replacement semantics, generation retention, and rollback storage.
* **Resolution Step**: Round-trip every export kind for archive v1/current data formats across different target UID/Clerk IDs. Verify full replacement, selected-category replacement, unchanged non-target categories, durable files and unfinished/non-regenerable work, cache exclusion, embedded dependencies and historical links, BYOK restoration, OAuth reconnection, and disabled plugins. Test wrong/lost passphrase, KDF bounds, tampering, traversal, missing/corrupt/future versions, non-mutating validation, full disks, crashes at every journal/pointer/fsync point, failed health checks, and rollback. Verify staging/snapshot/old-generation/rollback data is excluded from later archives.

### Phase 7: Legacy Claim, Resource Controls, and Full Route Migration

**Objective**: Complete the migration of every feature and quarantine legacy data until the first administrator claims a fully valid dataset.

* **Files to Create**:
  * `src/legacy/inventory.ts` — enumerate legacy records and all external file references before changing anything.
  * `src/legacy/claim.ts` — journaled all-or-nothing administrator claim, non-destructive validated copy, ownership assignment, reference rewrite, format migration, and startup reconciliation.
  * `scripts/legacy-repair.mjs` — host-only volume/path repair CLI with no private-content web API.
  * `app/api/account/legacy-claim/route.ts` and `components/settings/legacy-claim.tsx` — explicit post-bootstrap first-admin action and failure-code/count-only diagnostics.
  * `tests/legacy-claim.test.ts` and `tests/all-routes-account-scope.test.ts`.
* **Files to Modify**:
  * All remaining `app/api/**/route.ts`, server services, and server components not converted above, including chats, side chats, Claude Code, study, graph costs/coverage/status/positions/render settings, plugin documents/assets, subscriptions, and settings.
  * `src/worker/resources.ts`, `docker-compose.yml`, and controller/helper launch code — enforce configured process, CPU, memory, concurrent-job, global admission, stream, provider, archive, and temporary-storage limits; make unsupported mandatory enforcement fail closed and label disk reservation best-effort.
  * `docs/docker.md`, `.env.example`, and deployment troubleshooting — document cgroups/filesystem prerequisites, root-owned reserve, disk-exhaustion availability risk, capacity, no API-default spending quotas, and recovery.
* **Resolution Step**: Assert there are no multi-user imports of shared account stores or unrestricted server-home file policies. Test legacy claims with complete and missing/ambiguous/invalid external files; any defect blocks the entire claim without partial migration or destructive source movement. Inject crashes throughout claim journaling and verify startup reconciliation. Run two-account load tests to demonstrate per-account and aggregate enforcement, then run the complete existing test suite and desktop compatibility suite.

### Phase 8: User Experience, Documentation, and Release Evidence

**Objective**: Make account/security behavior understandable and produce reproducible evidence for the release gate.

* **Files to Create**:
  * `docs/multiuser-security.md` — trust boundaries, controller/helper contracts, Linux evidence, plugin limits, encryption and key loss, deletion, incident handling, and known limits.
  * `docs/account-archives.md` — archive contents/exclusions, encryption, replacement, archive v1/current data support, OAuth reconnection, and plugin reactivation.
  * `scripts/smoke-multiuser.mjs` — repeatable two-account Docker integration scenario.
* **Files to Modify**:
  * `README.md`, `docs/architecture.md`, `docs/docker.md`, `.env.example`, and relevant settings/help UI — align actual behavior and requirements; remove claims that authentication alone supplies isolation.
* **Resolution Step**: Execute build, typecheck, lint, unit/integration tests, Docker isolation tests, archive round trips, failure injection, and desktop payload tests. Record the exact commands and outcomes in the PR. Do not declare multi-user support if any account route still uses global storage or any agent/plugin can traverse another account.

## Milestones

### Milestone 1 — Deployment Skeleton and Controller-Owned Account Registry

Complete Phases 1–2. Deliver explicit modes, Clerk authentication, host-authorized bootstrap followed by open registration, controller-owned registry/capabilities, private provisioning, account lifecycle behavior, and passing auth/registry tests. Multi-user learning routes remain disabled until worker isolation lands.

### Milestone 2 — Kernel-Enforced Account Runtime

Complete Phase 3. Deliver the narrow root helper, non-root controller, on-demand workers, relay transport, replaced Docker identity model, read-only root/mount controls, resource groundwork, and real UID/GID/filesystem isolation evidence for two accounts.

### Milestone 3 — Private Files and Provider/Plugin Separation

Complete Phases 4–5. Deliver account-owned note/document/image/attachment flows, `FileStore` and private file library, unprivileged shared-provider execution, encrypted BYOK with rotation, per-account plugins/events/jobs, and their security tests.

### Milestone 4 — Portable Recovery and Complete Migration

Complete Phases 6–7. Deliver all export/import kinds, encrypted full archives, crash-safe generation/category replacement, current-format compatibility, disabled restored plugins, journaled non-destructive legacy claim, resource limits, and conversion of every route.

### Milestone 5 — Release Candidate

Complete Phase 8. Deliver documentation, repeatable Docker security evidence, full regression/typecheck/lint/build results, and explicit known limitations. Merge readiness requires human review of the controller/helper privilege boundary and a clean security/isolation test run; this design approval is not approval to implement or merge production changes.

## Testing Strategy

### Unit Tests

* **Deployment, bootstrap, and registry**: Parse valid/invalid modes; verify fail-closed configuration and mounts, closed registration before bootstrap, secret replay/consumption, retry before commit, first-admin atomicity, subsequent open registration, role transfer, seven-day lifecycle transitions, UID/GID range exhaustion, non-reuse, and deletion/recreation behavior.
* **Controller/helper protocol**: Test message versioning, size bounds, malformed frames, cancellation, backpressure, operation allowlists, independently verified subject/account bindings, capability expiry/single use, and generation fencing with property-based/fuzz inputs.
* **Descriptor paths and uploads**: Test traversal, absolute paths, links, renamed directories, special files, writable descriptor reopening, ownership/mode at creation, byte and expanded-size limits, interrupted streams, atomic promotion, and cleanup. Cover every file category, temporary producer, and archive staging path.
* **Provider policy**: Test shared/BYOK resolution, generation snapshots, capability scope/expiry, destination/header allowlists, personal-secret encryption, running-worker updates, gradual key rotation/loss, redaction, and OAuth/subscription exclusion.
* **Archive format**: Test manifests, portable references, dependency resolution, archive v1/current data acceptance, missing/corrupt/future stamps, non-mutating validation, passphrase/KDF authentication and bounds, wrong passphrases, tampering, replacement planning, generation-pointer and category-journal recovery transitions.
* **Account files and stores**: Test original/derived-file references, downloads, deletion, graph/chat dependencies and historical links, plugin restored-disabled state, preservation of untouched categories, synchronous-store latency/size measurements, and record/archive bounds.

Run these through the existing `npm test` structure, with new focused scripts for native helper and integration suites. Ordinary mocks may test control flow but cannot satisfy the Linux isolation gate.

### Integration Tests

* Run the real Docker image with two non-administrator accounts and the bootstrapped first administrator. Inspect real/effective/saved UIDs, GIDs, supplementary groups, process ancestry, cgroups, file ownership, permission modes, read-only root, and writable mounts.
* Attempt direct, chat-mediated, agent-mediated, plugin-mediated, and background-job access to another account's records, credentials, workspace, archive, IPC endpoint, and file descriptors. Verify kernel denial as well as route denial.
* Upload and process notes, Markdown, PDFs, images, attachments, and agent-created files. At every lifecycle stage, assert account UID/GID, private mode, correct category, stable record references, authenticated download, and absence of shared temporary files.
* Exercise provider streaming, changed admin defaults, running-job configuration snapshots, shared-key redaction, BYOK encryption/decryption/update/rotation, plugin installation, crash recovery, per-account event streams, and immediate active-work revocation on deletion.
* Round-trip full, chat-only, and graph-only archives between accounts with different UID/GID and Clerk identities. Validate durable workspace contents, excluded caches, included unfinished/non-regenerable work, BYOK, disabled plugins, OAuth reconnection, category dependencies/historical links, and preservation of other categories.
* Inject process crashes, full disks, interrupted uploads/snapshots/restores, bad checksums, archive bombs, malicious links, and failed worker restarts. Prove prior live data remains intact through generation-pointer/category-journal reconciliation and rollback does not become agent-readable or enter later archives.
* Claim a legacy installation with all referenced files present; repeat with each class of missing/invalid reference and prove the entire claim is blocked without partial migration or destructive source movement. Inject crashes throughout the claim journal.
* Saturate per-account and global worker, stream, provider, archive, and temporary-storage limits and verify queueing/backpressure. Verify root-owned reserve behavior and document the accepted disk-exhaustion availability risk.

### End-to-End and Compatibility Tests

* Exercise closed registration, host-authorized first-admin setup, subsequent sign-up/sign-in/sign-out, ordinary learning sessions, file library, provider settings, admin defaults, plugin management, export/import, deletion/disablement/recovery, sole-admin transfer, and reconnection using browser automation against Clerk test configuration.
* Verify private/no-store download responses, no public file URLs, no shared or personal secret material in client state/network responses, and clear replacement/passphrase/plugin/OAuth warnings.
* Run all existing chat, graph, extraction, plugin, provider, study, and payload tests. Run desktop development and packaged-payload tests without Clerk and confirm its original local single-user storage and filesystem policy.
* Run build, typecheck, lint, unit/integration suites, and the repeatable `scripts/smoke-multiuser.mjs` release scenario. Treat any skipped isolation test as release failure, not a passing result.

### Security and Resource Validation

* Require human security review of the controller/helper boundary and its protocol, including the recorded `gosu`/`setpriv` evaluation. Use compiler hardening, sanitizers/static analysis where applicable, dependency review, and fuzzing for parsers and archive handlers.
* Verify the web UID and account UIDs cannot modify application/controller/helper executables, shared-provider storage, instance keys, registry state, staging parents, or snapshots. Verify the Docker socket and host filesystem are not exposed.
* Demonstrate process-count, CPU, memory, concurrent-job, and aggregate admission limits under adversarial load. Record unsupported mandatory host controls as startup refusal. Demonstrate filesystem quotas where present; otherwise label reservation best-effort and test global-reserve behavior. Explicitly test and document that shared-provider spending quotas are not yet enforced.
* Scan logs, traces, errors, archives, browser payloads, process environments, and temporary artifacts for credential leakage. Root/host compromise is outside the protection boundary and is not represented as a defended test case.

## Non-Functional Requirements

The critical operational requirements are enforced Linux identity and private file ownership, fail-closed startup, bounded account resource use, redacted observability, and recoverable archive replacement. These requirements are specified in the Technical Plan and Testing Strategy rather than treated as optional hardening.

## Cross-Cutting Concerns

### Observability

Use operation IDs, internal account IDs, worker generations, and structured security events across web, controller, helper, worker, provider, parser, and archive operations. Metrics cover worker starts/stops, request and synchronous-store latency, active jobs, resource-limit rejections, storage use, upload failures, archive outcomes, and rollback events. Redact chat content, file contents/names where unnecessary, passphrases, provider credentials, capability tokens, IPC credentials, OAuth tokens, and archive payloads. Administrators may see aggregate operational health but not private content or personal secret values.

### Security and Privacy

Independent Clerk verification, controller-issued capabilities, Linux ownership, and descriptor-based path handling are required layers. Deny by default on identity ambiguity, registry failure, unexpected file ownership/type, stale worker generation, unsupported mandatory resource control, or malformed archive. All new APIs must be enumerated in the account-scope test so an omitted route cannot retain shared storage.

Shared-provider capabilities and personal-secret release follow least privilege and short lifetimes. The controller holds versioned instance encryption keys outside account archives; rotation re-encrypts before retirement, and loss of every required key prevents use of stored personal keys. Deployment documentation must distinguish trusted host key custody from user archives. Full-archive passphrases are not recoverable by LearnHarness or its administrator. User-installed plugins and all restored code remain trusted only after explicit owner action.

### Data Integrity and Concurrency

One fenced worker generation owns normal account mutations. Upload channels, snapshots, exports, imports, job recovery, and account deletion participate in the same lifecycle protocol. Full restore uses one durable generation pointer; category replacement and legacy claim use durable journals, same-filesystem swaps, fsync ordering, rollback copies, and startup reconciliation. Account capacity checks include live data, retained originals, durable unfinished work, rebuildable caches, snapshots, archives, staging, and rollback overhead.

### Compatibility and Rollout

Desktop behavior remains a separate supported composition root. The initial release accepts archive v1 containing current data formats understood by that build, with the existing missing-graph-sidecar v1 rule. Corrupt/missing required stamps and newer/unknown formats are rejected before mutation; older formats need explicit tested migrations. Web multi-user rollout requires a deployment checklist and cannot fall back to the old shared-storage mode. Existing single-user data is quarantined until the bootstrapped first administrator completes a journaled, non-destructive, all-or-nothing claim with every external file present and valid.

### API and UI Contracts

Keep browser responses limited to public account/file/provider metadata. File and archive downloads are authenticated streams, never public static assets. UI copy must accurately describe same-account plugin trust, sensitive full archives, passphrase loss, replace-not-merge behavior, disabled restored plugins, required OAuth reconnection, resource limits, deletion recovery timing, and the absence of scheduled backups and shared-API spending quotas. Legacy repair diagnostics expose only failure codes/counts in the UI; host operators use the CLI.

### Performance and Capacity

Workers start on demand and stop when idle; active work and export snapshots follow bounded lifecycle timeouts with clear errors. Streaming and backpressure bound memory for uploads, provider responses, events, and archives. Export quiescence covers all account writers and buffered work before snapshot creation. Initial synchronous stores can delay same-account cancellation and events; latency, store sizes, and record/archive bounds must be measured. Global and per-account resource defaults remain configurable and must be measured on the supported Docker host before documentation claims a safe account capacity.

### Documentation and Release Governance

Update architecture, Docker, security, archive, environment, and user-facing documentation in the same change as behavior. Record test commands and outcomes in the implementation PR. The controller/helper privilege transitions require human review independent of feature implementation. No production implementation, automatic backup, administrator private-data access, or merge into release branches is implied by this design document.

---

*Drafted with EGM*
