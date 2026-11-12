# Per-User Accounts, Linux Ownership, and Portable Archives

* **Author:** PakRTsensen
* **Status:** Draft
* **Date:** 2026-11-12

---

## Overview

LearnHarness will become a multi-user web application on one Docker-hosted server. Clerk will authenticate users, and the first registered account will become the instance administrator. Each account will own its chats, knowledge graph, files, jobs, settings, and personal provider credentials. Linux user and group ownership will enforce these boundaries for files and agent processes, rather than relying only on checks in application routes.

The administrator will supply shared provider defaults, including API keys for models, search, and other supported services. Other users can use those defaults or configure their own keys. Shared keys will remain hidden from non-administrator users, while personal keys will remain private to their owner.

Users will be able to export and import a complete account archive, chats only, or graph/knowledge only. A complete archive will include personal configuration and personal provider credentials, but not the administrator's shared credentials. The application will not create scheduled backups.

## The Problem

LearnHarness currently has no user accounts. Its Docker deployment expects an external access gate and stores chats, graph ledgers, jobs, settings, plugins, and credentials in shared application data paths. Agent tools and trusted plugins run with the server's filesystem privileges. As a result, adding Clerk login without changing process identity and storage ownership would only hide data in the interface; it would not prevent one user's work from reaching another user's files.

The product needs separate ownership for every account while retaining a single Docker deployment. Authentication must identify the caller, and the operating system must enforce which files and processes that caller's work can reach. Provider defaults must be usable by many accounts without disclosing the underlying shared keys. Personal provider keys must not become shared merely because the application has an administrator.

Users also need a way to move or recover their own data. Export without import would not provide recovery or migration. The archive must therefore have a supported import path and must distinguish personal credentials, which belong in a complete archive, from shared administrator credentials, which do not.

## Goals

* Authenticate every web user with Clerk and assign the instance-administrator role to the first registered account.
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

* The supported archive versions and migration range must be established during implementation from the format versions present at that time. No archive may overwrite account data before its complete validation and migration plan succeeds.
* Exact resource-limit defaults require measurement on the supported Docker host. The first version must expose conservative, configurable limits rather than claim unlimited multi-user capacity.

## Critical User Journeys (CUJs)

### CUJ 1: First Account and Legacy Data Claim

* **Given**: A new web instance has no registered local account, and a previous single-user installation may have left a legacy data directory.
* **When**: The first person completes Clerk registration and signs in.
* **Then**: LearnHarness atomically binds that Clerk identity to the administrator account and allocates its UID/GID and private account directory. Any legacy data remains inaccessible until this administrator explicitly claims it. A second registrant can never trigger the legacy claim or become administrator through a race.

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
* **Then**: The archive contains the complete account space and personal credentials, with a manifest and format versions. Import validates the entire archive before replacing the account space. A successful restore recreates the same account content without including shared administrator keys or transferring the original Clerk identity or UID/GID.

### CUJ 5: Category-Only Restore

* **Given**: An account already contains chats and graph/knowledge data.
* **When**: The user imports a chat-only or graph/knowledge-only archive and confirms replacement.
* **Then**: Only the selected category is replaced. Other categories remain unchanged. The system stops conflicting active work and resolves category dependencies before committing the replacement; a failed validation or write leaves the previous category data available.

## Technical Plan (Architecture)

### Deployment and Trust Boundaries

The web deployment retains one Docker application container, but no longer runs all work under the shared `node` identity. A small root-owned broker is the only application component that can allocate account identities and start a process under a different UID. Next.js runs as a dedicated unprivileged web identity. Account workers run as dynamically allocated, per-account UIDs/GIDs.

The Docker socket is never mounted into the application container. The image and broker executables are root-owned and not writable by the web identity or account identities. The container uses a read-only root filesystem where compatible, drops capabilities not required by the narrowly scoped broker, and applies seccomp, resource limits, and a dedicated PID namespace. The privilege-changing path must be compatible with these controls; Docker `no-new-privileges` must not be enabled on a path that relies on setuid or file capabilities.

Root on the Docker host remains trusted. Linux ownership isolates accounts from one another and from the web process; it does not conceal data from the host operator. Desktop mode keeps its existing local, single-user launch and does not require Clerk.

### Components

```text
Browser
   |
   | Clerk session
   v
Next.js web process (unprivileged web UID)
   |-- verifies caller and resolves local account
   |-- accepts, validates, and authorizes requests
   |-- stores only the account registry and shared-instance policy
   |
   | authenticated request over a private local IPC channel
   v
Root-owned account broker
   |-- atomically allocates account UID/GID and home
   |-- verifies registry, paths, ownership, and request authority
   |-- starts/reuses the matching account worker
   |-- supplies shared secrets through a brokered capability, never account files
   |
   +--> Account A worker (UID A/GID A; home /data/accounts/A-id)
   |      chats, graph, jobs, settings, plugins, workspace, personal auth
   |
   +--> Account B worker (UID B/GID B; home /data/accounts/B-id)
          chats, graph, jobs, settings, plugins, workspace, personal auth
```

The account registry maps immutable Clerk user IDs to random internal account IDs, allocated Linux UID/GID values, lifecycle state, and the administrator role. Registry entries never use email addresses, usernames, or archive-supplied values as filesystem paths. UID/GID allocation comes from a configured non-overlapping range, is serialized by the broker, and is never reused automatically after account deletion.

The first-account transition is a single serialized registry operation. Concurrent first registrations cannot both become administrator. A Clerk webhook is not the authority for creating local privileged state: the verified, signed-in Clerk identity initiates provisioning, while verified deletion webhooks disable future access and schedule an explicit, non-immediate cleanup flow. Recreated Clerk accounts do not inherit old local state.

