# Per-User Accounts: Implementation Reference

## Primary reference for AI-assisted implementation

Use **[Per-User Accounts, Linux Ownership, and Portable Archives](../../designs/per-user-accounts.md)** as the single authoritative design reference. It contains the feature requirements, architecture, detailed phased implementation plan, milestones, testing strategy, and cross-cutting concerns.

An AI implementation session should read that document first, then inspect the files named in the active phase and the repository's existing architecture and storage ports. Implement one approved phase at a time and satisfy its resolution step before advancing. Preserve the separate desktop composition root and do not enable public multi-user mode before its security gates pass.

**Current status: In Review — not approved for implementation.** The Stage 7 re-audit has unresolved findings and Stages 8–9 have not run. Do not infer approval from this document collection, branch, commit, or push.

## Reading order for implementation

1. Read the [primary design](../../designs/per-user-accounts.md), especially the phase being implemented.
2. Check this directory's review status to ensure final human approval has been recorded.
3. Read the current source files and tests listed for that phase; the source tree is authoritative for existing code structure and exact integration points.
4. Use the review reports only to understand accepted trade-offs, resolved findings, and outstanding risks. They are not substitutes for the primary design or current code.

## Review artifacts

| File | Purpose |
| --- | --- |
| `design_draft.md` | Earlier pre-review draft; historical only and not synchronized with later remediation. |
| `zoom_out_report.md` | Stage 5 initial architectural review. |
| `comprehension_report.md` | Stage 6 fresh-reader comprehension review. |
| `critic_report_initial.md` | Initial Stage 7 design, structural, and style findings. |
| `goldfish_review_report_initial.md` | Resolution record for the 22 approved initial remediation groups. |
| `critic_report.md` | Current Stage 7 re-audit findings. |
| `goldfish_review_report.md` | Current Stage 7 resolution proposal, pending human approval. |
| `2026-11-12_DRIFT_REPORT.md` | Point-in-time comparison of the earlier design and current implementation; not a current implementation checklist. |
| `IMPLEMENTATION_PROGRESS.md` | Milestone 1 (Phases 1–2) execution ledger: delivered files, verification, deviations, and the outstanding Phase 3+ gates. |

Stages 8 and 9 have not yet produced reports. Until the primary design is marked Approved and the required gates are complete, implementation work must remain limited to investigation and planning.

**Milestone 1 implementation status:** Phases 1–2 are implemented on this branch with passing focused tests and typecheck; see [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md). The primary design document's status is unchanged: this does not mark it Approved, and Phases 3–8 have not run.
