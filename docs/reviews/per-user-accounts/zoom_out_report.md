# Stage 5: Initial Zoom Out Review

* **Target**: `docs/designs/per-user-accounts.md`
* **Scope**: Full document
* **Reviewers**: `egm-zoom-out`, `egm-inventive-catalyst`
* **Status**: Complete; findings require resolution or explicit acceptance

## Skeptical Architect Findings

### ZO-1 — Major: The root broker has too many responsibilities

**Affected scope**: Deployment and Trust Boundaries; Components; upload handling; provider execution; credential release; archive migration; legacy claim; Phases 3–6.

The proposed small root-owned broker also handles IPC parsing, registry verification, worker lifecycle, upload channels, shared-provider streaming, personal-secret decryption, archive migration, and legacy import. This creates a large privileged application service. Complex provider responses and archive formats would be processed inside the highest-privilege application component.

Restrict the privileged helper to identity changes, ownership assignment, descriptor issuance, and atomic namespace operations. Provider execution and complex validation/migration should run in non-root services or workers using broker-issued descriptors and capabilities. The root helper should not parse provider traffic or archive formats.

### ZO-2 — Major: Registry ownership is contradictory

**Affected scope**: Component diagram; registry/provisioning; account storage; Phase 2; Security and Privacy.

The component diagram says the web process stores the account registry, while the security section says the web UID cannot modify registry state. The broker also verifies the registry and serializes UID allocation. The authoritative writer and locking model are unclear.

Name one authoritative owner. The reviewer suggests a broker-owned registry, with the web process requesting provisioning/disablement and receiving only required projections. If web persistence is intended instead, remove the contradictory requirement and define independent broker verification.

### ZO-3 — Major: Evaluate existing privilege-drop tools before a native helper

**Affected scope**: Phase 3; existing Dockerfile and entrypoint.

The design proposes a new native helper for UID/GID dropping and fixed-executable launch even though the image already ships `gosu`. Reimplementing identity transitions increases security-sensitive code.

Evaluate `gosu`, or `setpriv` where clearer group/no-new-privileges controls are needed, for sanitized fixed-executable worker launch. Limit any new native helper to operations those tools cannot provide, particularly descriptor-relative no-link filesystem operations. Record this evaluation before commissioning a new privilege-boundary executable.

### ZO-4 — Major: File metadata bypasses the existing storage-port pattern

**Affected scope**: Phase 4 file metadata and store modifications.

`src/files/store.ts` introduces persistent metadata outside the established entity-port, filesystem-adapter, and composition-root architecture.

Add a semantic `FileStore` port to `src/core/ports.ts`, place its filesystem adapter under `src/store/`, and wire it through the account-worker composition root. Keep the file library as the service coordinating records and downloads.

### ZO-5 — Major: Archiving every cache and temporary file increases cost and restore risk

**Affected scope**: Full archive contents; Phase 6; integration tests; capacity requirements.

Including every workspace cache and temporary file increases snapshot pause time, archive size, disk reservations, validation surface, and the chance of restoring stale transient state.

The reviewer suggests archiving durable user content, required original/derived assets, settings, credentials, and plugins, while excluding reproducible caches and transient files and recording regeneration requirements in the manifest. This conflicts with the author's explicit selection of every file in the workspace; it cannot be changed without a new author decision.

### ZO-6 — Nit: Cross-process locking needs a named second writer

**Affected scope**: Store reuse/concurrency; import fencing; Data Integrity and Concurrency.

The design requests cross-process locking while also establishing one fenced worker, no direct web account-store access, staged imports, and worker shutdown during replacement.

State that generation fencing and restore exclusion provide coordination. Add store-level locking only for a specifically identified concurrent writer that fencing cannot exclude.

### ZO-7 — Nit: Compose existing file validation instead of duplicating it

**Affected scope**: New file validation module; graph import, image, and PDF modifications.

A new validation module could duplicate existing graph-import checks, image bounds/postprocessing, and PDF lifecycle rules.

Define the module as extraction and composition of existing validators and converters. Reuse `lib/notes-import-limits.ts`, shared image processing, and the existing PDF converter rather than recreating content and cleanup rules.

### Architect's other observations

* Per-account workers with kernel-enforced identity address the stated root problem.
* Retaining JSON/JSONL formats avoids a simultaneous database migration.
* No separate anti-weeds finding: low-level rules generally express security and recovery invariants.
* Existing agent-layer `realSourcePath`/`guardSourcePath` helpers are not substitutes for descriptor-relative broker operations against hostile concurrent filesystem changes.

## Inventive Catalyst Findings

### IC-1 — Major: Unchanged synchronous stores can block an account worker

**Affected scope**: Account Storage and Worker Runtime, especially unchanged JSON/JSONL adapters.

The existing synchronous filesystem adapters can block the account event loop during large graph or archive-related storage operations, delaying unrelated requests, cancellation, and event delivery. Avoiding a database migration does not require retaining that execution model.

The reviewer proposes preserving JSON/JSONL formats and fenced single-writer ownership while placing storage behind an account-local asynchronous storage worker or worker thread with bounded queues, cancellation, and backpressure.

**Secondary liabilities**: Asynchronous port/call-site changes, thread/IPC serialization, queue management, lifecycle/error handling, and extra per-account resources. This does not itself provide cross-file transactions or crash atomicity.

### IC-2 — Major: Shared-provider execution should not share the root broker's failure domain

**Affected scope**: Deployment, Components, Shared/Personal Provider Configuration, and Phase 5.

Placing provider traffic, TLS/network handling, untrusted responses, and streaming inside the root broker expands its attack surface and creates a central availability bottleneck. Shared-key concealment does not require provider execution to run as root.

The reviewer proposes a separate unprivileged provider-executor identity inaccessible to account workers/plugins. Only that service can read shared provider keys. The root broker delegates narrowly authorized, capability-bound requests; the executor enforces protocol limits, streaming backpressure, and per-account admission/resource accounting.

**Secondary liabilities**: Another authenticated IPC hop and separately deployed, monitored secret-bearing service; independent rotation, capability validation, availability, and resource isolation. The executor remains a high-value target, but its compromise no longer inherently compromises the root privilege broker.

## Consolidated Assessment

* **Blockers**: 0
* **Major findings**: 7 (ZO-1 through ZO-5, IC-1, IC-2)
* **Nits**: 2

ZO-1 and IC-2 both require separating complex/network work from the privileged helper. ZO-2 is an internal document contradiction requiring correction. ZO-3, ZO-4, ZO-6, and ZO-7 request architectural-fit clarifications or reuse decisions. ZO-5 challenges an explicit product decision and must not be applied silently. IC-1 adds a new asynchronous execution model whose cost and necessity require evaluation rather than automatic adoption.