The broker authenticates each IPC request to the web identity and requires a short-lived, single-use request credential bound to the account, operation, and requested worker generation. It checks that the resolved account directory has the expected owner, is not a symlink, and remains beneath the fixed account root. It drops all supplementary groups, sets the account GID and UID with no saved or regained privileged identity, sanitizes the environment, and starts the worker with a fixed executable and arguments. It never accepts an executable path, UID, GID, home path, or arbitrary environment from an HTTP caller.

A worker starts on demand for an authenticated request or unfinished background work. It exits after an idle timeout; pending jobs keep it alive. The web process does not directly read account files to answer ordinary application requests. It forwards authorized operations to the account worker over the same authenticated local channel and returns only the operation's explicit response. Account responses and streams carry the account identity internally, but no bearer token is exposed to browser code, plugins, or agent tools.

### Authentication and Request Authorization

Clerk middleware protects web pages and API routes while allowing only the required sign-in, sign-up, and verified webhook endpoints to remain public. Route handlers independently resolve the authenticated server-side identity; middleware is not the only authorization check. Every API, streamed response, plugin call, export, and background-job operation derives its account from that identity, never from a client-supplied account ID.

The existing browser host and cross-site protections remain in web mode, and the desktop capability check remains in desktop mode. The new account worker replaces the web process's shared global stores for web requests. Event streams only carry notifications for the authenticated account, and reconnection repeats authorization rather than relying on the connection's original identity forever.

The administrator role authorizes shared provider settings, shared model defaults, instance policy, and resource-limit configuration only. It grants no API to read another account's content, invoke its worker, download its archive, or obtain its personal credentials.

### Account Storage and Worker Runtime

Each account receives a private home under a root-owned, non-traversable account registry root. Only the broker creates the top-level account home and sets its owner and mode. Its account data and workspace are inaccessible to the web UID and other account UIDs through ownership and mode, not through filenames kept secret.

Existing store ports remain the domain boundary inside the account worker. The existing JSON/JSONL adapters initially run unchanged within that worker, using its account-specific `LH_DATA_DIR` and `LH_AUTH_FILE`. This avoids a simultaneous database migration. Cross-process locking remains necessary because the web process, worker lifecycle, imports, and background jobs must not create competing writers for one account.

The account worker owns chats, graph operations, job recovery, event production, settings, provider resolution, themes, prompt overrides, and plugin initialization for one account. Only one active worker generation may mutate a given account at a time. Broker fencing prevents an old worker from accepting new work after restart, restore, or account disablement.

Filesystem tools in web mode use an allowlisted account workspace root, opened relative to a trusted directory descriptor. They reject absolute paths, traversal, symlinks that escape the workspace, and access through renamed directories. Account-private application records and personal credential files are outside the agent-readable workspace even though the worker UID owns them. Read-only application assets are separately mounted or opened by trusted worker startup code; the general server home and Docker host paths are unavailable to tools.

Every uploaded note, image, document, attachment, imported file, and agent-created file is written directly beneath the owning account's designated storage category. It is created with the account UID/GID and private permissions at creation time; there is no shared temporary directory, web-UID-owned intermediate file, world-readable upload, or post-upload period with different ownership. The web process streams bytes to the broker/worker through authenticated local IPC rather than writing into account storage itself.

The broker creates each incoming-file staging directory as a root-owned, non-traversable directory that the account cannot rename, replace, or read during validation. It supplies a one-operation, directory-bound upload channel. The channel creates only the declared regular file with the account UID/GID and private mode, verifies byte limits and the final descriptor's identity and ownership, and prevents links or other file types. Validation and conversion operate on that already-account-owned file descriptor. After validation, the broker moves the file atomically into the correct account-owned category, then makes it visible to the account worker. A rejected or interrupted upload is removed by the broker without entering live account data. The staging parent is never owned or writable by the account, so account code cannot replace a file while it is being checked.

Persistent note metadata and graph source records live with the account's graph records. Original imported documents live in the account's private source-file category, not only as graph excerpts. Processed learner images, generated visual assets, and attachments live in their account-owned asset categories with their referencing chat/job records. A private account file library lists original files and lets their owner download them. Downloads are streamed by the owning worker through an authenticated route after checking the file record's ownership; files never receive public static URLs. The full archive includes all of these original and derived files, while category-only archive manifests declare their required assets and record dependencies.

Worker processes receive per-account process-count, CPU, memory, disk, and concurrent-job limits. CPU and memory enforcement may require a small host-supported cgroup configuration; the deployment must fail closed or clearly refuse multi-user mode if the selected limits cannot be enforced. Disk usage uses account quotas where the filesystem supports them, with an application-enforced reservation limit as a separately documented fallback. API default spending quotas are not included in this version.

### Shared and Personal Provider Configuration

The current pattern of copying `auth.json` into `process.env` cannot cross account boundaries. In web mode, the account worker holds personal credentials only in its own protected environment and never receives the web process environment. Shared provider keys remain in an administrator-owned, broker-readable location outside every account home.

A worker that uses a shared default receives an opaque, short-lived provider capability bound to the account, provider, operation, and resolved configuration generation. A broker-side provider executor uses the shared key for the allowed provider request and returns only the provider response. It does not return the key or permit arbitrary destination URLs, arbitrary headers, file reads, or commands. Model streaming passes through this executor without logging credentials. Personal BYOK requests can execute directly within the owning worker under the same provider policy interface.

The provider resolution snapshot is attached to admitted work. Administrator changes take effect for new work only. The worker, plugins, and agent tools cannot select between reading the shared key and using its capability; only the capability is available. Usage and error records identify the account and configuration generation without containing secret values.

### Plugins and Background Work

Users install and enable their own plugins. The broker starts plugin backends only inside the owning account worker, with that account's UID/GID and workspace boundaries. Plugin installation writes are confined to the account plugin directory, and the web process never executes uploaded plugin code.

This is a boundary between accounts, not a sandbox between a user and their own plugin. A plugin can access the data made available to its owning worker and use the worker's provider capabilities according to policy. The installation interface must state this trust requirement. Plugin processes inherit account resource limits and receive neither broker IPC credentials nor shared-provider secrets.

