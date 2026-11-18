# A04 Phase 1 Run 3 — Progress Report

**Date:** 2026-11-15  
**Agent session:** `ses_e233666d1ffelfFxP9Xg4xI0g5`  
**Purpose:** Independently re-test Phase 1 after the human-approved Option A fixes for findings #1–#4.

## Status

Full-suite verification is **still in progress**. This is not a final gate result.

The parent recorded the subagent's completed check reports below for durable review; the subagent will write the final report at `a04-phase1-run3-report.md` after every batch finishes.

## Scope

- Non-account roots must be root-owned with mode exactly `0700`.
- Account-root permission evaluation must include the web process's supplementary groups.
- Writable mounts with the same device and source root must be refused.
- Mounted `docker.sock` and `docker.socket` must be detected.
- Previously fixed D1–D5 must remain fixed.
- Desktop/single-user behavior and desktop payload verification must remain intact.

## Completed checks reported by A04

| Check | Reported result |
| --- | --- |
| `npm run typecheck` | Pass |
| Lint | Pass; the pre-existing `tests/source-name-ui.test.tsx` warning remains |
| Focused tests | 75/75 pass |
| Real Docker probes under Node `v26.13.1` | Valid controls and refusals for #1–#4 pass |

The parent independently observed the typecheck, 75/75 focused tests, and lint before handing off to A04.

## Full suite progress

Latest verified A04 progress message: **batch 3 of 22 running**; batches 1 and 2 completed without failures. No aggregate result is claimed.

The suite is running sequentially in processes containing at most 20 test files each. Logs are under `/tmp/opencode/a04-run3/` and `/tmp/opencode/chunks/`; this report does not assert results beyond the subagent's message.

## Known constraints

- Local/CI Node-version differences must remain visible: local Node is 24.x, Docker build uses Node 26; the A04 Docker probe reported Node 26.13.1.
- `tests/study-time.test.ts`'s wall-clock assertion is accepted as host-flaky but must be checked if it is a batch's only failure.
- Findings #5–#7 are explicitly deferred/documented for A12/A13; no claim is made that this report closes them.
- No commit or push has been performed.
