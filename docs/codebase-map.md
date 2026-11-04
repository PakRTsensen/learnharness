# LearnHarness — codebase map

Status: **static map of every tracked path** at commit `6356d735351e243782d212e75e1217ede1118859` (branch `exp-0.4.1`, package version 0.4.0).

Companions: [`architecture.md`](architecture.md) is the canonical design spec; [`development.md`](development.md) covers commands and environment; [`vision.md`](vision.md) covers product reasoning. This file is the working, file-by-file map: what each path is for, how the runtime pieces connect, where failure is contained, and which claims are code-backed versus comment-only.

## How this map was produced

Every tracked text file was read through its last line in a dedicated read-only audit, in chunks, with its Git blob ID and Python `splitlines()` line count recorded. Binary assets were classified and inspected as assets, never line-covered. The audit evidence lives outside the repository (coverage TSVs and reports under `/tmp/opencode/learnharness-audit/`); [§8](#8-verification-and-coverage-boundaries) summarizes the reconciliation.

No application code was executed, no provider was called, and no test or build was run for this map. Statements below describe executable code or TypeScript contracts as read. Where a comment claims behavior the code does not enforce, the code wins; the main mismatches are collected in [§7](#7-known-stale-comments-and-contract-mismatches). Third-party runtime behavior (Next.js, React, pi-ai, Electron, pdfjs, Photon, Puppeteer) is described only at the boundary this repository calls.

---

## 1. What the system is

LearnHarness is a standalone learning app — a Next.js web app plus an Electron desktop shell — in which a teacher agent runs probe→teach lessons, authors a formal plan tree, asks graded questions, and accumulates what the learner knows into one persistent cross-session knowledge graph. The graph is the home page; a session is the classroom. Practice turns graph propositions and chains into self-contained problem sets; background sub-agents research, build demos, and draw SVGs; an extraction pipeline is the sole writer of graph epistemology.

Three data planes:

1. **Conversation plane** — `data/chats/<chatId>.json` holds native pi messages, plan tree, usage, settings overrides and extraction logs. The server runs a turn as a background object; HTTP POST starts it and returns, while SSE streams/reattaches.
2. **Knowledge plane** — `data/graph/` holds append-only JSONL ledgers (`nodes`, `chains`, `sessions`, `coverage`), `sources.json`, `positions.json`, `render-settings.json`, and a `format.json` stamp. The stored truth is propositions + joint-premise reasoning chains; the canvas is a derived projection.
3. **Operational plane** — `data/jobs/`, `data/study/`, `data/settings.json`, `data/prompts/`, and the credential file (`auth.json` or `.env.local`). The desktop shell relocates all mutable data via `LH_DATA_DIR`; read-only prompts stay anchored to the app bundle.

---

## 2. Layers and the import law

| Layer | Directory | Responsibility | May import from `src/` |
|---|---|---|---|
| Pure domain | `src/core/**` | Contracts, ports, projections, validation, geometry, pricing math, settings resolution, compaction cuts, study timers. No filesystem, network, React or Electron. | itself only |
| Agent runtime | `src/agent/**` | Prompt composition, pi-ai engine construction, tool registry, background sub-agents, extraction/audit, Claude Code adapter, image processing. Storage arrives through injected ports/closures. | `core` |
| Server composition | `src/server/**` | Turn composition root, chat/graph/job/settings/key services, pi wire stream, SSE, pricing, search, compaction service. Framework-free `Request`/`Response`. | `core`, `agent`, `store` |
| Storage adapters | `src/store/**` | Filesystem implementations of `core/ports.ts` (chats, graph, jobs, settings, auth, study, prompt overrides, render settings). | `core` |
| HTTP/App Router | `app/**` | Route handlers, server components, layout, global CSS. Thin transport over `src/server/index.ts`. | `core`, `server` |
| Browser UI | `components/**` | Client components, session state machine, graph canvas, docks, settings. | `core` only |
| Desktop shell | `electron/**` | Main process, preload bridge, OAuth owners, subscriptions, updater, browser helper. Plain CommonJS Node, outside the import law. | — |
| Tooling/tests | `scripts/**`, `tests/**` | Build/curation, smoke probes, release verification, node:test suites. Unrestricted. | anything |

The law is executable in `eslint.config.mjs:38-68`, not merely documented: `components/**` may import only `@/src/core` from `src`; `app/**` may additionally import `@/src/server`; `src/core/**` may never import `agent`, `server` or `store`; `src/agent/**` may never import `server` or `store`. The server barrel (`src/server/index.ts:1-53`) is the only server surface `app/` is allowed to touch; the core barrel (`src/core/index.ts:1-87`) deliberately omits graph emission, clustering runtime, layout settle and graph-deletion runtime.

**Composition roots.** `src/server/stores.ts:1-41` is the single place concrete store adapters are constructed. `src/server/chat-handler.ts` is the turn composition root: it wires stores, agent factory, wake pipeline, turn registry and routes. `config.ts` is the only path/config seam (`PATHS`, `LEDGER_FILES`, `SETTINGS_FILE`, `AUTH_FILE`).

**Process boundaries.** The Next server is a single Node process; module-global registries that must survive route-bundle duplication are parked on `globalThis` (`__lhTurnRegistry`, `__lhWakePipeline`, extraction runs, subscription bridges). The Electron main process owns windows, OAuth, subscriptions, updates and the per-launch API capability. The renderer has no raw IPC and no filesystem API: `preload.cjs` exposes a narrow `window.lh` object.

---

## 3. Execution flows

### 3.1 A teacher turn

1. **Input.** `POST /api/chat` accepts exactly `{chatId, input}` — one explicit input event, never a client transcript (`chat-handler.ts:66-77`). `core/input-events.ts` parses six chat inputs (text, answer, continue, retry, thinking, next) plus server steer, user steer and silent dismiss variants.
2. **Admission, before any write.** `chat-handler.ts` gates in order: models configured (503), provider key present (503), compaction needed (structural gate), then turn liveness. Refused turns leave no liveness entry and no persisted user message.
3. **Write-ahead + background turn.** `beginTurn` registers the chat, the user event is appended durably through `ChatStore.saveMessages`, then the agent runs as a background object decoupled from the POST response (`chat-handler.ts:511-515`). POST returns `{ok:true}` immediately (`chat-handler.ts:673`).
4. **Agent construction.** `src/agent/teacher-agent.ts` composes prompt segments (source + active overrides), builds a native pi Agent with app/session identity, model/thinking spec, tools, provider observer, native-message converter and finish hook. `prepareRequest` classifies newly seen inputs; automatic steers dominate learner input, and missing identity never grants foreground.
5. **Execution.** `src/agent/tool-execute.ts` wraps every tool with a 30 s guard, parent-abort forwarding and a 250 ms cooperative grace. Question poses (`quiz`, `probe`, `ask_user_question`, `explain`, `recall`) and practice `problem` terminate the turn with a placeholder; acknowledgements such as `conclude` do not.
6. **Wire.** `src/server/pi/ui-stream.ts` forwards native pi `AgentEvent`s to every attached view; the only sanctioned rewrite is tool-call ID uniquification (`pi/call-ids.ts`, the "Lacan" fix for providers that reset `call_0`). `turn-runs.ts` holds `chatId → PiTurnHandle`; `GET /api/chats/[id]/stream` reattaches.
7. **Settle.** Assistant messages, tool results and usage are persisted; the plan tree/status and pending question are derived by core projections; `endTurn` clears liveness; events notify other windows. Compaction may run after settle or before the next turn.

### 3.2 Streaming, reattach and recovery

`components/session-core.ts` is the client state machine: canonical server `base`, optimistic/live `tail`, draft map, unconfirmed answer identities, execution overlays and single-consumer cancellation. SSE frames are UTF-8 `data: ` JSON lines with explicit `[DONE]`; EOF is not success. A full partial message replaces, never delta-concatenates. Reattach uses the server turn registry; a 409 identity retry is handled explicitly. `GET /api/chats/[id]` merges persisted record + liveness; `turn-liveness.ts` uses a 30-minute TTL and refuses a second concurrent turn.

### 3.3 Extraction (session → graph)

`src/agent/subagents/extraction.ts` owns orchestration only; graph merge goes through core ports. Teacher prose (not learner text, thinking or question content) is the source view, fingerprinted by `core/coverage.ts`. Two schema-validated sub-agents run:

- **Extractor** submits propositions (`id,name,statement,aliases?`) and chains (`premises[] → conclusion`) with message anchors.
- **Auditor** submits identity links between local and existing propositions.

`core/graph.ts:mergeFindings` resolves local IDs, creates unknown link targets, appends aliases/provenance, filters unresolved premises, deduplicates self/duplicate premises and maps chain endpoints to existing graph nodes. It is the sole writer of graph epistemology; the canvas, clusters and practice selection are derived. Extraction runs are tracked globally (`__lhExtractionRuns`) and surfaced in the activity feed. Chat deletion winds extraction down before deleting traces (`core/graph-deletion.ts`), with preserve-graph vs full-delete modes.

### 3.4 Background jobs and the wake pipeline

`src/server/jobs.ts` is the wake pipeline. A finished sub-agent job is delivered either through pi's live steering queue (turn running) or an idle wake (no turn). One registry, two vehicles; `registerLiveAgent`, `steerLiveChat`, `settleSteers`, `restoreUncommittedAutomatic` and `recoverStaleJobs` cover the state machine. `src/agent/subagents/runner.ts` maps job kinds to roles (researcher, demoBuilder, visualMaker, pdfReader), resolves a fresh engine, enforces key/slot admission, registers abort controllers and incremental usage, and persists status/results through `JobStore`. Background LLM calls share a global 3-slot FIFO semaphore; abort is a global `jobId → AbortController` map.

### 3.5 Practice

`POST /api/practice/sets` takes graph-domain input `{nodeIds, params, title?, note?}` — no chat or cluster ID. The UI resolves a picked cluster to member node IDs. `core/chains.ts:chainsForSelection` requires every endpoint selected, preserves argument IDs, sorts, and emits selected nodes without surviving chains as empty-premise singletons. The practice agent gets the learner note (trimmed, capped at 2000 chars) as an input it may weigh but never a licence to move a problem off its rung. `createPracticeGate` seeds one active problem per turn; `problem`/`conclude` mutate turn-local state; committed solutions stay hidden until conclude.

### 3.6 Graph home and canvas

`GET /api/graph` is a pure read of the merged ledgers. `core/graph.ts` derives canvas nodes/edges from stored propositions/chains; `core/layout.ts` computes SCC-aware inference depths and a d3-force layout; `core/session-clusters.ts` derives birth-session communities. The browser canvas (`components/graph-canvas.ts`) runs live physics, regions and labels; the server settles positions on import/drag commit (`commit-positions.ts`, `core/layout-settle.ts`). Render preferences are sanitized in `core/render-settings.ts` and stored separately from the ledgers.

### 3.7 Desktop boot

Packaged mode: single-instance lock → readiness → generate a per-launch capability secret → create ChatGPT/subscription owners → spawn the standalone server in Electron Node mode with `LH_DATA_DIR`/auth paths and the secret → wait for HTTP → register IPC/menu/updater → create the window. Every outgoing request from an owned main frame to the app origin `/api` gets the capability header; preexisting spellings are stripped. The server-side gate is `proxy.ts` + `src/server/desktop-access.ts`, applied to every `/api/:path*` method. Child exit disposes bridges and closes auth owners; quit sends SIGTERM then a delayed SIGKILL. macOS keeps the process alive with no windows and pauses auth owners; activate resumes.

### 3.8 Subscriptions and Claude Code

Two subscription families have separate owners: **ChatGPT** (`electron/chatgpt.cjs`, app-owned OAuth with PKCE/state/nonce, jose-verified ID tokens, leases and model catalog) and **native providers** (`electron/subscriptions.cjs`, exactly GitHub Copilot and xAI, SDK-owned OAuth, endpoint validation). Desktop owners live in the main process and travel over inherited IPC; the web/dev owner is `src/server/web-subscriptions.ts` and is used only when no desktop channel exists. Tokens never enter renderer snapshots.

**Claude Code** is a third engine: opt-in setting → binary/version check (`>= 2.1.259`) → spawn the installed CLI with stream-json, a private loopback MCP tool bridge, strict allowlists and no ambient key. It is not an API provider and reports CLI billing rather than dollars.

---

## 4. Data, storage and invariants

### 4.1 Paths

`config.ts:17-19` resolves `LH_DATA_DIR` or `<repo>/data`; read-only prompts remain `<repo>/src/agent`. Key paths:

| Path | Contents | Writer |
|---|---|---|
| `data/chats/<id>.json` | `ChatRecord`: native messages, tree, usage, overrides, extraction logs | `store/chats.ts` |
| `data/graph/nodes.jsonl` | Propositions, aliases, provenance | `store/graph.ts` |
| `data/graph/chains.jsonl` | Joint-premise chains with argument IDs | `store/graph.ts` |
| `data/graph/sessions.jsonl` | Session/chat provenance records | `store/graph.ts` |
| `data/graph/coverage.jsonl` | Per-source message coverage slots | `store/graph.ts` |
| `data/graph/sources.json` | Source usage/registration | `store/graph.ts` |
| `data/graph/positions.json` | Node positions | `store/graph.ts` |
| `data/graph/render-settings.json` | Canvas preferences | `store/render-settings.ts` |
| `data/graph/format.json` | Graph-family format version | `store/graph-format.ts` |
| `data/jobs/<id>.json` | Background job record | `store/jobs.ts` |
| `data/settings.json` | Non-secret user settings | `store/settings.ts` |
| `data/study/intervals.jsonl`, `open.json` | Study history + open timer | `store/study.ts` |
| `data/prompts/` | Prompt overrides | `store/prompt-overrides.ts` |
| `auth.json` / `.env.local` | Credentials (env-first resolution) | `store/auth.ts`, key manager |

### 4.2 Storage rules

- **Chats** are one JSON file per chat, schema-stamped lazily at version 1; newer records are refused rather than downgraded. Saves are synchronous through the port; no tmp/rename is visible in `chat-handler.ts`, so the turn assumes the adapter's write is durable before it starts.
- **Graph ledgers are append-only JSONL.** `GraphStore` is the exclusive writer of `data/graph/*`. Merge may rewrite selected ledgers for deletion; positions are replaced whole on settle. The format stamp versions the whole directory family because JSONL lines cannot carry a per-record version.
- **Jobs, settings, auth, study** use read-modify-write JSON. Auth writes 0600 with atomic replace; the store re-reads from disk on every access so hand edits keep working. Study uses synchronous `node:fs` so one request's read-modify-write cannot interleave in the single process.
- **Prompt overrides** are per-segment files behind a core port, path-validated against a numeric-prefix grammar; traversal outside the override dir is rejected.
- **Credentials** are plaintext JSON, outside learning data. The Electron subscription store enforces POSIX owner/permissions and regular-file `lstat`; the ChatGPT store validates schema but does not repeat the `lstat` check. Both write temp 0600 files, fsync, rename and fsync the directory.
- **Atomicity limits.** The graph and chat stores are not databases. Concurrent processes (e.g. tests sharing the default `data/`) are not isolated by the app; tests that omit `LH_DATA_DIR` can write the repo's real data directory.

### 4.3 Session/plan/question invariants

- `ChatRecord` stores native pi messages; the UI projection is derived, not persisted as a second transcript.
- Plan tree is structure-only (nodes/edges/version). Status is derived from tagged quiz/explain call node IDs; outcomes do not move position; consecutive stays collapse; the last stay is current, earlier stays are visited.
- Question schemas live in `core/question-core.ts`; display parsing in `core/tool-parts.ts`; pending-question authority in `core/pending.ts`; phase transitions in `core/phases.ts`. A rejected question never advances the phase.
- Usage buckets are disjoint: fresh input, cache read, cache write (with optional 1 h retention). Unknown cache-retention composition poisons the 1 h total rather than guessing.
- Coverage is fingerprint-based over teacher-facing prose; zero-token slots are excluded; a successful `send_to_user` is prose, failed calls are not.

---

## 5. Directory and file inventory

Line counts are Python `splitlines()` at the pinned commit. "Role" is the audited responsibility, not a claim that every branch was executed.

### 5.1 Repository root and configuration

| Path | Lines | Role |
|---|---:|---|
| `AGENTS.md` | 15 | Agent instructions: generated Next.js warning block + no-guessing/approved-plan rule. |
| `README.md` | 83 | Storefront, feature summary, quick start, links to docs. |
| `LICENSE` | 661 | AGPL-3.0 verbatim. |
| `config.ts` | 153 | The data-location seam: `ROOT`, `PATHS`, `LEDGER_FILES`, `SETTINGS_FILE`, `AUTH_FILE`; `LH_DATA_DIR` relocates mutable data. |
| `package.json` | 100 | Scripts (`dev`, `build`, `test`, `lint`, `typecheck`, desktop/smoke/release), deps, Node/Electron metadata. |
| `package-lock.json` | 18,278 | npm lockfile (generated; not hand-edited). |
| `next.config.ts` | 161 | Standalone output, tracing excludes/includes, `serverExternalPackages`, build-error policy, 26 MB proxy body limit. |
| `tsconfig.json` | 49 | Strict TypeScript, `@/*` path alias, Next plugin. |
| `next-env.d.ts` | 7 | Generated Next type references. |
| `postcss.config.mjs` | 5 | Tailwind/PostCSS plugin wiring. |
| `eslint.config.mjs` | 74 | The import-law zones plus Next/TS/import plugins; not a style linter. |
| `components.json` | 21 | shadcn `new-york` config and aliases. |
| `proxy.ts` | 17 | Desktop capability gate for every `/api/:path*` request; 403 without the trusted-window header. |
| `electron-builder.yml` | 194 | Packaging: app ID, file allowlist, extraResources server, mac/win/linux targets, signing/notarization. |
| `.gitignore` | 21 | Ignores `data/`, `.env.local`, `auth.json`, credential JSONs, `.fresh-data/`, `dist/`, build output. |

### 5.2 `app/` — App Router shell (42 paths)

| Path | Lines | Role |
|---|---:|---|
| `app/layout.tsx` | 41 | Root layout: fonts, metadata, theme bootstrap, global providers. |
| `app/page.tsx` | 22 | Home route; renders the graph home/minimal home. |
| `app/globals.css` | 600 | Design tokens, layout, canvas/dock/markdown styling. |
| `app/not-found.tsx` | 22 | 404 page. |
| `app/chat/new/page.tsx` | 30 | New-session route; draft shell + opening-prompt handoff. |
| `app/chat/[id]/page.tsx` | 41 | Session route; loads the chat shell for an ID. |
| `app/settings/page.tsx` | 11 | Settings route wrapper. |

The API routes are transport-only; each parses/validates input, calls a server service, and maps typed failures to HTTP.

#### `app/api/` — transport routes (35 paths, 1,311 lines)

| Route / file | Lines | Audited shape |
|---|---:|---|
| `app/api/activity/abort/route.ts` | 54 | `POST /api/activity/abort` — one dock control for `job`/`extraction`/`turn`; validates `kind ∈ {job,extraction,turn}` and `id`; maps job `404`/`409`, turn always `409`, extraction idempotent `200`. |
| `app/api/activity/route.ts` | 14 | `GET /api/activity` — dock poll: running jobs + extractions + graph revision; full `listChats()` scan per poll. |
| `app/api/chat/route.ts` | 5 | `POST /api/chat` — thin turn-composition front door over `handleChatRequest`. |
| `app/api/chats/route.ts` | 71 | `GET /api/chats` lists sessions; `POST /api/chats` creates with optional practice kind and graph-context picks (silently drops unknown kind). |
| `app/api/chats/[id]/route.ts` | 99 | `GET` reads one chat; `PUT` renames; `DELETE` deletes with mode. |
| `app/api/chats/[id]/settings/route.ts` | 48 | `PUT` replaces one chat settings section. |
| `app/api/chats/[id]/steer/route.ts` | 32 | `POST` server steer with kind/`reason`; rides the turn registry/wake pipeline. |
| `app/api/chats/[id]/stream/route.ts` | 24 | `GET` turn SSE via the turn registry; `turnInFlight` join for settle. |
| `app/api/chats/[id]/artifact-ui/route.ts` | 41 | `POST` persists learner's demo/figure invert; explicitly no wake. |
| `app/api/chats/[id]/markdown/route.ts` | 37 | `GET` downloads session markdown with slug filename + content-disposition. |
| `app/api/chats/[id]/dismiss/route.ts` | 65 | `POST` silent dismissal; parked `202` while a turn runs, applied at settle. |
| `app/api/claude-code/route.ts` | 6 | `GET` installation status; same-origin intent + disabled flags; 403/200. |
| `app/api/custom-provider/route.ts` | 9 | `GET/POST/PATCH/DELETE` custom endpoint lifecycle; secrets never in GET; bounded body, ETag-guarded mutations. |
| `app/api/events/route.ts` | 15 | `GET` SSE notification channel over the core bus; ping heartbeat, no replay. |
| `app/api/graph/route.ts` | 13 | `GET` pure home snapshot. |
| `app/api/graph/costs/route.ts` | 19 | `GET` pipeline cost fold, computed at read time. |
| `app/api/graph/status/route.ts` | 36 | `GET` in-flight extraction runs with id chatId#partIndex semantics. |
| `app/api/graph/coverage/extract/route.ts` | 37 | `POST` user extraction over one session; 202 fire-and-forget, 409 if already running; logs-then-returns on admission rejection. |
| `app/api/graph/import/route.ts` | 105 | `POST` multipart notes import through the 3-wide worker pool; results in completion order, per-file outcomes. |
| `app/api/graph/nodes/[id]/route.ts` | 27 | `DELETE` node with trace deletion + extraction gate. |
| `app/api/graph/positions/route.ts` | 24 | `PUT` commit anneal positions (≤±1e6, drop unknowns/finites), settle optional. |
| `app/api/graph/render-settings/route.ts` | 31 | `GET/PUT` render settings; sanitized whole-file write, bare-object responses. |
| `app/api/jobs/route.ts` | 23 | `GET` requires `?chatId=` (regex `^[A-Za-z0-9_-]+$`); returns `{jobs, turnInFlight}`. |
| `app/api/keys/route.ts` | 26 | `GET` key list + provider metadata; sensitive in browser-only mode (global gate only). |
| `app/api/keys/[id]/route.ts` | 50 | `PUT/DELETE` curated key save; `isWritableAuthKey` allowlist. |
| `app/api/models/route.ts` | 12 | `GET` catalog; awaits connection refresh; `no-store`. |
| `app/api/search/route.ts` | 18 | `GET` honest search availability `{available, engine, reason}`. |
| `app/api/settings/route.ts` | 23 | `GET` whole sanitized settings delta. |
| `app/api/settings/[section]/route.ts` | 133 | `PUT` replace-whole section write; strict parsers, chat/models validation, agent orphan-heal, thinking clamps; dynamic lookup caveat (`__proto__` → 500). |
| `app/api/settings/prompts/route.ts` | 29 | `GET` effective prober/teacher segments; omits `practice`. |
| `app/api/settings/prompts/[...segment]/route.ts` | 80 | `PUT/DELETE` per-segment prompt override CRUD with path grammar validation. |
| `app/api/stt/token/route.ts` | 18 | `GET` Deepgram token mint; missing key 503, upstream fail 502, no abort signal/timeout, token not `no-store`. |
| `app/api/study/route.ts` | 15 | `POST` study events, `GET` history/summary; tz + range validation. |
| `app/api/subscriptions/route.ts` | 23 | `GET/POST` subscription controls; same-origin intent, 16 KiB cap, opaque error mapping. |
| `app/api/subscriptions/browser/route.ts` | 17 | `GET/POST` one-use 303 browser action; id regex, 410/404/403 mapping. |

### 5.3 `components/` — browser UI (119 paths)

Root components are client-side. The load-bearing ones:

| Path | Lines | Role |
|---|---:|---|
| `components/chat.tsx` | 2,469 | Session page: turn orchestration, refusal/retry UI, dock routing, abort/steer, opening prompt. |
| `components/session-core.ts` | 967 | Canonical client state machine: base/tail, drafts, SSE fold, cancellation, usage completeness. |
| `components/graph-canvas.ts` | 1,737 | Canvas renderer: physics, regions, labels, hit-testing, zoom/fit. |
| `components/graph-view.tsx` | 1,753 | Graph home: data fetch, filters, cost panel, node/cluster interactions, position commit. |
| `components/chain-table.tsx` | 730 | Chains overlay: sort/filter/inspect reasoning chains. |
| `components/dictation.tsx` | 754 | Deepgram dictation: warm token, meter, capture, language, key handling. |
| `components/activity-dock.tsx` | 502 | Background-agent feed and extraction activity. |
| `components/md-blocks.tsx` | 472 | Markdown renderers: code, tables, blockquotes, math, copy. |
| `components/settings/settings-dialog.tsx` | 457 | Settings modal shell, section routing, account providers. |
| `components/settings/agent-section.tsx` | 876 | Agent tools, prompt switches, model/thinking overrides, search pins. |
| `components/settings/keys-section.tsx` | 1,038 | BYOK/provider keys, custom endpoint, subscription status. |
| `components/artifacts/*` | — | Tool-result renderers: research/PDF/demo/visual, probe assessment, generic/live tool cards. |
| `components/ui/*` | — | shadcn/Radix primitives (button, input, tooltip, separator, collapsible, hint). |

The remaining root components cover: session lifecycle (`session.ts`, `new-session.tsx`, `start-session.ts`, `opening-prompt.ts`, `session-overlay.tsx`, `session-navigation.tsx`, `session-find*`), question/practice docks and cards, plan/phase/compaction display, graph context/cost/delete dialogs, file-path input/drop/chip, dictation preference/state/language, dock height/state, keyboard shortcuts, menus/popovers/backdrop dismissal, study tracking/overlay, model catalog/picker, setup CTA/dialog, sidebar/top bar/update banner, markdown/mermaid/latex rendering, and pure helpers (`cluster-geometry`, `pan-zoom`, `usage-format`, `thinking-default`, `focus-hygiene`, `enter-submits`, `field-cycle`, `path-input-dom`, `session-find-dom`, `settings-signal`, `jobs-context`). Each is enumerated with its audited role in the coverage ledger and the UI reports; the table above names the files that carry cross-cutting behavior.

### 5.4 `src/core/` — pure domain (56 paths)

| Path | Lines | Role |
|---|---:|---|
| `src/core/index.ts` | 87 | Public browser barrel; deliberately excludes graph emission/derivation/clustering/settle/deletion runtime. |
| `src/core/contracts.ts` | 19 | Domain contract barrel. |
| `src/core/ports.ts` | 235 | Synchronous storage interfaces: ChatStore, GraphStore, StudyStore, JobStore, SettingsStore, PromptStore. |
| `src/core/contracts/chat.ts` | 331 | ChatRecord, usage buckets, turn logs, model-facing handoff/compaction texts. |
| `src/core/contracts/graph.ts` | 385 | GraphNode/Chain/Edge, snapshots, extractor/auditor submission schemas, links. |
| `src/core/contracts/jobs.ts` | 438 | Job computation/delivery state, usage accumulation, per-kind inputs/results. |
| `src/core/contracts/plan.ts` | 149 | Structure-only plan tree and status folding. |
| `src/core/contracts/probe.ts` | 94 | Assessment strands, `probe_done` schema, result/ack. |
| `src/core/contracts/models.ts` | 87 | Client catalog rows, thinking levels, price/context limits. |
| `src/core/contracts/study.ts` | 56 | Timer intervals, summary cards, calendar grid. |
| `src/core/contracts/subscriptions.ts` | 68 | Native subscription status/control bridge types. |
| `src/core/contracts/chatgpt.ts` | 27 | ChatGPT account/status/control types; credentials intentionally absent. |
| `src/core/contracts/claude-code.ts` | 12 | Claude Code route, status union, minimum version 2.1.259. |
| `src/core/graph.ts` | 690 | Graph merge (`mergeFindings`), IDs, derivation, provenance; server-only despite "pure" comments. |
| `src/core/chains.ts` | 93 | Practice selection: full-endpoint chains, empty-premise singletons, target resolution. |
| `src/core/graph-deletion.ts` | 334 | Preserve-graph vs full trace deletion, shared-node provenance, positions pruning. |
| `src/core/clusters.ts` | 14 | `MIN_CLUSTER_SIZE=3` only. |
| `src/core/session-clusters.ts` | 130 | Birth-session partition, implication attachment, labels. |
| `src/core/native-messages.ts` | 927 | Native message taxonomy, CLI context window, learner-facing text, agent-message casts. |
| `src/core/question-core.ts` | 802 | Quiz/ask/explain/recall/probe schemas, option resolution, answer building, grading rules. |
| `src/core/input-events.ts` | 315 | Six chat inputs + steers + dismiss parsing/append validation. |
| `src/core/pending.ts` | 196 | Pending-question authority, tool toggles, job tools, newest-first lookup. |
| `src/core/phases.ts` | 203 | Probe→plan→teach transitions from successful tool calls; resume_probe reset. |
| `src/core/view.ts` | 494 | Native messages → projected transcript blocks; tool-result routing; question dock identity. |
| `src/core/tool-parts.ts` | 119 | Display parser: clone → TypeBox Convert/Check/Clean + quiz/ask/explain refinements. |
| `src/core/answer-presentation.ts` | 57 | Historical answer projection; preserves learner data, binds saved options. |
| `src/core/plan-tree.ts` | 132 | Whole-tree creation/validation (IDs, edges, cycles). |
| `src/core/plan-blocks.ts` | 95 | Emit one plan block for the last un-emitted successful `plan_init`. |
| `src/core/settings.ts` | 869 | Settings schema/defaults, overridable roles, slots, refusal envelopes, custom budgets. |
| `src/core/settings-resolution.ts` | 278 | Resolve conversation/role/slot/model specs from settings + overrides. |
| `src/core/compaction.ts` | 406 | Pure cut selection, token heuristics, marker construction; no summarizer/persistence. |
| `src/core/prices.ts` | 80 | Call/turn/session/job cost folding; subscription and unknown handling. |
| `src/core/cost-summary.ts` | 205 | Stage totals/recent runs across chat + notes extraction/transcription/audit. |
| `src/core/context-usage.ts` | 27 | Measured context tokens from the latest completed valid assistant usage. |
| `src/core/events.ts` | 112 | Typed in-process event bus (`globalThis` listener set); no replay/queue. |
| `src/core/layout.ts` | 720 | SCC-aware depths + d3-force simulation shared by server settle and browser physics. |
| `src/core/layout-settle.ts` | 54 | Storage-driven settle: merged graph → unfiltered communities → whole positions ledger. |
| `src/core/render-settings.ts` | 394 | Render/physics/region defaults and sanitization ladders. |
| `src/core/study-time.ts` | 357 | 30 s ping, idle/close transitions, summary/calendar math. |
| `src/core/coverage.ts` | 192 | Teacher-prose view lines, fingerprints, coverage slots/summary. |
| `src/core/session-markdown.ts` | 205 | Session/message Markdown export with tool-result bodies. |
| `src/core/content-reader.ts` | 215 | Source-offset-preserving Markdown/math span reader. |
| `src/core/math-delims.ts` | 121 | Math delimiter normalization/restoration around code and lists. |
| `src/core/argument-heal.ts` | 96 | Top-level schema-guided JSON string healing. |
| `src/core/value-debris.ts` | 26 | Strip surrounding model punctuation/quotes for membership comparisons. |
| `src/core/file-paths.ts` | 86 | Rooted-path syntax, quoting, span parsing; no filesystem checks. |
| `src/core/prompt-segments.ts` | 50 | Numeric-prefix segment grammar and validity. |
| `src/core/fuzzy.ts` | 38 | Token-substring scoring for menus. |
| `src/core/session-find.ts` | 20 | Literal escaped search with UTF-16 offsets. |
| `src/core/session-navigation.ts` | 47 | Message anchors and proposition→message URLs. |
| `src/core/keyboard.ts` | 219 | Action registry, storage overrides, binding lookup. |
| `src/core/auth-keys.ts` | 229 | Curated key metadata, provider env names, shape validation, masking. |
| `src/core/auth-env.ts` | 24 | Env provenance (`realEnv`/`fillGap`) shared via `Symbol.for`. |
| `src/core/custom-provider-auth.ts` | 26 | Versioned custom-endpoint binding parser/matcher. |
| `src/core/search.ts` | 68 | Search provider/status interfaces + engine preference. |
| `src/core/dictation.ts` | 90 | Nova-3 language catalog + Deepgram listen URL. |

### 5.5 `src/agent/` — agent runtime (87 paths)

| Path | Lines | Role |
|---|---:|---|
| `src/agent/teacher-agent.ts` | 347 | Prompt composition, AgentBuildOptions, pi Agent construction, request preparation. |
| `src/agent/models.ts` | 190 | App identity, provider source registration, model catalog/engine resolution. |
| `src/agent/prompt-segments.ts` | 134 | Source/override listing, effective segment composition per agent kind. |
| `src/agent/tools.ts` | 479 | Shared question/probe/recall tools + teacher quiz/explain with live-plan validation. |
| `src/agent/tool-execute.ts` | 261 | Typed execution wrapper, 30 s guard, abort grace, result mapping. |
| `src/agent/subscription-runtime.ts` | 30 | Injected request/channel listener map on `globalThis`. |
| `src/agent/chatgpt-bridge.ts` | 134 | ChatGPT status/catalog/lease bridge, IPC correlation, revision guards. |
| `src/agent/subscription-bridge.ts` | 139 | Native subscription snapshot/lease bridge, scope/epoch checks. |
| `src/agent/subscription-connections.ts` | 23 | Shared subscription classification/scope helpers. |
| `src/agent/subscription-request-cycle.ts` | 128 | Foreground/background admission cycle, staged commits, duplicate suppression. |
| `src/agent/chatgpt-request-cycle.ts` | 4 | Compatibility re-export. |
| `src/agent/chatgpt-stream.ts` | 118 | Responses payload whitelist, history normalization, lease/abort. |
| `src/agent/subscription-stream.ts` | 85 | Native provider stream with leased auth, scope rechecks, no retries. |
| `src/agent/provider-events.ts` | 119 | Opt-in provider JSONL event log; any nonempty env enables; IO errors swallowed. |
| `src/agent/tools/fs-shared.ts` | 211 | Path resolution, caps, glob walk, binary sniff, abort/deadline. |
| `src/agent/tools/read.ts` | 123 | Text/image read, model-aware resize, 2,000-line/50 KiB slice. |
| `src/agent/tools/ls.ts` | 77 | Directory listing, dotfiles, sorted, 50 KiB cap. |
| `src/agent/tools/find.ts` | 87 | Glob walker with timeout/limit/output notices. |
| `src/agent/tools/grep.ts` | 178 | Regex/literal search, context, caps, binary/size skips. |
| `src/agent/tools/heal.ts` | 48 | Apply schema-guided argument healing to a tool. |
| `src/agent/tools/jobs.ts` | 171 | Research/demo/visual/PDF tool schemas and durable job spawn. |
| `src/agent/tools/plan.ts` | 110 | `plan_init` parse/validate/save whole tree. |
| `src/agent/tools/mermaid-plan.ts` | 163 | Mermaid plan parser with line-numbered errors. |
| `src/agent/tools/probe.ts` | 102 | `probe_done` assessment, handoff steer, delivery failure logging. |
| `src/agent/tools/resume-probe.ts` | 37 | Native resume marker + turn-local callback. |
| `src/agent/tools/practice.ts` | 249 | Practice gate, problem/conclude, solution visibility, graph context. |
| `src/agent/tools/send-to-user.ts` | 36 | Claude-only exact learner-facing message tool. |
| `src/agent/tools/graph.ts` | 182 | Prober session/proposition tools; auditor find/read tools. |
| `src/agent/tools/web.ts` | 194 | Search/fetch tools, Readability/Turndown, Jina fallback, caps. |
| `src/agent/tools/pdf-read.ts` | 221 | Researcher web PDF download/info/extract/search. |
| `src/agent/subagents/aborts.ts` | 60 | Global job abort controller registry. |
| `src/agent/subagents/bg-llm-semaphore.ts` | 92 | Global 3-slot FIFO background LLM limiter. |
| `src/agent/subagents/pi-run.ts` | 155 | Generic sub-agent Agent construction and callback wiring. |
| `src/agent/subagents/submit-agent.ts` | 134 | Schema-validated single-submit agent with retries. |
| `src/agent/subagents/runner.ts` | 574 | Job kind→role, engine/key admission, run/abort/usage/steer persistence. |
| `src/agent/subagents/researcher.ts` | 111 | Research role: web/PDF tools, 12 turns, cited brief. |
| `src/agent/subagents/demo-builder.ts` | 257 | write_demo/run_demo, browser verification, deterministic final check. |
| `src/agent/subagents/visual-maker.ts` | 391 | write/edit/render SVG loop, rasterize, inspect. |
| `src/agent/subagents/notes-transcriber.ts` | 155 | PDF text + selective page vision transcription. |
| `src/agent/subagents/headless.ts` | 588 | Chrome/Electron CDP service, demo execution, console/page/request capture. |
| `src/agent/subagents/pdf-ops.ts` | 256 | In-process pdfjs info/extract/search/render. |
| `src/agent/subagents/pdf-reader.ts` | 439 | PDF reader agent loop (info/extract/render/search). |
| `src/agent/subagents/extraction.ts` | 1,539 | Extraction/audit orchestration, transcript view, schemas, merge ports. |
| `src/agent/claude-code/constants.ts` | 8 | Provider ID/API constants and fixed errors. |
| `src/agent/claude-code/binary.ts` | 90 | Claude binary resolution (PATH + known dirs, Windows `.exe` only). |
| `src/agent/claude-code/installation.ts` | 38 | `--version` probe, semver comparison, installation states. |
| `src/agent/claude-code/launch.ts` | 32 | Pre/post-probe launcher, minimum-version gate, no shell. |
| `src/agent/claude-code/provider.ts` | 34 | Opus/Sonnet/Haiku catalog aliases, thinking map, empty auth. |
| `src/agent/claude-code/cli-events.ts` | 188 | JSON-lines event parser. |
| `src/agent/claude-code/context-window.ts` | 71 | Control-protocol context probe (5 s init timeout). |
| `src/agent/claude-code/live-processes.ts` | 43 | Idle-held process reuse map (10 min). |
| `src/agent/claude-code/reuse-context.ts` | 27 | Comparable conversation/config equality for replay. |
| `src/agent/claude-code/transcript.ts` | 99 | Replay flattening and stream-json input. |
| `src/agent/claude-code/tool-bridge.ts` | 234 | Authenticated loopback MCP bridge, pending calls, cancellation. |
| `src/agent/claude-code/stream.ts` | 695 | Arg construction, stream translation, usage/errors, process lifecycle. |
| `src/agent/image-processing/index.ts` | 59 | MIME normalization, resize/convert entry, omission union. |
| `src/agent/image-processing/types.ts` | 35 | Resize options/result types. |
| `src/agent/image-processing/resize.ts` | 65 | Worker orchestration with in-process fallback; no worker timeout. |
| `src/agent/image-processing/resize-worker.mjs` | 32 | Worker entry. |
| `src/agent/image-processing/resize-core.mjs` | 130 | Photon resize/encode ladder and limits. |
| `src/agent/image-processing/exif-orientation.mjs` | 157 | JPEG/WebP EXIF orientation. |
| `src/agent/image-processing/convert.mjs` | 25 | Decode/orient/encode PNG. |
| `src/agent/image-processing/mime.mjs` | 110 | Magic-byte MIME sniffing. |
| `src/agent/image-processing/photon.mjs` | 21 | Cached dynamic Photon import. |
| `src/agent/image-processing/*.d.mts` | 1-10 | Type declarations. |
| `src/agent/image-processing/LICENSE` | 21 | MIT attribution for the Photon-derived code. |

Prompt assets (`src/agent/system-prompt.md`, `src/agent/prompts/**`, `README.md`) are model instructions, not runtime validation. Composition: teacher/prober = base → role → all shared; practice = its base/doctrine + exactly voice/accuracy/mental-model/formatting. Numeric-prefix `.md` files load verbatim, including HTML comments. Overrides replace complete segments only when the switch is strictly true.

### 5.6 `src/server/` — transport and composition (31 paths)

| Path | Lines | Role |
|---|---:|---|
| `src/server/chat-handler.ts` | 684 | Turn composition root: input event → admission gates → write-ahead → background agent turn; also serves wake steers. |
| `src/server/chats.ts` | 181 | Chat CRUD delegation; `deleteChatSession` orchestrates gate → extraction wind-down → deletion. |
| `src/server/claude-code-config.ts` | 13 | Fresh Claude Code admission-state read (no process-wide cache). |
| `src/server/claude-code.ts` | 30 | Installation status check + same-origin HTTP response. |
| `src/server/commit-positions.ts` | 72 | Commit client-annealed drag positions; incremental settle for nodes minted mid-drag. |
| `src/server/compaction.ts` | 318 | Compaction trigger/mutex/marker/settle-kick/overflow recovery; poses terminate runs first. |
| `src/server/custom-provider-auth.ts` | 43 | Atomic custom-endpoint credential binding (file key, no stale env copy). |
| `src/server/custom-provider-body.ts` | 31 | Byte-bounded JSON body reader. |
| `src/server/custom-provider-http.ts` | 149 | Connect/manual-model/offline-pin HTTP workflow; secrets never in GET. |
| `src/server/custom-provider.ts` | 251 | Build a pi-ai provider from user base URL + discovered models; keyless placeholder. |
| `src/server/desktop-access.ts` | 17 | Per-launch desktop capability check (not an OS-user or OAuth boundary). |
| `src/server/dismissal-park.ts` | 80 | Park ESC-discard intent during a live turn; settle applies it to the fresh record. |
| `src/server/events-stream.ts` | 81 | `GET /api/events` SSE over the core event bus; heartbeat, no replay. |
| `src/server/graph.ts` | 121 | Graph read for the home view, single-node deletion, graph version stamp. |
| `src/server/index.ts` | 53 | The server barrel: the only `src/server` surface `app/` may import. |
| `src/server/jobs.ts` | 766 | Wake pipeline: live steer queue vs idle wake, delivery settlement, stale-job recovery. |
| `src/server/keys.ts` | 249 | Server key manager behind `/api/keys`; env seam for restart-free key changes. |
| `src/server/model-catalog.ts` | 347 | pi-ai catalog → client-safe DTOs; validation gate for settings writes. |
| `src/server/observability.ts` | 109 | Activity feed: running jobs across chats + global extraction runs. |
| `src/server/pi/call-ids.ts` | 212 | Tool-call ID uniquification across provider resets. |
| `src/server/pi/ui-stream.ts` | 367 | Native pi `AgentEvent` wire; one turn streamed to all views. |
| `src/server/pricing.ts` | 54 | Read-time API-dollar estimates using pi rates; key-independent. |
| `src/server/search.ts` | 240 | Tavily/Brave/Firecrawl adapters + live engine resolution. |
| `src/server/settings-body.ts` | 480 | Shared settings-PUT body parsers, one seam per section. |
| `src/server/stores.ts` | 41 | Storage composition root; the only place concrete adapters are wired. |
| `src/server/study.ts` | 107 | Apply pure timer transitions to open-timer file + interval history. |
| `src/server/turn-liveness.ts` | 77 | `chatId` in-flight registry, 30-minute TTL, double-begin refusal. |
| `src/server/turn-runs.ts` | 106 | `chatId → PiTurnHandle` registry for stream reattach and remote abort. |
| `src/server/turn-service.ts` | 139 | Named seams for turn responsibilities composed by `chat-handler`. |
| `src/server/web-subscription-http.ts` | 68 | Same-origin browser controls for web subscriptions (not user auth). |
| `src/server/web-subscriptions.ts` | 127 | Web/dev owner for ChatGPT + native subscription auth when no desktop owner exists. |

### 5.7 `src/store/` — filesystem adapters (9 paths)

| Path | Lines | Role |
|---|---:|---|
| `src/store/auth.ts` | 102 | `auth.json` flat credential map; 0600, atomic writes, re-read on every access. |
| `src/store/chats.ts` | 219 | One JSON file per chat; lazy v1 stamp; atomic replace. |
| `src/store/graph-format.ts` | 60 | `data/graph/format.json` family version stamp. |
| `src/store/graph.ts` | 331 | Append-only JSONL ledgers + sources/positions; exclusive graph-dir writer. |
| `src/store/jobs.ts` | 120 | One JSON file per job, keyed by tool-call ID for spawn dedup. |
| `src/store/prompt-overrides.ts` | 87 | Override-file CRUD under `data/prompts/`. |
| `src/store/render-settings.ts` | 43 | Read-modify-write `render-settings.json` (not a ledger). |
| `src/store/settings.ts` | 65 | Read-modify-write `settings.json`; non-secret preferences only. |
| `src/store/study.ts` | 145 | Append-only study intervals + open-timer JSON; sync fs. |

### 5.8 `electron/` — desktop shell (11 paths)

| Path | Lines | Role |
|---|---:|---|
| `electron/main.cjs` | 771 | Launcher, window/controller owner, server spawn, capability injection, menu, updater, lifecycle. |
| `electron/preload.cjs` | 105 | Narrow `window.lh` bridge: platform, file path, zoom, updater, settings, ChatGPT/subscription controls. No raw IPC/fs. |
| `electron/desktop-api.cjs` | 25 | Inject/strip the per-launch capability header on owned-origin `/api` requests. |
| `electron/server-title-guard.cjs` | 24 | macOS-only JS-backed `process.title` guard for the desktop server. |
| `electron/browser-service-readiness.cjs` | 94 | Validate loopback port + CDP `/json/version`; 5 s deadline, 500 ms request timeout. |
| `electron/web-subscription-browser.cjs` | 19 | Open only validated subscription browser actions (fixed origin, 303 HTTPS). |
| `electron/chatgpt.cjs` | 542 | ChatGPT OAuth owner: PKCE/state/nonce, jose verification, leases, catalog, persistence. |
| `electron/chatgpt-ipc.cjs` | 43 | Inherited-IPC child adapter for status/models/background lease. |
| `electron/subscriptions.cjs` | 251 | GitHub Copilot + xAI OAuth owner: SDK load, endpoints, catalog, leases, prompts. |
| `electron/subscription-store.cjs` | 64 | POSIX-checked private atomic credential store. |
| `electron/subscription-ipc.cjs` | 45 | Inherited-IPC child adapter for snapshot/lease + changed push. |

### 5.9 `scripts/` — build, data, smoke and release tooling (17 paths)

| Path | Lines | Role |
|---|---:|---|
| `scripts/build-server.mjs` | 92 | Curate `.next/standalone`: copy static/public, refuse data/auth/env secrets, assert prompt assets. |
| `scripts/after-pack.cjs` | 27 | macOS: replace packaged icon with full-resolution ICNS before signing. |
| `scripts/make-icons.mjs` | 55 | Render ICO/PNG from committed SVG; overwrites generated assets. |
| `scripts/wait-for-url.mjs` | 14 | Poll a URL (any HTTP status) with deadline/retry; dev launcher helper. |
| `scripts/dev-fresh.sh` | 99 | Fresh isolated dev data/env launcher. |
| `scripts/backfill-graph.ts` | 42 | Replay old chat ledgers into graph extraction/backfill. |
| `scripts/import-notes.ts` | 65 | Import notes/PDF sources into the graph pipeline. |
| `scripts/replay-layout.ts` | 142 | Recompute positions from graph ledgers for layout debugging. |
| `scripts/verify-release.ts` | 611 | Pure release-config/asset/feed validation CLI; no network. |
| `scripts/smoke-server.mjs` | 194 | Boot curated standalone server, check graph/models/settings routes. |
| `scripts/smoke-provider-runtime.mjs` | 166 | Offline provider import/init probe with network interdiction. |
| `scripts/smoke-compression-runtime.mjs` | 195 | Patched Next gzip backpressure/drain/abort probe. |
| `scripts/smoke-demo-runtime.mjs` | 234 | Payload demo import + packaged Chromium CDP helper probe. |
| `scripts/smoke-image-runtime.mjs` | 228 | Photon in-process + worker resize probe under network guards. |
| `scripts/smoke-web-subscriptions.mjs` | 125 | Web subscription cold start, SSE, browser action, one-use callback. |
| `scripts/smoke-opening-prompt.mjs` | 254 | Browser opening-prompt handoff/draft recovery cases. |
| `scripts/smoke-file-paths.mjs` | 425 | Browser + Electron file-path chip/drop/caret/send cases. |

### 5.10 `tests/` — node:test suites (259 paths)

The suite runs with `NODE_ENV=test tsx --test tests/*.test.ts tests/*.test.tsx` (`package.json:19`). It is node:test, not Vitest/Jest. Most files are direct children; the table lists all 227 test/helper modules, followed by the fixture tree. Tests are static descriptions: none were executed for this map.

**Isolation warning.** Isolation is mixed. Many suites set `LH_DATA_DIR`/`LH_AUTH_FILE` to a temp dir, but several import real stores with neither variable and therefore read/write the repository's default `data/` directory. The audited default-data writers are `activity-feed`, `api-key-hook`, `chat-flow`, `demos`, `diagnostic-reopen`, `extraction`, `graph`, `jobs`, `plan-tree`, `probe-done`, `practice-flow`, `question-tools`, `tool-toggles-bridge`, `usage`, `settings-store` and `notes-import-route`. `graph.test.ts` additionally renames real graph ledgers to `.w5test.bak`. Do not assume a test run is side-effect-free.

**Prerequisites beyond Node:** native `@napi-rs/canvas` and `@silvia-odwyer/photon-node` (image/PDF tests), `jose` (ChatGPT/OAuth), `linkedom` + `react-dom` (DOM/SSR tests), pi-ai/pi-agent-core packages, `@modelcontextprotocol/sdk`, and installed electron-builder/app-builder-lib for packaging tests. Some tests deep-import `node_modules` internals and break on package layout changes.

**Skips:** only `session-core.test.ts`'s 409 identity-retry describe is conditionally skipped via `NO_SLOW`; `claude-code-version-runner` skips three shebang cases on win32/whitespace exec paths. No `.only`/`.todo` found.

| Test module | Lines | Audited target |
|---|---:|---|
| `tests/activity-feed.test.ts` | 105 | `activityFeed()` composition over real chatStore/jobStore. |
| `tests/agent-image-paths.test.ts` | 351 | contract tests for the shared read tool and PDF/visual/practice/prober image paths, using a faux engine (`createFauxCore`), synthetic canvas PNGs a... |
| `tests/api-key-hook.test.ts` | 55 | asserts teacher and prober agents expose no `getApiKey` hook (native per-provider key resolution). |
| `tests/artifact-ui.test.ts` | 90 | POST /api/chats/:id/artifact-ui route contract (404 unknown chat, 400 bad body/non-artifact id, 200 with ui.inverted round trip). |
| `tests/auth-keys.test.ts` | 118 | pure catalog, validateKeyShape, genericProviderKeyGuard, maskKey. |
| `tests/auth-provider-keys.test.ts` | 92 | no-drift pin. |
| `tests/auth-store.test.ts` | 80 | AuthStore fs adapter. |
| `tests/automatic-updates.test.ts` | 299 | reads electron/main.cjs and runs it in `node:vm` with fake electron, electron-updater, fs, timers, and process (platform darwin, packaged). |
| `tests/backdrop-dismiss.test.ts` | 247 | React hook and AbortTurnBody behavior under linkedom. |
| `tests/browser-service-lifetime.test.ts` | 149 | loads electron/main.cjs via `runInNewContext` with fake electron (app, BrowserWindow), net, readiness module, and process (win32, stdin Readable). |
| `tests/browser-service-readiness.test.ts` | 170 | shipping readiness helper against real loopback HTTP servers (127.0.0.1, ephemeral ports). |
| `tests/browser-service.test.ts` | 42 | pure parseBrowserServiceLine and browserServiceSpawnEnv (ELECTRON_RUN_AS_NODE stripped, caller env not mutated). |
| `tests/byok-refusal.test.ts` | 228 | client refusal detectors (parseModelsRefusal, parseProviderKeyRefusal, isModelsRefusal, isProviderKeyRefusal), retryFailedResponse with SessionMode... |
| `tests/call-ids.test.ts` | 142 | pure ToolCallIdUniquifier and collectToolCallIds (the "Lacan" call_0 collision fix). |
| `tests/chat-birth-stamp.test.ts` | 108 | POST /api/chats stamps the new chat's settings from the strong slot. |
| `tests/chat-flow.test.ts` | 1744 | largest scripted teacher-loop integration suite. |
| `tests/chat-kind.test.ts` | 46 | ChatRecord.kind absent-by-default and practice marker. |
| `tests/chat-store-events.test.ts` | 77 | chat-store event announcements (create/rename/delete announce; content writes silent). |
| `tests/chatgpt-auth.test.ts` | 684 | OAuth/credential service from electron/chatgpt.cjs via createRequire. |
| `tests/chatgpt-background.test.ts` | 94 | background-use consent gating over the app's stores and the turn-runner/jobs pipeline. |
| `tests/chatgpt-catalog.test.ts` | 52 | ChatGPT catalog generation and authority (overlapping refresh, consent-only status, account/authority change invalidation) through the bridge. |
| `tests/chatgpt-connection-ui.test.tsx` | 564 | large React UI suite for the ChatGPT connection dialog, mounted with react-dom/client and linkedom. |
| `tests/chatgpt-dev-ipc.test.ts` | 57 | framework-IPC vs desktop transport. |
| `tests/chatgpt-file-store.test.ts` | 125 | real fileStore from electron/chatgpt.cjs against mkdtemp dirs under os.tmpdir(). |
| `tests/chatgpt-request-cycle.test.ts` | 158 | native request cycle with real Agent and runPiTurn. |
| `tests/chatgpt-stream.test.ts` | 178 | ChatGPT Responses stream adapter. process.send/connected and LH_DESKTOP env overridden in before(), restored in after(); globalThis.fetch replaced... |
| `tests/chatgpt-ui.test.tsx` | 84 | React hooks and graph-cost UI under linkedom. |
| `tests/chatgpt-usage.test.ts` | 46 | subscription-usage vs API-dollar accounting (callCost, turnCost, sessionCost, jobCost, graphCostSummary). |
| `tests/claude-code-binary.test.ts` | 70 | resolveClaudeBinary with a fake isExecutable set (no filesystem). |
| `tests/claude-code-context-ui.test.tsx` | 46 | StatsBar context display for CLI sessions. |
| `tests/claude-code-context-window.test.ts` | 98 | ContextWindowProbe control-protocol state machine driven by synthetic control_response lines (no CLI). |
| `tests/claude-code-harness.test.ts` | 319 | end-to-end CLI harness through the real handleChatRequest with the runClaude seam spawning tests/fixtures/claude-code/fake-claude.mjs. |
| `tests/claude-code-installation.test.ts` | 72 | inspectClaudeInstallation and createClaudeLauncher with fake findBinary, readVersion, and spawnProcess (assert-fail if spawn is reached in refusal... |
| `tests/claude-code-opt-in.test.ts` | 98 | opt-in settings parsing and PUT section route. |
| `tests/claude-code-provider.test.ts` | 57 | CLAUDE_CODE_PROVIDER catalog (opus/sonnet/haiku, thinking levels, input types, zero costs, auth without key). |
| `tests/claude-code-status-http.test.ts` | 46 | claudeCodeInstallationResponse CSRF and origin gating (403 for cross-site or foreign origin, 200 for legit GET), forged forwarded headers rejected. |
| `tests/claude-code-status-ui.test.tsx` | 141 | React status UI and shared model-catalog invalidation under linkedom. |
| `tests/claude-code-stream.test.ts` | 1051 | stream function and CLI line parser over the runClaude seam, spawning tests/fixtures/claude-code/fake-claude.mjs (Node child processes with IPC and... |
| `tests/claude-code-tool-bridge.test.ts` | 271 | MCP tool bridge (createToolBridge) over real loopback HTTP using the MCP SDK client. |
| `tests/claude-code-transcript.test.ts` | 161 | toClaudeInput/toStreamJsonLine replay rendering (system prompt joining, tool add/remove, text, tool call/result, error results, images, thinking om... |
| `tests/claude-code-usage.test.tsx` | 55 | CLI billing shown as "CLI" rather than $0 across pricing, graph cost summary, StatsBar, and model menu. |
| `tests/claude-code-version-runner.test.ts` | 63 | real execFile boundary running authored fixture executables (node shebang scripts) in mkdtemp dirs under os.tmpdir(); removed in t.after. |
| `tests/clusters.test.ts` | 27 | MIN_CLUSTER_SIZE constant and clusterHue stability/spread. |
| `tests/commit-positions.test.ts` | 111 | commitPositions sanitizer over the real graph store. |
| `tests/compaction-native-parity.test.ts` | 55 | golden-value parity for compactionCutIndex and estimateMessageTokens against pi-coding-agent 1.4.0 outputs (source hash in comment). |
| `tests/compaction-service.test.ts` | 364 | compaction service trigger, mutex, marker, events, chaining, and summarizer failure. |
| `tests/compaction.test.ts` | 474 | pure compaction core (estimators, cut walk, marker, toLlmMessages projection, dividers, chrome carry-through). |
| `tests/completion.test.ts` | 16 | completedWithin helper behaviour (resolve, reject passthrough, timeout message). |
| `tests/completion.ts` | 15 | not a test file. |
| `tests/composer-actions.test.tsx` | 86 | composer action row layout, picker and setup ordering, practice draft shell, via renderToStaticMarkup and linkedom parseHTML (no globals installed). |
| `tests/composer-attach.test.tsx` | 132 | attach button and picked-file path chips. |
| `tests/content-recovery.test.ts` | 116 | math-delimiter repair and restoration (repairMathForDisplay, transformMathDelimiters, restoreMathEscapes). |
| `tests/context-usage.test.ts` | 54 | measuredContextTokens and SessionModel.applyWireEvent context meter behaviour. |
| `tests/cost-summary.test.ts` | 145 | graphCostSummary fold (stages, unpriced runs, recent cap, transcription stage). |
| `tests/coverage.test.ts` | 252 | extraction coverage pure core (fingerprints, coverageOf, batchRuns, batchTag). |
| `tests/custom-endpoint.test.ts` | 392 | custom OpenAI-compatible endpoint pure core and provider build (normalizeBaseUrl, sanitizers, pins, discovery with stubbed fetch, resolution). |
| `tests/custom-provider-boundaries.test.ts` | 217 | custom-provider route and auth boundary contracts (origin/CSRF, PATCH/DELETE, redirects, body limits, reuse/binding consent, env ownership, crash-s... |
| `tests/custom-provider-lifecycle.test.ts` | 129 | native Pi payloads for the custom provider with a synthetic fetch. |
| `tests/custom-provider-restart.test.ts` | 81 | cold-restart and crash-recovery contracts. |
| `tests/custom-provider-route.test.ts` | 130 | POST /api/custom-provider connect policy (typed model ids vs failed probes, rejected key, prune behaviour). |
| `tests/custom-provider-ui.test.tsx` | 51 | settings and setup UI for the custom endpoint. |
| `tests/data-dir-seam.test.ts` | 51 | LH_DATA_DIR relocation contract. |
| `tests/delete-node-dialog.test.tsx` | 129 | pure SSR of the node-deletion dialog body (copy, cap at 8 names, failure line, busy state). renderToStaticMarkup only; no globals. |
| `tests/demo-runtime-payload.test.ts` | 107 | smoke-demo-runtime standalone dependency gate. |
| `tests/demos.test.tsx` | 1137 | demo and visual artifact contracts. |
| `tests/desktop-api.test.ts` | 94 | desktop capability header injection, API matcher via unstable_doesProxyMatch, proxy 403s with method matrix, chatGPTControl routing (sender trust),... |
| `tests/desktop-payload.test.ts` | 96 | desktop standalone payload curation. |
| `tests/desktop-platform.test.ts` | 369 | Electron window options, preload bridges, packaging policy, workflow action pins, and release-prepare script run against an in-memory GitHub API. |
| `tests/diagnostic-reopen.test.ts` | 101 | resume-probe reopening (history reset, refusal, real teacher run stops at reopen, mixed batch). |
| `tests/dictation-flow.test.tsx` | 322 | dictation hook and language setting flows with a fake WebSocket, AudioContext, Worklet, getUserMedia, and fetch. |
| `tests/dictation-language.test.ts` | 82 | Nova-3 language contract, pure URL and sanitizer checks. |
| `tests/dictation-picker.test.tsx` | 300 | dictation language picker and shared model menu. |
| `tests/dictation-preference.test.ts` | 110 | createDictationLanguageStore with an injected fetch (reads and writes counted). |
| `tests/dictation-warm.test.ts` | 103 | createWarmMinter cache and TTL behaviour with an injected clock and mint function. |
| `tests/dismissal-park.test.ts` | 202 | parked dismissal registry and applyParkedDismissal against real records, plus the dismiss route's 202 park contract. |
| `tests/dock-height.test.tsx` | 259 | dock layout measurement and observer lifecycle under linkedom. |
| `tests/dock-state-key.test.ts` | 38 | dockStateKey variant key (fold term for practice and question docks; undocked band has no fold term). |
| `tests/enter-submits.test.ts` | 82 | buttonKeepsNativeEnter and blurAfterPointerClick under linkedom. |
| `tests/esc-layering.test.ts` | 52 | escAbortTarget precedence (question, problem, turn, and overlay priority). |
| `tests/events.test.ts` | 131 | event bus contract (subscribe/emit/unsubscribe, error isolation, globalThis registry) and eventsResponse SSE frames. |
| `tests/extraction.test.ts` | 2661 | extraction pipeline contracts (extractor → auditor → merger), anchors, serialized audit gate, chunking and digest, notes import and retry/abort rel... |
| `tests/file-path-chip.test.tsx` | 89 | FilePathChip and PathText SSR markup (icons, title/aria, HTML inertness). renderToStaticMarkup plus parseHTML; no globals. |
| `tests/file-path-drop-zone.test.tsx` | 233 | desktop drop routing, browser notice, invalid items, sidebar placement. |
| `tests/file-path-preload.test.ts` | 93 | path-only preload bridge run in node:vm with a fake electron (webUtils, ipcRenderer). |
| `tests/file-paths.test.ts` | 127 | pure file-path tokenizer (quoting, delimiter runs, control characters, label extraction). |
| `tests/font-menu.test.tsx` | 175 | font menu pure row set, composition, SSR shapes, and CSS token assertions. |
| `tests/fresh-env-keys.test.ts` | 143 | LH_IGNORE_ENV_KEYS=1 fresh-user switch. |
| `tests/fs-tools.test.ts` | 267 | learner-filesystem tools (ls, find, grep, read) against a mkdtemp fixture tree. |
| `tests/fuzzy.test.ts` | 42 | fuzzyScore ranking. |
| `tests/golden-fixtures.test.ts` | 231 | read-only contracts over the real data fixture tests/fixtures/golden-data. |
| `tests/graph-canvas.test.ts` | 416 | renderer math (camera ratio, label fade, d3 composition, fit transform, arrow geometry, pickNearest, region tuning, blur, wrapped labels, applyClus... |
| `tests/graph-context.test.ts` | 154 | graph-context marker (pure builder, first-send gate, POST /api/chats route with picks). |
| `tests/graph-pricing.test.tsx` | 60 | headline cost semantics (unknown vs known zero, mixed, subscription) and 1h cache-write aggregation via renderToStaticMarkup. |
| `tests/graph-rename-labels.test.ts` | 120 | renameSessionsPatch identity and seedMissingNodePositions. |
| `tests/graph-tools.test.ts` | 231 | prober and auditor graph tools with in-memory fake stores (graph and chat). |
| `tests/graph-view-filters.test.ts` | 70 | isNodeVisible search predicate and displayCostTotals fold. |
| `tests/graph.test.ts` | 1148 | merger, derivation, deletion, and graph-ledger store primitives. |
| `tests/headless-png.test.ts` | 162 | providerSafePng merges split IDAT chunks into one chunk and leaves canonical input unchanged. |
| `tests/image-processing.test.ts` | 357 | native image pipeline (resizing, dimension hints, byte caps, JPEG quality selection, BMP conversion, EXIF orientation, MIME sniffing, worker-thread... |
| `tests/job-delivery-recovery.test.ts` | 331 | job delivery, wake pipeline, and crash recovery, including a child process (`node --import tsx -e`) with an isolated HOME and LH_DATA_DIR. |
| `tests/jobs.test.ts` | 1909 | job store, steer helpers, dispatch and runner completion/failure, the wake pipeline, abort, crash-recovery sweep, BYOK and key-presence refusal, an... |
| `tests/katex-security.test.ts` | 83 | KaTeX prototype-pollution read-side tests. |
| `tests/keyboard-toggle-sidebar.test.ts` | 76 | keyboard action registry and event-name helper. |
| `tests/layout.test.ts` | 490 | incremental force layout, settle, imp-link half distance, cluster pull, depth ranking, and depth-anchor force (vertical, radial, orphan exemption). |
| `tests/mac-signing-toolchain.test.ts` | 124 | verifies electron-builder's macCodeSign createKeychain password separation by running the installed app-builder-lib source in node:vm with fake mod... |
| `tests/markdown-export.test.ts` | 81 | GET /api/chats/:id/markdown route. |
| `tests/menu-shell-pure.test.ts` | 82 | computeMenuPlacement geometry (side flip, 60vh cap, floor, alignment). |
| `tests/model-catalog-setup.test.tsx` | 298 | setup dialog and model-catalog UI with an injected fetch that returns deferred responses per path, plus DOM globals installed at module scope (not... |
| `tests/model-catalog.test.ts` | 418 | model catalog projection, slot and role pins, validation, clamping, pi thinking truth, and claude-code provider gating. |
| `tests/models-settings-repair.test.ts` | 165 | PUT /api/settings/models repair semantics under desktop IPC emulation. |
| `tests/next-compression-drain.test.ts` | 12 | calls `verifyCompressionRuntime(repoRoot)` (see gap 1). |
| `tests/notes-import-route.test.ts` | 130 | `POST` route for notes import with faux stages. |
| `tests/notes-import.test.tsx` | 245 | `useNotesImport` hook with a stubbed fetch and linkedom DOM. |
| `tests/notes-transcriber.test.ts` | 120 | PDF and image transcription with faux vision engines and a fake headless renderer. |
| `tests/opening-delivery.test.ts` | 203 | `SessionModel` opening-send acceptance, teardown races, and failure recovery. |
| `tests/opening-prompt.test.ts` | 123 | sessionStorage stash/read/clear and `SessionStarter` create-and-handover. |
| `tests/openrouter-free-models.test.ts` | 58 | offline catalog, validation and engine request payload for free OpenRouter models. |
| `tests/pan-zoom.test.ts` | 72 | pure viewport math (fit zoom, clamping, zoom-to-cursor). |
| `tests/path-input.test.tsx` | 629 | path-chip editor DOM projection, selection, history and IME. |
| `tests/pdf-native-render.test.ts` | 188 | real pdfjs and `@napi-rs/canvas` rendering against `sample-3page.pdf` and a generated oversized PDF in a temp dir. |
| `tests/pdf-ops.test.ts` | 67 | pdfjs text layer against `sample-3page.pdf` and `not-a-pdf.txt`. |
| `tests/pdf-reader.test.ts` | 238 | pdf-reader loop on faux engines. |
| `tests/pending-authority.test.ts` | 127 | pending-question authority over projected views. |
| `tests/pending-question-form.test.tsx` | 132 | question dock keyed reset and live-to-canonical sync with `SessionModel`. |
| `tests/phases.test.ts` | 231 | `phaseAt3` / `phaseTimeline` / `phaseAt3Lh` folds. |
| `tests/plan-blocks.test.ts` | 232 | plan-block emission and projection. |
| `tests/plan-tree.test.ts` | 453 | pure plan-tree ops, `derivePlanStatuses`, the mermaid parser, and `planTools` `plan_init` against the real `chatStore`. |
| `tests/practice-agents.test.ts` | 405 | practice agent tool gating, registry shape, and prompt composition. |
| `tests/practice-flow.test.ts` | 225 | practice integration with a scripted faux engine through `handleChatRequest`. |
| `tests/practice-heal.test.ts` | 114 | argument healing for practice tools, with end-to-end `validateToolArguments`. |
| `tests/practice-record.test.ts` | 428 | practice record folds, dismissal, thinking markers, `toLlmMessages` shapes. |
| `tests/pricing-native-parity.test.ts` | 45 | parity between `callCost`/`jobCost` and Pi's `calculateCost` across every API model. |
| `tests/pricing-transport.test.ts` | 34 | chat GET returns derived pricing without writing the usage log. |
| `tests/probe-done.test.ts` | 203 | `probeDoneTool` against the real `chatStore` in default `data/`; cleans up chats. |
| `tests/prompt-overrides.test.ts` | 432 | override store CRUD, traversal guard, source-derived segments, and route-level delete and orphan-heal. |
| `tests/provider-events.test.ts` | 117 | env-gated raw-wire recorder, using `providerEventsDir` redirection into temp directories. |
| `tests/provider-neutral-agents.test.ts` | 338 | raw visual and PDF loops against closed fetch. |
| `tests/provider-runtime-payload.test.ts` | 43 | spawns `scripts/smoke-provider-runtime.mjs` with a 40 s timeout; checks that the gate rejects a missing entry and an escaping dependency. |
| `tests/provider-tracing.test.ts` | 67 | Next `outputFileTracingExcludes` and `Includes` patterns, against the real `next.config.ts`. |
| `tests/question-core.test.ts` | 821 | quiz/ask/explain schemas, `normalizeOptions`, `resolveCorrect`, `buildAnswer`, dock selection state machine. |
| `tests/question-tools.test.ts` | 475 | teacher and prober question tools with the real `chatStore` in default `data/`; cleans up chats. |
| `tests/read-tool.test.ts` | 129 | read tool semantics on temp files; uses `@napi-rs/canvas` for a PNG. |
| `tests/reading-thinking-field.test.tsx` | 23 | SSR class pins only. |
| `tests/rejected-question-phase.test.ts` | 48 | refused quiz/explain calls never advance the phase. |
| `tests/render-abort-turn-dialog.test.tsx` | 47 | SSR of the abort dialog body. |
| `tests/render-activity-dock.test.tsx` | 253 | pure fold helpers plus SSR. |
| `tests/render-cards.test.tsx` | 829 | broad SSR of interaction cards. |
| `tests/render-chain-table.test.tsx` | 360 | SSR of the chain table. |
| `tests/render-compaction-divider.test.tsx` | 80 | SSR of inert dividers. |
| `tests/render-composer.test.tsx` | 118 | SSR of the composer and `enterAction`. |
| `tests/render-extraction-coverage.test.tsx` | 198 | `fetchGraphRead` with a stubbed fetch, and SSR of coverage surfaces. |
| `tests/render-graph-chrome.test.tsx` | 73 | SSR of `GraphChromeRow`. |
| `tests/render-live-tool-card.test.tsx` | 43 | SSR of the live card. |
| `tests/render-md-blocks.test.tsx` | 274 | SSR of markdown block overrides and overlays. |
| `tests/render-minimal-home.test.tsx` | 85 | SSR of the knowledge summary. |
| `tests/render-new-session.test.tsx` | 256 | `startDraftSession` with fake fetch and stubbed `sessionStorage`; SSR of the draft shell. |
| `tests/render-phase-divider.test.tsx` | 162 | SSR of phase chip and divider. |
| `tests/render-practice-surface.test.tsx` | 264 | SSR of practice dock and cards, and the projection. |
| `tests/render-queued-steers.test.tsx` | 51 | SSR of the queued-steer list. |
| `tests/render-settings.test.ts` | 361 | `sanitizeRenderSettings` and ladder mapping. |
| `tests/render-settings.test.tsx` | 337 | SSR of settings sections. |
| `tests/render-sidebar.test.tsx` | 163 | SSR of the session row and `timeAgo`. |
| `tests/render-stats-bar.test.tsx` | 160 | SSR of the stats bar and catalog limit join. |
| `tests/render-streaming-math.test.tsx` | 140 | SSR and a mounted streaming test with linkedom, shimming `requestAnimationFrame` and `getComputedStyle`. |
| `tests/render-study-time.test.tsx` | 116 | SSR of the study-time body. |
| `tests/render-update-banner.test.tsx` | 83 | update banner with a stubbed `window.lh` bridge and a linkedom mount. |
| `tests/render-update-settings.test.tsx` | 223 | update settings with a fake bridge and mounted React. |
| `tests/repair-math-display.test.tsx` | 252 | display repair composition and SSR assertions with KaTeX parsing. |
| `tests/research-settings.test.tsx` | 70 | mounted `AgentSection` with a stubbed fetch for keyless research. |
| `tests/researcher-pdf.test.ts` | 204 | `web_fetch_pdf` and pdf-read tools with a stubbed fetch returning a generated PDF. |
| `tests/retry-failed-turn.test.ts` | 613 | failed-response retry against the real chat handler. |
| `tests/reveal-arrival.test.ts` | 62 | `revealArrival`, `probeArrivalExpanded`, `shouldStampGeometryMute`. |
| `tests/schema-stamps.test.ts` | 117 | lazy v1 stamps for chats and the graph family, and refusal of newer records. |
| `tests/search.test.ts` | 213 | search engine resolution and Tavily, Brave and Firecrawl adapters against stub fetch. |
| `tests/send-to-user.test.ts` | 369 | output-tool projection, extraction and offline native flows. |
| `tests/server-events.test.tsx` | 108 | `createNotifyHub` and `wireSource` with a fake source. |
| `tests/server-keys.test.ts` | 215 | key store precedence, shadowing, fill-gap reflection, and deletes. |
| `tests/server-title-guard.test.ts` | 158 | macOS `process.title` guard (VM context), server launch args from `electron/main.cjs`, and electron-builder copy matchers. |
| `tests/session-clusters.test.ts` | 355 | birth-session partition and graph snapshot joins. |
| `tests/session-context.test.tsx` | 128 | SSR of `RenameRow`, `SessionRow` and the delete dialog body. |
| `tests/session-core.test.ts` | 1769 | `SessionModel` state machine: 409 retry, reattach, adoption, error banners, truncation recovery, answer submission. |
| `tests/session-find.test.tsx` | 184 | find matcher and linkedom DOM seam. |
| `tests/session-identity.test.ts` | 192 | app identity and conversation identity across providers. |
| `tests/session-markdown.test.ts` | 226 | `messageMarkdown` and `sessionMarkdown` shapes. |
| `tests/session-navigation.test.ts` | 84 | proposition-to-message hrefs and anchors. |
| `tests/settings-body.test.ts` | 318 | strict section parsers (general, agent, appearance, graph, compaction, models, study time). |
| `tests/settings-pure.test.ts` | 392 | appearance-to-CSS mapping, compose helpers, key classification, first-run gate, section ordering. |
| `tests/settings-resolution.test.ts` | 281 | delta-over-factory resolution, slot tiers, graph gates, study-time defaults. |
| `tests/settings-signal.test.ts` | 67 | `lh:settings-saved` seam against a bare EventTarget. |
| `tests/settings-store.test.ts` | 76 | settings store adapter. |
| `tests/settings.test.ts` | 235 | `sanitizeUserSettings` and `FACTORY_SETTINGS`. |
| `tests/setup-dialog-interaction.test.tsx` | 190 | mounted setup dialog with a stubbed fetch; asserts no writes. |
| `tests/stats-meter-interaction.test.tsx` | 46 | mounted stats bar with a stubbed fetch. |
| `tests/stream-activity.test.ts` | 59 | `streamingToolActivity` labels. |
| `tests/study-route.test.ts` | 76 | `/api/study` GET and POST status mapping. |
| `tests/study-service.test.ts` | 171 | study service against real chat files in an isolated `LH_DATA_DIR`. |
| `tests/study-store.test.ts` | 114 | study store intervals and open-timer persistence. |
| `tests/study-time.test.ts` | 327 | pure study-time core (timers, dedupe, summary, time zones, duration formatting). |
| `tests/study-tracker.test.ts` | 312 | client study tracker with injected clock, focus and send. |
| `tests/subscription-auth.test.ts` | 221 | native OAuth controller (Copilot and Grok) against a temp directory with a fake SDK. |
| `tests/subscription-background.test.ts` | 62 | foreground and background subscription leases with a fake `process.send`. |
| `tests/subscription-connection-ui.test.tsx` | 133 | mounted native subscription UI with a fake bridge. |
| `tests/subscription-stream.test.ts` | 107 | subscription transport routes with a fake IPC channel. |
| `tests/subscription-usage.test.tsx` | 43 | subscription labels, pricing and SSR. |
| `tests/svg-image.test.tsx` | 207 | SVG image boundary, SSR and a mounted fullscreen download test that intercepts `createElement`. |
| `tests/svg-native-render.test.ts` | 69 | resvg rasterization through `realHeadless.renderSvg`. |
| `tests/thinking-default.test.ts` | 59 | default thinking-level helpers. |
| `tests/title-from-prompt.test.ts` | 56 | `titleFromPrompt` truncation. |
| `tests/tool-abort.test.ts` | 156 | `serverExecute` abort, timeout and question bypass. |
| `tests/tool-heal.test.ts` | 190 | whitehead-incident heal pins; `validateToolArguments` end to end; `bareQuestionTools` wiring. |
| `tests/tool-parts.test.ts` | 478 | display parse seam (`parseQuizInput`, `parseAskInput`, `parseProbeDoneInput`, `parseExplainInput`) and LaTeX escape restoration. |
| `tests/tool-toggles-bridge.test.ts` | 103 | tool-toggle bridge for teacher and prober agents. |
| `tests/tooltip-mechanism.test.tsx` | 68 | `hintText` and `Hint` SSR. |
| `tests/usage.test.ts` | 114 | cost folds and usage appends against the real `chatStore` and `graphStore` in default `data/`. |
| `tests/verify-release.test.ts` | 475 | release gate pure functions, workflow wiring from YAML, and CLI runs against a temp workspace. |
| `tests/web-search.test.ts` | 333 | keyless search behavior, the web fetch protocol gate, and the researcher loop. |
| `tests/web-subscription-client.test.tsx` | 99 | web subscription client with `window.open` and fetch stubs. |
| `tests/web-subscription-payload.test.ts` | 21 | spawns `scripts/build-server.mjs` against synthetic directories and asserts it refuses credential files. |
| `tests/web-subscriptions.test.ts` | 140 | web subscription owner, HTTP controls and device actions. |
| `tests/zero-keys.test.tsx` | 165 | SSR of the setup CTA and keys body. |
| `tests/plan-window.test.tsx` | 169 | Plan marginalia/window rendering from the latest tree and statuses. |
| `tests/render-markdown.test.tsx` | 446 | Markdown rendering snapshots across blocks, math and escaping. |
| `tests/render-plan-block.test.tsx` | 286 | Plan-block rendering, wrapping and geometry. |
| `tests/tool-content-interaction.test.tsx` | 78 | Interactive tool-card behavior. |
| `tests/tool-content-presentation.test.tsx` | 164 | Tool-content rendering fixtures, escaping and regressions. |
| `tests/turn-liveness.test.ts` | 71 | Turn liveness registry, TTL and double-begin refusal. |
| `tests/turn-recovery.test.ts` | 90 | Turn settlement/recovery seams. |
| `tests/helpers/custom-provider-auth.ts` | 10 | Shared custom-provider auth fixture. |
| `tests/helpers/custom-provider-crash.ts` | 56 | Child-process crash fixture for custom-provider restart tests. |

Cross-cutting test findings:

- The largest integration suites are `chat-flow` (1,744), `claude-code-stream` (1,051), `chatgpt-auth` (684), `chatgpt-connection-ui` (564), `render-markdown` (446), `smoke-file-paths`-adjacent UI suites, and the PDF/image suites.
- Timing-sensitive suites use 150 ms–8 s windows (`browser-service-readiness`, `chat-flow`, `jobs`, `extraction`, `claude-code-*`). Multi-process suites spawn real Node/tsx children but never provider CLIs.
- Several suites replace module-global seams (`setTurnRunner`, `setJobRespawn`, `globalThis.fetch`, `process.send/connected`, extraction registry, headless/model overrides) and restore them in `after`/`finally`.
- `completion.ts` is a shared helper, not a test file; `tests/helpers/**` are fixtures. `tests/skills/**` are Python unittest files for the bundled skill, not part of the Node suite.

### 5.11 `docs/`, `skills/` and root docs (41 text paths)

| Path | Lines | Role |
|---|---:|---|
| `docs/architecture.md` | 577 | Canonical architecture spec (as-built, audited 2026-09-18; pre-audit archive). Design principles, layer rules, turn protocol, graph invariants, API rulings. |
| `docs/archive/architecture-2026-09-08.md` | 127 | Pre-audit spec archive; history only. |
| `docs/vision.md` | 286 | Product reasoning. |
| `docs/development.md` | 200 | Commands, environment, data dirs, desktop workflows. |
| `docs/compaction-accounting.md` | 95 | Compaction budget accounting. |
| `docs/custom-providers.md` | 133 | Custom OpenAI-compatible provider flows. |
| `docs/desktop-release.md` | 98 | Desktop packaging/release narrative. |
| `docs/keyboard.md` | 105 | Keyboard shortcut documentation. |
| `docs/pi-engine-swap.md` | 278 | The pi-ai/pi-agent-core engine swap rationale. |
| `docs/plan.md` | 54 | Plan-tree design notes. |
| `docs/probe-teach-split.md` | 183 | Probe/teach split design. |
| `docs/release-0.3.md` | 69 | Release 0.3 narrative. |
| `docs/teaching-methodology.md` | 97 | Teaching methodology notes. |
| `docs/tool-content-recovery.md` | 63 | Tool-content recovery design. |
| `skills/learnharness/SKILL.md` | 160 | Agent-facing skill definition. |
| `skills/learnharness/references/data-format.md` | 233 | Data format reference for skill consumers. |
| `skills/learnharness/scripts/_data.py` | 124 | Skill data helpers. |
| `skills/learnharness/scripts/graph.py` | 282 | Skill graph queries. |
| `skills/learnharness/scripts/sessions.py` | 466 | Skill session queries. |
| `skills/learnharness/LICENSE` | 661 | AGPL-3.0 for the bundled skill. |
| `README.md` | 83 | Storefront + dev commands. |
| `AGENTS.md` | 15 | Agent instructions (generated Next.js block + no-guessing). |
| `LICENSE` | 661 | AGPL-3.0 verbatim. |

### 5.12 Fixtures and runtime assets

| Group | Path | Kind | Lines / Size | Role |
|---|---|---:|---:|---|
| Claude Code fixtures | `tests/fixtures/claude-code/fake-claude.mjs` | script | 148 | Fake CLI child for harness/stream tests. |
|  | `tests/fixtures/claude-code/{signed-out,text,tool}.jsonl` | jsonl | 4/11/26 | Recorded CLI scenarios. |
| Golden graph fixtures | `tests/fixtures/golden-data/graph/*` | jsonl/json | 8–1,489 | Expected merge snapshots. |
| Golden chat/jobs/settings fixtures | `tests/fixtures/golden-data/{chats,jobs,settings.json}` | json | 34–6,660 | Expected persisted shapes. |
| PDF fixtures | `tests/fixtures/sample-3page.pdf`, `not-a-pdf.txt` | pdf/txt | 54/1 | PDF pipeline tests. |
| Tool rendering fixtures | `tests/fixtures/tool-rendering/*-regressions.json` | json | 19–135 | Tool display escaping regressions. |
| Skills tests | `tests/skills/*` | py | 100–466 | Python unit tests for the bundled skill. |
| Public fonts | `public/fonts/OFL.txt`, `public/fonts/cmunbx.ttf` | text/ttf | 103 / 221,904 B | OFL font license + font file. |
| Public runtime | `public/siwc/chatgpt-logo-white.svg`, `public/worklets/pcm-capture.js` | svg/js | 5 / 55 | Logo asset and PCM worklet. |
| Build assets | `build/entitlements.mac.plist`, `build/icon-flat.svg`, `build/icon.png`, `build/icon.icns`, `build/icon.ico`, `build/icon.icon/*`, `build/background*.png` | plist/svg/png/ico | 21/20/18,074/1,496,623/18,529/9 | Packager artwork + entitlements. |
| GitHub | `.github/ISSUE_TEMPLATE/*.yml`, `.github/workflows/{ci,release,notify-website}.yml` | yml | 1–277 | Issue templates + CI/release/notify workflows. |

Binary assets (PNG/SVG font/ICO/ICNS data) are inspected as assets, not line-covered: `docs/assets/*.{png,svg}`, `build/*` binaries, `public/fonts/cmunbx.ttf`, `build/icon.*`.

### 5.13 Summary of remaining coverage classes

- 10 tracked paths are binary or data assets and are classified separately, not line-covered.
- `package-lock.json` (18,278 lines) is generated metadata.
- 42 top-level paths are configuration/assets/docs listed in §5.1–5.12 and were read as text.
- Tests live in §5.10; fixtures in §5.12.

## 6. Robustness and failure containment

Static audit verdict, per layer (statements are code-read, not runtime-verified):

- **Pure layers.** Validators return structured failures instead of throwing (`tool-execute.ts` maps `invalidInputResult` to a structured `isError`; `question-core.ts` separates quiz/ask/explain option problems; `input-events.ts` rejects blank text and dangling dismissals). Guards bound resource use: 30 s tool guard + 250 ms cooperative abort grace, 50 KiB output caps, 2 MiB grep scan/binary skips, 5 s background-job deadlines, 3-slot background LLM semaphore, turn TTL 30 min, web fetch 30 s, PDF download 60 s, PDF extraction 24 KiB output cap.
- **Unverified-by-audit runtime limits.** Image worker resize has **no** worker timeout or `AbortSignal`; a hung worker never falls back (agent report). Deepgram token mint `fetch` has no `AbortSignal`/timeout; token responses lack `Cache-Control: no-store` (app-api report). Grep regex is synchronous and can block the event loop beyond its timeout (agent report).
- **LLM failure handling.** Refusal envelopes (`models_not_configured`, `provider_key_missing`) returned as structured 503s; engine build failure; turn start failure `{error:"Failed to start the turn"}`; background usage excludes aborted/unadmitted turns; provider event logging swallows IO errors and caps at 20 MiB with a type marker.
- **Compaction.** Structural gate before any write; poses terminate runs so compaction never touches a live run; overflow recovery; summarizer failure paths; `NODE_ENV==="test"` skips the kick.
- **Storage.** Atomic writes (auth: temp 0600 + fsync + rename + dir fsync; chats: delegated atomic replace) vs documented-but-unimplemented chat save tmp/rename. Append-only graph JSONL with format stamp. Read-modify-write sections have no lock → concurrent PUT loss noted.
- **SSE / streaming.** Only two streaming routes; full-partial replaces not delta-concatenation; EOF is not success; cancellation removes the subscriber but not the turn; no replay (resync via refetch); client callback exceptions isolated and logged.
- **Desktop / capability.** Capability header injection strips prior spellings and is timing-safe, secret ≥64 chars, random 32-byte; server gate is proxy-level; desktop-mode-only secret vs browser-only open design.
- **Error mapping.** Routes map their own known validation errors; store/IO and parsing edge cases (JSON `null` handling, `await req.json().catch(() => null)`) are explicit findings.

## 7. Known stale comments and contract mismatches

Findings where comments or doc prose disagree with executable code (from core, agent, app-api and platform reports):

1. `src/core/graph.ts` — comments call it pure/deterministic while it imports `node:crypto` and uses current time.
2. `src/core/clusters.ts` + barrel comment — "heavy Louvain dependencies" is stale; the file imports none.
3. `src/core/value-debris.ts` — period stripping implemented but absent from the descriptive comment.
4. `src/core/plan-tree.ts` — legacy mutation/version-increment header; only whole-tree create remains.
5. `src/core/plan-blocks.ts` — snapshot reflects end-of-turn transcript/tree, not historical replay at the plan call.
6. `src/core/view.ts` / `phases.ts` — failed-generation suppression asymmetries and legacy view/native success helper differences.
7. `src/core/settings.ts` — some comments describe optional fields that the actual v1 delta requires; refusal envelopes are authoritative.
8. `src/agent/prompts/README.md` — stale: says voice lives in base, zod schemas, two agents; actual: shared voice fragment, TypeBox, three agents.
9. `src/agent/prompts/prober/10-probe-doctrine.md` — stale tool names (`quiz`/`explain`) vs registry (`probe`/`recall`).
10. `src/agent/prompts/teacher/*` — stale mechanics: mandates quiz even when free-recall registry can hold only explain; tool description's 5–15 node recommendation vs prompt's no-ceiling rule; PDF ownership split.
11. `src/agent/provider-events.ts` — enable gate is any nonempty env value, not literal `1` as documented.
12. `src/agent/subagents/bg-llm-semaphore.ts` / image resize — comment claims vs enforcement (background cap comments must be checked against callers; worker has no timeout).
13. `app/api/graph/render-settings` — comments promise `{settings}` envelopes; code returns bare object/null.
14. `app/api/settings/[section]` — header lists nine sections, omits `claudeCode`; raw dynamic lookup lets prototype names reach parsers.
15. `app/api/settings/prompts` — "BOTH agents" comment; response omits `practice`.
16. `app/api/activity/abort` — comment says turn failures mirror job semantics including `not_found`; `abortTurn` only yields `not_running` and the route maps to `409`.
17. `app/api/models` — comment says "static: no network"; route awaits `refreshConnectionCatalog`.
18. `app/api/*` — JSON `null` handling paths that yield `500` instead of `400` (chat, chats, steer, coverage/extract, chat-handler).
19. `electron/*`, `scripts/verify-release.ts` — stale wording: "asar-only shell", "exactly the way shell does", "read-only token", "kill-before-install cannot block boot", smoke-server "exactly the way shell does" mismatch, updater catch/log resilience claims.

Every item above was judged from comments vs read code; none were proven wrong by execution.

## 8. Verification and coverage boundaries

- Baseline: 695 tracked paths at `6356d73`, split into text and binary classifications; 10 binaries (PNG/SVG/tTF data assets).
- Evidence files: per-layer coverage TSVs (`core-`, `agent-`, `serverstore-`, `ui-am-`, `ui-rest-`, `platform-`, `tests-am-`, `tests-nz-`, `tests-a-`(archived), `docsx-`, `fixturesx-`, `app-api-`, `app-pages-`) plus `baseline.json` and the progress files.
- Reconciliation rule applied: a path counts as covered only when its Git blob, Python `splitlines()` line count, and read-range union `1..N` all match the ledger, with `complete` status; binaries use `N/A` ranges.
- Scope-count resolution: `app/api/**` contains **35** tracked files (not 36); `app/pages` + `tsconfig` covered 8/8; both app subagent ledgers (`app-api-*`, `app-pages-*`) now record `complete` rows.
- Final expected state after this audit: all 695 paths covered under the above method; final cross-ledger reconciliation and semantic cross-check of high-impact findings remain on the coordinator.
- What verification does **not** cover: semantic comprehension, runtime behaviour, provider calls, builds, tests, rendering, package builds, login flows, update installs.

## 9. Final state and next steps

- Deliverables pending in repo: `docs/codebase-map.md` (this file), compact `AGENTS.md` additions, commit + push to `origin exp-0.4.1`.
- Coverage status: 18 paths still missing a canonical row at the last reconcile (`app/api/**` remainder + two prior classes); both app subagents have now closed, so the final 695-path reconcile is the remaining coverage task.
- Synthesis inputs: the audit reports plus docsx/fixturesx ledgers and `baseline.json`, read through last line with exact ranges.


## 10. Complete tracked-path appendix (every audited path)

The group tables in §§5.1–5.10 carry deep per-file roles. The tables in the following groups close the inventory by listing every tracked path that the deep tables did not otherwise name, with its Python `splitlines()` line count at the pinned commit. Rows here are inventory-level; the group tables above are authoritative for behavior.

## 11. Appendix groups: remaining tracked paths

### .github/ISSUE_TEMPLATE
| `.github/ISSUE_TEMPLATE/bug_report.yml` | 67 |
| `.github/ISSUE_TEMPLATE/config.yml` | 1 |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | 17 |
| `.github/ISSUE_TEMPLATE/question.yml` | 15 |

### .github/workflows
| `.github/workflows/ci.yml` | 69 |
| `.github/workflows/notify-website.yml` | 49 |
| `.github/workflows/release.yml` | 277 |

### build/icon.icon
| `build/icon.icon/Assets/lh_0 2.svg` | 9 |
| `build/icon.icon/Assets/lh_1 2.svg` | 9 |
| `build/icon.icon/Assets/lh_2 2.svg` | 9 |
| `build/icon.icon/icon.json` | 37 |

### components/abort-turn-dialog.tsx
| `components/abort-turn-dialog.tsx` | 144 |

### components/ai-elements
| `components/ai-elements/conversation.tsx` | 168 |
| `components/ai-elements/message.tsx` | 424 |
| `components/ai-elements/reasoning.tsx` | 221 |
| `components/ai-elements/shimmer.tsx` | 77 |

### components/answered-card.tsx
| `components/answered-card.tsx` | 236 |

### components/artifacts
| `components/artifacts/demo-card.tsx` | 280 |
| `components/artifacts/dispatch-card.tsx` | 118 |
| `components/artifacts/download.ts` | 32 |
| `components/artifacts/index.ts` | 53 |
| `components/artifacts/invert-disc.tsx` | 23 |
| `components/artifacts/job-card.tsx` | 119 |
| `components/artifacts/live-tool-card.tsx` | 65 |
| `components/artifacts/probe-done-card.tsx` | 71 |
| `components/artifacts/steer-card.tsx` | 128 |
| `components/artifacts/svg-image.tsx` | 37 |
| `components/artifacts/tool-call-card.tsx` | 120 |
| `components/artifacts/visual-card.tsx` | 164 |

### components/attach-files-button.tsx
| `components/attach-files-button.tsx` | 78 |

### components/backdrop-dismiss.ts
| `components/backdrop-dismiss.ts` | 48 |

### components/braille-spinner.tsx
| `components/braille-spinner.tsx` | 68 |

### components/cluster-geometry.ts
| `components/cluster-geometry.ts` | 19 |

### components/compaction-divider.tsx
| `components/compaction-divider.tsx` | 48 |

### components/composer-actions.tsx
| `components/composer-actions.tsx` | 56 |

### components/composer.tsx
| `components/composer.tsx` | 167 |

### components/confidence-rail.tsx
| `components/confidence-rail.tsx` | 61 |

### components/delete-node-dialog.tsx
| `components/delete-node-dialog.tsx` | 233 |

### components/delete-session-dialog.tsx
| `components/delete-session-dialog.tsx` | 242 |

### components/dictation-language.tsx
| `components/dictation-language.tsx` | 108 |

### components/dictation-preference.ts
| `components/dictation-preference.ts` | 132 |

### components/dictation-state.ts
| `components/dictation-state.ts` | 25 |

### components/dock-height.ts
| `components/dock-height.ts` | 157 |

### components/dock-state-key.ts
| `components/dock-state-key.ts` | 18 |

### components/enter-submits.ts
| `components/enter-submits.ts` | 78 |

### components/extraction-coverage.tsx
| `components/extraction-coverage.tsx` | 407 |

### components/field-cycle.ts
| `components/field-cycle.ts` | 36 |

### components/file-path-chip.tsx
| `components/file-path-chip.tsx` | 62 |

### components/file-path-drop-zone.tsx
| `components/file-path-drop-zone.tsx` | 106 |

### components/focus-hygiene.ts
| `components/focus-hygiene.ts` | 32 |

### components/graph-context-card.tsx
| `components/graph-context-card.tsx` | 63 |

### components/home.tsx
| `components/home.tsx` | 338 |

### components/jobs-context.ts
| `components/jobs-context.ts` | 18 |

### components/keyboard-shortcuts.tsx
| `components/keyboard-shortcuts.tsx` | 200 |

### components/latex-glyph.tsx
| `components/latex-glyph.tsx` | 53 |

### components/lh-mark.tsx
| `components/lh-mark.tsx` | 42 |

### components/menu-shell.tsx
| `components/menu-shell.tsx` | 260 |

### components/mermaid-error.tsx
| `components/mermaid-error.tsx` | 44 |

### components/mermaid-render.ts
| `components/mermaid-render.ts` | 42 |

### components/minimal-home.tsx
| `components/minimal-home.tsx` | 248 |

### components/model-catalog.ts
| `components/model-catalog.ts` | 54 |

### components/model-picker.tsx
| `components/model-picker.tsx` | 376 |

### components/new-session.tsx
| `components/new-session.tsx` | 388 |

### components/notes-import.tsx
| `components/notes-import.tsx` | 125 |

### components/opening-prompt.ts
| `components/opening-prompt.ts` | 59 |

### components/pan-zoom.ts
| `components/pan-zoom.ts` | 55 |

### components/path-input-dom.ts
| `components/path-input-dom.ts` | 257 |

### components/path-input.tsx
| `components/path-input.tsx` | 303 |

### components/phase-divider.tsx
| `components/phase-divider.tsx` | 93 |

### components/plan-block.tsx
| `components/plan-block.tsx` | 994 |

### components/plan-window.tsx
| `components/plan-window.tsx` | 65 |

### components/popover-dismiss.ts
| `components/popover-dismiss.ts` | 38 |

### components/practice-cards.tsx
| `components/practice-cards.tsx` | 298 |

### components/practice-dock.tsx
| `components/practice-dock.tsx` | 173 |

### components/question-dock.tsx
| `components/question-dock.tsx` | 926 |

### components/queued-steers.tsx
| `components/queued-steers.tsx` | 36 |

### components/reading-thinking.tsx
| `components/reading-thinking.tsx` | 103 |

### components/server-events.tsx
| `components/server-events.tsx` | 158 |

### components/session-find-dom.ts
| `components/session-find-dom.ts` | 156 |

### components/session-find.tsx
| `components/session-find.tsx` | 208 |

### components/session-navigation.tsx
| `components/session-navigation.tsx` | 110 |

### components/session-overlay.tsx
| `components/session-overlay.tsx` | 337 |

### components/session.ts
| `components/session.ts` | 152 |

### components/settings
| `components/settings/appearance-section.tsx` | 421 |
| `components/settings/appearance.tsx` | 185 |
| `components/settings/chatgpt-connection.tsx` | 352 |
| `components/settings/claude-code-status.tsx` | 117 |
| `components/settings/connection-controls.tsx` | 46 |
| `components/settings/controls.tsx` | 258 |
| `components/settings/keyboard-section.tsx` | 170 |
| `components/settings/model-menu.tsx` | 385 |
| `components/settings/search-menu-list.tsx` | 102 |
| `components/settings/study-time-section.tsx` | 61 |
| `components/settings/subscription-client.ts` | 77 |
| `components/settings/subscription-connections.tsx` | 141 |
| `components/settings/update-settings.tsx` | 113 |

### components/settings-signal.ts
| `components/settings-signal.ts` | 50 |

### components/setup-cta.tsx
| `components/setup-cta.tsx` | 115 |

### components/setup-dialog.tsx
| `components/setup-dialog.tsx` | 633 |

### components/sidebar.tsx
| `components/sidebar.tsx` | 957 |

### components/start-session.ts
| `components/start-session.ts` | 34 |

### components/stats-bar.tsx
| `components/stats-bar.tsx` | 221 |

### components/study-time-overlay.tsx
| `components/study-time-overlay.tsx` | 323 |

### components/study-tracker.ts
| `components/study-tracker.ts` | 177 |

### components/thinking-block.tsx
| `components/thinking-block.tsx` | 135 |

### components/thinking-default.ts
| `components/thinking-default.ts` | 55 |

### components/top-bar.tsx
| `components/top-bar.tsx` | 62 |

### components/ui
| `components/ui/button-group.tsx` | 83 |
| `components/ui/button.tsx` | 64 |
| `components/ui/collapsible.tsx` | 33 |
| `components/ui/glyph-mark.tsx` | 50 |
| `components/ui/hint.tsx` | 55 |
| `components/ui/input.tsx` | 21 |
| `components/ui/separator.tsx` | 28 |
| `components/ui/textarea.tsx` | 18 |
| `components/ui/tooltip.tsx` | 76 |

### components/update-banner.tsx
| `components/update-banner.tsx` | 37 |

### components/usage-format.ts
| `components/usage-format.ts` | 39 |

### components/use-study-tracker.ts
| `components/use-study-tracker.ts` | 40 |

### docs/assets
| `docs/assets/lh_banner_dark.svg` | 37 |
| `docs/assets/lh_banner_light.svg` | 38 |

### lib/utils.ts
| `lib/utils.ts` | 6 |

### src/agent
| `src/agent/image-processing/convert.d.mts` | 1 |
| `src/agent/image-processing/mime.d.mts` | 3 |
| `src/agent/image-processing/resize-core.d.mts` | 10 |
| `src/agent/prompts/practice/00-base.md` | 33 |
| `src/agent/prompts/practice/10-doctrine.md` | 141 |
| `src/agent/prompts/shared/10-voice.md` | 12 |
| `src/agent/prompts/shared/15-accuracy.md` | 3 |
| `src/agent/prompts/shared/16-mental-model.md` | 5 |
| `src/agent/prompts/shared/20-question-tools.md` | 28 |
| `src/agent/prompts/shared/25-confidence.md` | 11 |
| `src/agent/prompts/shared/30-learner-files.md` | 3 |
| `src/agent/prompts/shared/40-formatting.md` | 7 |
| `src/agent/prompts/teacher/05-method.md` | 44 |
| `src/agent/prompts/teacher/10-planning.md` | 46 |
| `src/agent/prompts/teacher/20-teaching.md` | 33 |
| `src/agent/prompts/teacher/28-predictions.md` | 22 |
| `src/agent/prompts/teacher/30-question-principles.md` | 11 |
| `src/agent/prompts/teacher/40-jobs.md` | 16 |
| `src/agent/prompts/teacher/50-demos.md` | 20 |

### tests/fixtures
| `tests/fixtures/claude-code/signed-out.jsonl` | 4 |
| `tests/fixtures/claude-code/text.jsonl` | 11 |
| `tests/fixtures/claude-code/tool.jsonl` | 26 |
| `tests/fixtures/golden-data/README.md` | 47 |
| `tests/fixtures/golden-data/chats/chat_mv27rrra_feff23b6.json` | 4083 |
| `tests/fixtures/golden-data/chats/chat_mv293wv5_10656952.json` | 660 |
| `tests/fixtures/golden-data/graph/chains.jsonl` | 173 |
| `tests/fixtures/golden-data/graph/coverage.jsonl` | 105 |
| `tests/fixtures/golden-data/graph/nodes.jsonl` | 298 |
| `tests/fixtures/golden-data/graph/positions.json` | 1489 |
| `tests/fixtures/golden-data/graph/render-settings.json` | 29 |
| `tests/fixtures/golden-data/graph/sessions.jsonl` | 8 |
| `tests/fixtures/golden-data/graph/sources.json` | 517 |
| `tests/fixtures/golden-data/jobs/job_murepie2_9d791321.json` | 32 |
| `tests/fixtures/golden-data/jobs/job_mux5xn7v_b49f3458.json` | 14 |
| `tests/fixtures/golden-data/jobs/job_mv282vv0_e7b89c9b.json` | 26 |
| `tests/fixtures/golden-data/jobs/job_mv28p0fs_0a16b76e.json` | 30 |
| `tests/fixtures/golden-data/jobs/job_mv28tfii_2a54290a.json` | 18 |
| `tests/fixtures/golden-data/settings.json` | 34 |
| `tests/fixtures/not-a-pdf.txt` | 1 |
| `tests/fixtures/tool-rendering/document-percent-regressions.json` | 90 |
| `tests/fixtures/tool-rendering/matrix-regressions.json` | 135 |
| `tests/fixtures/tool-rendering/mixed-escaping-regressions.json` | 19 |

### tests/skills
| `tests/skills/README.md` | 18 |
| `tests/skills/test_data_helpers.py` | 169 |
| `tests/skills/test_graph.py` | 351 |
| `tests/skills/test_sessions.py` | 393 |
| `tests/skills/test_skill.py` | 100 |

### 12.1 Coverage ledger notes

- The tests tables (§5.10) list all 227 direct test modules plus the two `tests/helpers/` modules; fixtures (§5.12) cover the JSONL/JSON/PDF/Markdown asset trees.
- The only root-level source module not under `src/` or `app/` is `lib/utils.ts` (`cn()` helper, 6 lines).
- The two remaining top-level directories not otherwise covered above are `.github/` (issue templates and workflows) and `build/icon.icon/` (Icon Composer asset metadata); both are CI/artifact configuration, not runtime code.