All background-job records, delivery obligations, and recovery state remain in the owning account. Worker startup recovers only that account's unfinished jobs. The broker cannot deliver a job to another account, and restored jobs are not automatically executed until archive validation and account restore complete.

### Export, Import, and Replacement Semantics

Exports run inside the owning account worker after obtaining a consistent account snapshot. The archive is a versioned, checksummed package with a manifest that lists categories, application/source versions, data-format versions, file sizes, and supported migration requirements. Paths are relative, portable, and free of original UID/GID, Clerk subject, local account ID, and server-specific absolute paths.

A full archive includes chats, graph/knowledge, jobs as recoverable records rather than live processes, every file then present in the account workspace (including caches and temporary files), settings, prompt overrides, themes, personal API keys and provider bindings, installed plugins, and plugin data. Broker staging, old rollback copies, shared administrator credentials, shared provider policy, and personal subscription/OAuth tokens are excluded. After restore, users must reconnect subscription/OAuth services; restored configuration must not treat a missing token as an active connection. Restored plugin code and data are present, but every restored plugin is disabled until its owner explicitly reviews and enables it. Chat-only and graph/knowledge-only archives contain their declared category and a manifest describing dependencies on other categories.

Personal credentials at rest are encrypted with an instance key held by the broker outside account storage. The broker releases decrypted personal credentials only to the matching worker through its private launch channel. This encryption limits disclosure from a copied account directory or volume alone; it does not protect against the trusted host/root operator, who can also obtain the instance key.

Export briefly pauses all account work and filesystem writes, takes a consistent snapshot of the complete account space, and then resumes work while packaging that immutable snapshot. The snapshot is account-owned and excluded from subsequent archives; capacity checks must account for temporary snapshot and archive space. A full archive always requires a user-supplied passphrase and encrypts its payload, including content, file names, and manifest, using a versioned password-based authenticated-encryption format. Only a minimal format/KDF header is unencrypted. The passphrase is never persisted or logged, and a lost passphrase makes the archive unrecoverable. Chat-only and graph/knowledge-only exports may be unencrypted packages with an explicit privacy warning.

The browser receives an archive only through a fresh authenticated download authorization. Responses are marked private and no-store. The interface warns that a full archive contains personal credentials and installed code. No scheduled backup service is added.

Import uploads to a broker-created, root-locked staging directory outside the target account's live data and workspace. Individual staged files are created through the same directory-bound channel with the target account's UID/GID and private permissions; the account cannot access the staging parent or replace files during validation. Before replacement, the system rejects unsafe paths, links, special files, duplicate manifest entries, oversized expanded content, unexpected ownership requests, unsupported future versions, and checksum failures. It performs every supported migration through broker-controlled file descriptors in staging and verifies the migrated stores without opening them as live mutable stores.

For a full archive, the target account's active worker and jobs are stopped and fenced, then the live account content is replaced by the staged content. For chat-only or graph/knowledge-only imports, only the selected category is replaced. The system resolves dependent records before commit: deleting or replacing chats cannot silently leave active jobs or extraction work operating on old records, and graph replacement must retain or explicitly rebuild the relationships needed by remaining content. The confirmation screen describes exactly which categories will be lost.

Replacement uses same-filesystem atomic directory/category swaps with a temporary rollback copy owned by the target account. Any failure before commit leaves the prior content intact. A failed post-commit startup triggers restoration of the rollback copy and disables new work until recovery completes. A successful import discards the staging and rollback copies, starts a new worker generation, and requires a fresh authorization for subsequent operations.

Restore does not change the target Clerk identity, local account ID, UID/GID, administrator role, or shared-provider entitlements. Archive plugin code is not executed during validation or migration. Supported older archive formats are migrated explicitly; newer or unknown formats are rejected without modifying account data.

### Legacy Data and Rollout

At upgrade, the previous shared data/auth paths are quarantined rather than exposed through the new account resolver. The first administrator may explicitly claim them. The broker copies or moves them into that administrator's account with validated ownership and runs existing format migrations before starting the worker. Every external file referenced by legacy chats, notes, images, attachments, jobs, or plugins must first be inventoried and validated. If any referenced file is missing, inaccessible, duplicated ambiguously, or fails validation, the entire claim is blocked without a partial migration. The administrator must repair the paths and retry. Valid external files are copied into their correct account-owned categories with the administrator's UID/GID and private modes; references are updated before the worker starts. Until the claim succeeds, no account can read the legacy data.

Web multi-user mode is enabled by explicit deployment configuration and requires Clerk, the broker, private IPC, and supported resource controls to be ready. Missing or partial security configuration refuses public startup rather than silently reverting to shared-storage web mode. Desktop mode preserves the existing local composition root and data paths.

### Failure Handling and Security Evidence

The design treats cross-account access attempts, broker authentication failures, unexpected worker identity, symlink/path escapes, and unauthorized administrator actions as security-relevant events. Logs contain account IDs and operation IDs but no chat content, archive contents, or provider keys.

Release evidence must include two non-administrator accounts attempting direct and agent-mediated reads/writes against each other's data, plugin and background-job attempts to escape account boundaries, forged/expired worker requests, shared-key disclosure checks, concurrent first-registration attempts, archive traversal cases, interrupted restores, upload ownership/race checks, and web/desktop compatibility checks. A passing route-level `403` test alone is insufficient: the tests must demonstrate kernel-enforced ownership and effective process credentials.

## Alternatives Considered

### Alternative A: Clerk Authentication with Shared Application Storage

* **Pros**: Smaller change to the existing Next.js application; no account worker or Linux identity broker is required.
* **Cons**: Every agent, plugin, and store operation retains the web process's filesystem authority. A missed `userId` check can expose another account's records, and filesystem tools can reach shared server paths.
* **Reason for Rejection**: Rejected by author: login and route checks do not provide the requested Linux ownership and process-level isolation.

### Alternative B: One Container per Account

