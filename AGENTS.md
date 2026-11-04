<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.** If anything is ambiguous — naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording — STOP and ask with the ask-user-question tool before proceeding. If you are "a little unsure," you are unsure: ask. A wrong guess is far more expensive than a question. Ask early, ask specific, one question per call.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement. Implementation should be mechanical execution of an approved plan — not interpretation.

## LearnHarness — repo-specific facts (keep short; detail lives in `docs/codebase-map.md`)

- Canonical design spec: `docs/architecture.md`. This file and the repo docs are subordinate to it for architecture/flows.
- Full file-by-file map, execution flows, data invariants, stale-comment findings and coverage boundaries: `docs/codebase-map.md` (must track the 695-path baseline at the pinned HEAD).
- Import law (enforced in `eslint.config.mjs:38-68`, not just documented): `components/**` → `@/src/core` only; `app/**` → `@/src/core` + `@/src/server` only; `src/core/**` never imports agent/server/store; `src/agent/**` never imports server/store.
- Layer responsibilities: pure domain in `src/core`; pi-ai agents/tools in `src/agent`; composition/transport in `src/server`; filesystem adapters in `src/store`; Next routes in `app`; client UI in `components`; desktop in `electron` (plain CJS, outside the law).
- Data seam: `config.ts`; `LH_DATA_DIR` relocates mutable data (settings/auth/study/chat/graph/jobs), read-only prompts stay ROOT-anchored. Graph = append-only JSONL + `format.json`; chats = one JSON file per chat, lazy v1 stamp; settings/prompt/auth/study are read-modify-write JSON.
- Turn protocol: `POST /api/chat` takes `{chatId, input}` (one event); writes user turn durably then runs a background turn; streams via `GET /api/chats/[id]/stream`; abort via `POST /api/activity/abort`; dismissals may park (`202`) while a turn is live and apply at settle.
- Graph writer: the extraction pipeline (propositions + chains) is the sole writer; canvas/clusters/practice are derived; deletion via `core/graph-deletion.ts` (preserve vs full).
- Desktop API: private capability header (`x-learnharness-desktop`, timing-safe, ≥64-char secret) enforced by global `proxy.ts` + `src/server/desktop-access.ts`; browser-only/dev mode is open when no secret is configured; no user-auth layer exists on `/api` routes.
- Tests: `NODE_ENV=test tsx --test tests/*.test.ts tests/*.test.tsx`. Isolation is mixed — several suites write the repo-default `data/`; `graph.test.ts` renames real ledgers to `.w5test.bak`.
- Known stale comments/contract mismatches live in `docs/codebase-map.md` §7; runtime behaviour of third-party packages is out of scope for audits here.

Before any design/implementation decision: stop and ask (see No guessing above).