* **Pros**: Gives each account a separate process and filesystem namespace and reduces reliance on changing UID inside one container.
* **Cons**: Requires host-side orchestration and tightly controlled Docker API access. Idle containers, images, networking, upgrades, and resource accounting add operational cost. Mounting the Docker socket into the web application would create a host-level escape path.
* **Reason for Rejection**: Rejected by author: the selected deployment is one Docker container with a narrowly scoped UID broker rather than a container-orchestration control plane.

### Alternative C: Per-Worker User Namespaces in One Container

* **Pros**: Can add namespace-level separation in addition to ownership.
* **Cons**: Requires runtime and kernel support, careful UID/GID map and volume handling, and additional validation of provider networking and filesystem behavior. It is not uniformly available on supported Docker hosts.
* **Reason for Rejection**: Rejected by author: the selected broker model has fewer host prerequisites and fits the one-container deployment requirement.

### Alternative D: Move All Account Data to a Shared Database During This Change

* **Pros**: Could provide transactions and centralized record queries.
* **Cons**: A database `tenant_id` does not isolate arbitrary workspace files, plugin code, or process privileges. Rewriting every store while introducing account workers and archive formats would increase migration and rollback risk.
* **Reason for Rejection**: Rejected by author: retain the existing store ports and JSON/JSONL adapters inside isolated account workers first; a later database change must not replace OS ownership.

### Alternative E: Scheduled Server-Side Backups

* **Pros**: Could provide restore points without user action.
* **Cons**: Requires backup storage, retention policy, encryption, deletion semantics, and an administrative recovery interface. Those features can conflict with the requirement that the application administrator cannot read user archives.
* **Reason for Rejection**: Rejected by author: this version provides user-initiated export and import only, with no scheduled backups.

### Alternative F: Administrator-Installed Plugins for All Users

* **Pros**: Limits unreviewed plugin code to packages selected by the instance administrator.
* **Cons**: Does not match the requested user control over account configuration and installed extensions.
* **Reason for Rejection**: Rejected by author: each user installs their own plugins, which run as that user's UID and are explicitly trusted with that user's accessible data.

### Alternative G: Merge Imported Archives into Existing Account Data

* **Pros**: Can retain both existing and imported records.
* **Cons**: Requires conflict resolution for record IDs, settings, graph provenance, credentials, plugins, and cross-category dependencies. A partial merge can leave the account in a state that neither archive nor previous data describes.
* **Reason for Rejection**: Rejected by author: full import replaces the full account space; category-only import replaces the selected category after validation and a confirmed dependency plan.

## Detailed Implementation Plan

The phases are security gates, not independent feature slices. Public multi-user mode remains unavailable until Phases 1–5 pass their isolation tests. No phase modifies production behavior merely by detecting that Clerk variables exist; an explicit `LH_DEPLOYMENT_MODE=multiuser-web` selects the new composition root.

### Phase 1: Separate Web, Broker, and Desktop Composition Roots

**Objective**: Introduce explicit deployment modes without changing the working desktop/single-user behavior.

* **Files to Create**:
  * `src/runtime/deployment-mode.ts` — parse and validate desktop, existing single-user development, and multi-user web modes.
  * `src/runtime/multiuser-config.ts` — validate account UID/GID ranges, account root, IPC paths, resource controls, and required Clerk settings without exposing secrets.
  * `src/runtime/readiness.ts` — startup readiness and fail-closed checks.
  * `tests/deployment-mode.test.ts` — mode selection, invalid combinations, and startup refusal tests.
* **Files to Modify**:
  * `package.json` and `package-lock.json` — add the supported Clerk Next.js SDK and broker/runtime dependencies; add worker, broker, and multi-user test scripts.
  * `config.ts` — separate immutable application assets, web registry state, account roots, upload staging, snapshots, and desktop data; prevent account-controlled paths from changing the broker configuration.
  * `src/server/index.ts` — expose a request-scoped account service interface rather than requiring routes to import global mutable stores directly.
  * `src/server/stores.ts` — retain the existing adapter wiring as the single-account worker composition root; do not initialize it in the multi-user web process.
  * `instrumentation.ts` — dispatch initialization by deployment mode; remove global plugin initialization from the multi-user web process.
  * `next.config.ts` — trace the worker entry point and native broker helpers into the standalone payload; retain the multipart transport ceiling without treating it as storage validation.
  * `scripts/build-server.mjs` and `tests/desktop-payload.test.ts` — verify the additional multi-user payload while preserving the Electron payload.
  * `.env.example`, `.gitignore`, `docs/architecture.md`, and `docs/docker.md` — document modes, secret-bearing instance files, account volumes, and excluded generated artifacts.
* **Resolution Step**: On a throwaway checkout, run existing unit tests, typecheck, desktop payload tests, and the new readiness tests. Confirm that desktop mode still opens the original local stores and that multi-user web startup refuses to run with global account stores.

### Phase 2: Clerk Identity and Atomic Account Provisioning

**Objective**: Authenticate every web caller and create exactly one private Linux identity per Clerk account.

* **Files to Create**:
  * `app/sign-in/[[...sign-in]]/page.tsx`, `app/sign-up/[[...sign-up]]/page.tsx` — public Clerk authentication surfaces.
  * `app/api/webhooks/clerk/route.ts` — verified deletion/lifecycle webhook; never an administrator-creation authority.
  * `src/accounts/contracts.ts` — account records, roles, lifecycle states, internal IDs, and registry version contracts.
  * `src/accounts/clerk-identity.ts` — server-side Clerk identity resolution with no client-supplied identity trust.
  * `src/accounts/registry.ts` — serialized first-admin assignment, UID/GID allocation, lookup, disablement, and non-reuse ledger.
  * `src/accounts/provisioning.ts` — authenticated provisioning and legacy-claim eligibility.
  * `src/accounts/request-context.ts` — request-bound account context used by all route adapters.
  * `src/broker/protocol.ts` — versioned discriminated IPC messages, operation limits, stream framing, and error contracts.
  * `tests/account-registry.test.ts`, `tests/clerk-auth.test.ts`, and `tests/account-provisioning.test.ts`.
* **Files to Modify**:
  * `proxy.ts` — add Clerk route protection and explicit public routes while retaining host and cross-site defenses; preserve the desktop capability branch.
  * `app/layout.tsx`, `components/sidebar.tsx`, and the home/chat server-component entry points — obtain theme/bootstrap data through the authenticated account request rather than global stores; do not expose private Clerk metadata.
  * `components/settings/settings-dialog.tsx` — add sign-out/account status and make settings requests account-scoped.
  * `docs/architecture.md` — document Clerk subject to internal account mapping and first-admin serialization.
* **Resolution Step**: Test open registration, concurrent first registrations, signed-out denial, webhook forgery/deletion, recreated Clerk identities, UID/GID non-reuse, and desktop requests without Clerk. Inspect `/proc` and filesystem metadata in integration fixtures to prove the provisioned identity rather than only checking registry JSON.

### Phase 3: Root Broker and On-Demand Account Workers

**Objective**: Move all account execution out of the web UID and enforce process/filesystem identity at the kernel boundary.

* **Files to Create**:
  * `broker/` — a minimal, memory-safe privilege-boundary helper for descriptor-based directory creation, ownership changes, UID/GID dropping, and fixed-executable launch; keep protocol parsing outside this helper wherever possible.
  * `src/broker/main.ts` — authenticated local IPC service and fixed request dispatcher.
  * `src/broker/identity.ts` — registry verification, UID/GID allocation handoff, group removal, and post-exec identity assertions.
  * `src/broker/paths.ts` — descriptor-relative path resolution, no-link traversal, ownership checks, and same-filesystem rename primitives.
  * `src/broker/worker-manager.ts` — on-demand start, idle stop, single-generation fencing, restart, and shutdown.
  * `src/broker/ipc-server.ts` and `src/server/account-client.ts` — private stream transport with bounded messages, cancellation, backpressure, and peer-credential verification.
  * `src/worker/main.ts` — sanitized account-worker entry point with fixed application root and account-only `LH_DATA_DIR`/`LH_AUTH_FILE`.
  * `src/worker/service.ts` — account-local chat, graph, settings, files, provider, plugin, job, and archive request dispatcher.
  * `src/worker/resources.ts` — process/job admission and cgroup/resource-limit integration.
  * `tests/broker-protocol.test.ts`, `tests/broker-paths.test.ts`, `tests/worker-lifecycle.test.ts`, and `tests/multiuser-isolation.test.ts`.
* **Files to Modify**:
  * `Dockerfile` — install the root-owned broker/helper and worker payload with non-writable permissions; retain an unprivileged Next.js identity.
  * `docker-entrypoint.sh` — start the broker under its narrowly controlled root path and Next.js under the web UID; stop recursively `chown`ing all `/data` to `node`.
  * `docker-compose.yml` — configure separate registry/account/staging/instance-key locations, IPC, read-only image filesystem where supported, PID/resource controls, and required security options; never mount the Docker socket.
  * `scripts/build-server.mjs` — include and smoke-test worker and broker entry points.
  * `src/server/index.ts` and every `app/api/**/route.ts` — route authenticated operations through the account client; no direct global account-store reads or writes remain in multi-user mode.
* **Resolution Step**: In the real Docker image, create two accounts and inspect real/effective/saved UID/GID and supplementary groups. Attempt cross-home traversal, symlink/hardlink attacks, forged IPC, worker-generation reuse, arbitrary executable/environment injection, and access after account disablement. Verify idle shutdown, active-job retention, crash cleanup, restart recovery, and unchanged desktop execution.

### Phase 4: Account-Owned Files, Notes, Images, and Library

**Objective**: Ensure every user file enters the correct account category with the correct UID/GID from creation and remains privately downloadable.

* **Files to Create**:
  * `src/files/contracts.ts` — file IDs, category, owning record, original name, media type, size, digest, lifecycle, and archive inclusion metadata.
  * `src/files/store.ts` — account-local file metadata and reference tracking.
  * `src/broker/upload-channel.ts` — root-locked staging parent, one-file directory-bound channel, account-owned descriptor creation, byte/disk limits, and atomic promotion.
  * `src/files/library.ts` — list/read/download/delete operations through the owning worker.
  * `src/files/validation.ts` — regular-file, content, image/PDF/document, size, and decompression checks separated from storage placement.
  * `app/api/files/route.ts` and `app/api/files/[id]/route.ts` — authenticated private library and streaming downloads with private/no-store responses.
  * `components/file-library.tsx` — original-file list, metadata, download, and safe error states.
  * `tests/upload-ownership.test.ts`, `tests/file-library.test.ts`, and `tests/upload-races.test.ts`.
* **Files to Modify**:
  * `app/api/graph/import/route.ts` — stream each multipart file into its broker channel; persist the original before extraction, associate source metadata, and avoid shared temporary files.
  * `app/api/graph/sources/route.ts` and source-deletion flows — include original-file metadata and explicit reference/deletion semantics.
  * `src/server/submission-images.ts`, `app/api/chats/[id]/images/[snapshotId]/route.ts`, `src/agent/tools/learner-image.ts`, and `src/agent/image-processing/**` — keep original and processed images in account-owned categories and associate them with chat/job records.
  * `src/agent/subagents/pdf-ops.ts` and related converters — replace OS/shared temp paths with broker-issued account-owned processing descriptors; cleanup never removes the retained original.
  * `src/agent/tools/fs-shared.ts`, `src/agent/tools/file-access.ts`, and `src/server/file-access.ts` — use only the account workspace root in web mode; retain local policy behavior in desktop mode.
  * `src/server/chats.ts`, `src/server/graph.ts`, `src/server/source-organization.ts`, `src/server/source-deletion.ts`, `src/store/chats.ts`, `src/store/graph.ts`, and `src/core/contracts.ts` — add stable file references and preserve provenance across record operations.
  * `components/attach-files-button.tsx`, `components/notes-import-queue.ts`, `components/artifacts/**`, and relevant chat/file UI — use private file records and download routes rather than public paths.
  * `lib/notes-import-limits.ts` and `next.config.ts` — keep transport, expanded-content, per-file, per-operation, and account-disk limits consistent.
* **Resolution Step**: Upload notes, Markdown, PDFs, images, attachments, and mixed batches as two users. At creation, validation, conversion, promotion, processing, download, and restart, verify owner/group/mode/category and the absence of shared or web-UID temporary artifacts. Race malicious account code against validation; test links, special files, oversized bodies, interrupted streams, missing files, cross-account IDs, and public URL access. Export and re-import every file type before completion.

### Phase 5: Provider Secrets, Shared Defaults, and Account Plugins

**Objective**: Support shared provider use and BYOK without disclosing shared keys or moving global plugins/secrets into the web process.

* **Files to Create**:
  * `src/providers/policy.ts` — resolved provider configuration, generation, shared/BYOK selection, allowlisted operations, and redacted public metadata.
  * `src/providers/shared-executor.ts` — broker-side fixed-provider request execution using opaque capabilities; block arbitrary URLs, headers, commands, and file access.
  * `src/providers/capabilities.ts` — short-lived account/provider/operation/generation bindings and streaming cancellation.
  * `src/providers/personal-secrets.ts` — versioned authenticated encryption using the broker-held instance key and release only to the owning worker.
  * `src/broker/shared-settings.ts` — administrator-only shared defaults and key writes through broker IPC.
  * `app/api/admin/providers/route.ts` and `app/api/admin/providers/[id]/route.ts` — administrator management with no private-account APIs.
  * `components/settings/admin-providers.tsx` and `components/settings/account-providers.tsx` — separate shared-default selection from personal-secret management.
  * `tests/provider-isolation.test.ts` and `tests/plugin-account-isolation.test.ts`.
* **Files to Modify**:
  * `src/server/keys.ts`, `src/store/auth.ts`, `src/server/custom-provider*.ts`, `src/server/model-catalog.ts`, `src/server/search.ts`, `src/server/web-subscriptions*.ts`, `app/api/keys/**`, `app/api/models/route.ts`, `app/api/search/route.ts`, `app/api/custom-provider/route.ts`, and `app/api/stt/token/route.ts` — replace shared `process.env` mutation with request/job-scoped provider policy; distinguish personal API keys from excluded OAuth/subscription tokens.
  * `src/models.ts`, agent/provider call sites, and streaming consumers — execute through resolved shared capability or personal BYOK policy without logging secrets.
  * `src/server/plugins.ts`, `src/server/plugin-host.ts`, `src/server/plugin-*.ts`, `src/agent/plugin-*.ts`, `src/store/plugin-*.ts`, and `app/api/plugins/**` — initialize/install/run only within the owning worker; remove web-process plugin initialization and shared event/job registries.
  * `src/core/events.ts`, `src/server/events-stream.ts`, `app/api/events/route.ts`, and `app/api/activity/**` — scope subscriptions and job delivery to an authenticated worker/account stream.
  * `components/plugins.tsx`, `components/plugin-renderers.tsx`, and plugin management UI — explain same-account trust and expose restored-disabled state.
* **Resolution Step**: Verify shared keys never appear in browser responses, account files, worker/plugin environments, archives, errors, or logs. Confirm admin defaults affect only new work, personal secrets decrypt only in the owning worker, admin APIs cannot invoke/read other accounts, user plugins run under the correct UID, and OAuth/subscription connections are never exported.

### Phase 6: Versioned Archives and Atomic Replacement

**Objective**: Implement complete and category-only portability with validation, rollback, encryption, and disabled restored plugins.

* **Files to Create**:
  * `src/archive/contracts.ts` — archive kind, manifest, source/application/data versions, categories, dependencies, checksums, and migration declarations.
  * `src/archive/snapshot.ts` — account work/write pause, consistent complete-space snapshot, resume, and capacity enforcement.
  * `src/archive/export.ts` — full/chat/graph export, complete-workspace inclusion, dependency manifests, and streaming.
  * `src/archive/encryption.ts` — versioned passphrase-based authenticated encryption for the complete full-archive payload; no persisted passphrase.
  * `src/archive/validate.ts` — package limits, paths, links, duplicates, checksums, versions, and non-executing plugin inspection.
  * `src/archive/migrations.ts` — explicit supported-version migration registry and rejection of newer/unknown formats.
  * `src/archive/import.ts` — root-locked staging, account-owned files, dependency plan, worker fencing, atomic category/account replacement, rollback, and restart.
  * `app/api/account/export/route.ts` and `app/api/account/import/route.ts` — fresh authorization, passphrase transport handling, replacement confirmation, and private/no-store streaming.
  * `components/settings/account-archive.tsx` — export choices, passphrase confirmation, sensitive-data warning, exact replacement summary, restore/reconnect/re-enable instructions.
  * `tests/archive-roundtrip.test.ts`, `tests/archive-security.test.ts`, `tests/archive-restore-rollback.test.ts`, and `tests/archive-migrations.test.ts`.
* **Files to Modify**:
  * `src/store/**` and data-format version modules — expose read-only verification and explicit migrations without opening staged data as live stores.
  * `src/server/jobs.ts`, `src/store/jobs.ts`, plugin job records, and worker recovery — pause/fence active work and serialize only recoverable records; never auto-run restored jobs before restore completion.
  * `src/files/store.ts` and chat/graph/source modules — preserve original/derived assets and resolve category dependencies before commit.
  * `src/server/study.ts`, `src/store/study.ts`, themes, render settings, prompt overrides, source organization, and settings stores — include all account categories in full export while leaving them unchanged during category-only replacement.
  * `docs/architecture.md` and `docs/docker.md` — document archive sensitivity, passphrase loss, no scheduled backups, replacement semantics, and rollback storage.
* **Resolution Step**: Round-trip every export kind across supported versions and different target UID/Clerk IDs. Verify full replacement, category-only replacement, unchanged non-target categories, all workspace/cache/temp files, BYOK restoration, OAuth reconnection requirement, and disabled plugins. Test wrong/lost passphrase, tampering, traversal, future versions, full disks, interrupted swaps, failed worker restart, and rollback. Verify staging/snapshot/rollback data is excluded from later archives.

### Phase 7: Legacy Claim, Resource Controls, and Full Route Migration

**Objective**: Complete the migration of every feature and quarantine legacy data until the first administrator claims a fully valid dataset.

* **Files to Create**:
  * `src/legacy/inventory.ts` — enumerate legacy records and all external file references before changing anything.
  * `src/legacy/claim.ts` — all-or-nothing administrator claim, validated copy, ownership assignment, reference rewrite, and format migration.
  * `app/api/account/legacy-claim/route.ts` and `components/settings/legacy-claim.tsx` — explicit first-admin action and non-content-bearing diagnostics.
  * `tests/legacy-claim.test.ts` and `tests/all-routes-account-scope.test.ts`.
* **Files to Modify**:
  * All remaining `app/api/**/route.ts`, server services, and server components not converted above, including chats, side chats, Claude Code, study, graph costs/coverage/status/positions/render settings, plugin documents/assets, subscriptions, and settings.
  * `src/worker/resources.ts`, `docker-compose.yml`, and broker launch code — enforce configured process, CPU, memory, disk, and concurrent-job limits; make unsupported enforcement fail closed for public multi-user mode.
  * `docs/docker.md`, `.env.example`, and deployment troubleshooting — document cgroups/filesystem prerequisites, capacity, no API-default spending quotas, and recovery.
* **Resolution Step**: Assert there are no multi-user imports of shared account stores or unrestricted server-home file policies. Test legacy claims with complete and missing/ambiguous/invalid external files; any defect blocks the entire claim without partial migration. Run two-account load tests to demonstrate resource enforcement, then run the complete existing test suite and desktop compatibility suite.

### Phase 8: User Experience, Documentation, and Release Evidence

**Objective**: Make account/security behavior understandable and produce reproducible evidence for the release gate.

* **Files to Create**:
  * `docs/multiuser-security.md` — trust boundaries, broker contract, Linux evidence, plugin limits, encryption, incident handling, and known limits.
  * `docs/account-archives.md` — archive contents/exclusions, encryption, replacement, supported versions, OAuth reconnection, and plugin reactivation.
  * `scripts/smoke-multiuser.mjs` — repeatable two-account Docker integration scenario.
* **Files to Modify**:
  * `README.md`, `docs/architecture.md`, `docs/docker.md`, `.env.example`, and relevant settings/help UI — align actual behavior and requirements; remove claims that authentication alone supplies isolation.
* **Resolution Step**: Execute build, typecheck, lint, unit/integration tests, Docker isolation tests, archive round trips, failure injection, and desktop payload tests. Record the exact commands and outcomes in the PR. Do not declare multi-user support if any account route still uses global storage or any agent/plugin can traverse another account.

## Milestones

### Milestone 1 — Deployment Skeleton and Account Registry

Complete Phases 1–2. Deliver explicit modes, Clerk authentication, first-admin/open-registration behavior, account registry, private provisioning, and passing auth/registry tests. Multi-user learning routes remain disabled until worker isolation lands.

### Milestone 2 — Kernel-Enforced Account Runtime

Complete Phase 3. Deliver the broker, on-demand workers, route transport, Docker identity model, resource groundwork, and real UID/GID/filesystem isolation evidence for two accounts.

### Milestone 3 — Private Files and Provider/Plugin Separation

Complete Phases 4–5. Deliver account-owned note/document/image/attachment flows, private file library, shared-key broker execution, encrypted BYOK, per-account plugins/events/jobs, and their security tests.

### Milestone 4 — Portable Recovery and Complete Migration

Complete Phases 6–7. Deliver all export/import kinds, encrypted full archives, atomic replacement/rollback, version migrations, disabled restored plugins, all-or-nothing legacy claim, resource limits, and conversion of every route.

### Milestone 5 — Release Candidate

Complete Phase 8. Deliver documentation, repeatable Docker security evidence, full regression/typecheck/lint/build results, and explicit known limitations. Merge readiness requires human review of the broker and a clean security/isolation test run; this design approval is not approval to implement or merge production changes.

## Testing Strategy

### Unit Tests

* **Deployment and registry**: Parse valid/invalid modes; verify fail-closed configuration, first-admin atomicity, open registration, lifecycle transitions, UID/GID range exhaustion, non-reuse, and deletion/recreation behavior.
* **Broker protocol**: Test message versioning, size bounds, malformed frames, cancellation, backpressure, operation allowlists, request expiry/single use, and generation fencing with property-based/fuzz inputs.
* **Descriptor paths and uploads**: Test traversal, absolute paths, links, renamed directories, special files, ownership/mode at creation, byte and expanded-size limits, interrupted streams, atomic promotion, and cleanup. Cover every file category and archive staging path.
* **Provider policy**: Test shared/BYOK resolution, generation snapshots, capability scope/expiry, destination/header allowlists, personal-secret encryption, redaction, and OAuth/subscription exclusion.
* **Archive format**: Test manifests, dependency resolution, version migrations, passphrase encryption/authentication, wrong passphrases, tampering, unsupported versions, replacement planning, and rollback state transitions.
* **Account files and stores**: Test original/derived-file references, downloads, deletion, graph/chat dependencies, plugin restored-disabled state, and preservation of untouched categories.

Run these through the existing `npm test` structure, with new focused scripts for native broker and integration suites. Ordinary mocks may test control flow but cannot satisfy the Linux isolation gate.

### Integration Tests

* Run the real Docker image with two non-administrator accounts and the first administrator. Inspect real/effective/saved UIDs, GIDs, supplementary groups, process ancestry, cgroups, file ownership, and permission modes.
* Attempt direct, chat-mediated, agent-mediated, plugin-mediated, and background-job access to another account's records, credentials, workspace, archive, IPC endpoint, and file descriptors. Verify kernel denial as well as route denial.
* Upload and process notes, Markdown, PDFs, images, attachments, and agent-created files. At every lifecycle stage, assert account UID/GID, private mode, correct category, stable record references, authenticated download, and absence of shared temporary files.
* Exercise provider streaming, changed admin defaults, running-job configuration snapshots, shared-key redaction, BYOK encryption/decryption, plugin installation, crash recovery, and per-account event streams.
* Round-trip full, chat-only, and graph-only archives between accounts with different UID/GID and Clerk identities. Validate all workspace contents, BYOK, disabled plugins, OAuth reconnection, category replacement, and preservation of other categories.
* Inject process crashes, full disks, interrupted uploads/snapshots/restores, bad checksums, archive bombs, malicious links, and failed worker restarts. Prove prior live data remains intact and rollback does not become agent-readable or enter later archives.
* Claim a legacy installation with all referenced files present; repeat with each class of missing/invalid reference and prove the entire claim is blocked without partial migration.

### End-to-End and Compatibility Tests

* Exercise sign-up/sign-in/sign-out, first-admin setup, ordinary learning sessions, file library, provider settings, admin defaults, plugin management, export/import, deletion/disablement, and reconnection using browser automation against Clerk test configuration.
* Verify private/no-store download responses, no public file URLs, no shared or personal secret material in client state/network responses, and clear replacement/passphrase/plugin/OAuth warnings.
* Run all existing chat, graph, extraction, plugin, provider, study, and payload tests. Run desktop development and packaged-payload tests without Clerk and confirm its original local single-user storage and filesystem policy.
* Run build, typecheck, lint, unit/integration suites, and the repeatable `scripts/smoke-multiuser.mjs` release scenario. Treat any skipped isolation test as release failure, not a passing result.

### Security and Resource Validation

* Require human security review of the broker/helper and its protocol. Use compiler hardening, sanitizers/static analysis where applicable, dependency review, and fuzzing for parsers and archive handlers.
* Verify the web UID and account UIDs cannot modify application/broker executables, shared-provider storage, instance keys, registry state, or staging parents. Verify the Docker socket and host filesystem are not exposed.
* Demonstrate process-count, CPU, memory, disk, and concurrent-job limits under adversarial load. Record unsupported host configurations as startup refusal. Explicitly test and document that shared-provider spending quotas are not yet enforced.
* Scan logs, traces, errors, archives, browser payloads, process environments, and temporary artifacts for credential leakage. Root/host compromise is outside the protection boundary and is not represented as a defended test case.

## Cross-Cutting Concerns

### Observability

Use operation IDs, internal account IDs, worker generations, and structured security events across web, broker, worker, provider, and archive operations. Metrics cover worker starts/stops, request latency, active jobs, resource-limit rejections, storage use, upload failures, archive outcomes, and rollback events. Redact chat content, file contents/names where unnecessary, passphrases, provider credentials, capability tokens, IPC credentials, OAuth tokens, and archive payloads. Administrators may see aggregate operational health but not private content or personal secret values.

### Security and Privacy

Authentication, application authorization, Linux ownership, and descriptor-based path handling are independent required layers. Deny by default on identity ambiguity, registry failure, unexpected file ownership/type, stale worker generation, unsupported resource control, or malformed archive. All new APIs must be enumerated in the account-scope test so an omitted route cannot silently retain shared storage.

Shared-provider capabilities and personal-secret release follow least privilege and short lifetimes. The instance encryption key is broker-held and outside account archives; its loss prevents use of stored personal keys, so deployment documentation must distinguish trusted host key custody from user archives. Full-archive passphrases are not recoverable by LearnHarness or its administrator. User-installed plugins and all restored code remain trusted only after explicit owner action.

### Data Integrity and Concurrency

One fenced worker generation owns normal account mutations. Upload channels, snapshots, exports, imports, job recovery, and account deletion participate in the same lifecycle protocol. Atomic writes alone are insufficient: cross-category replacement needs an explicit dependency plan, same-filesystem swaps, durable commit markers, rollback copies, and recovery after abrupt termination. Account capacity checks include live data, retained originals, workspace caches, snapshots, archives, staging, and rollback overhead.

### Compatibility and Rollout

Desktop behavior remains a separate supported composition root. Archive and store migrations are explicit and tested; newer/unknown formats are rejected before mutation. Web multi-user rollout requires a deployment checklist and cannot silently fall back to the old shared-storage mode. Existing single-user data is quarantined until the first administrator completes an all-or-nothing claim with every external file present and valid.

### API and UI Contracts

Keep browser responses limited to public account/file/provider metadata. File and archive downloads are authenticated streams, never public static assets. UI copy must accurately describe same-account plugin trust, sensitive full archives, passphrase loss, replace-not-merge behavior, disabled restored plugins, required OAuth reconnection, resource limits, and the absence of scheduled backups and shared-API spending quotas.

### Performance and Capacity

Workers start on demand and stop when idle; active work and export snapshots follow bounded lifecycle timeouts with clear errors. Streaming and backpressure bound memory for uploads, provider responses, events, and archives. Snapshot pauses should be as short as practical while preserving consistency. Initial resource defaults remain configurable and must be measured on the supported Docker host before documentation claims a safe account capacity.

### Documentation and Release Governance

Update architecture, Docker, security, archive, environment, and user-facing documentation in the same change as behavior. Record test commands and outcomes in the implementation PR. The broker and privilege transitions require human review independent of feature implementation. No production implementation, automatic backup, administrator private-data access, or merge into release branches is implied by this design document.
