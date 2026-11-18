<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.** If anything is ambiguous — naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording — STOP and ask with the ask-user-question tool before proceeding. If you are "a little unsure," you are unsure: ask. A wrong guess is far more expensive than a question. Ask early, ask specific, one question per call.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement. Implementation should be mechanical execution of an approved plan — not interpretation.

# Repository map and constraints

- LearnHarness is a Next.js 16 app plus an Electron desktop host. CI/release use **Node 26** and npm with `package-lock.json`; use `npm ci`, not another package manager.
- `app/` is HTTP transport, `components/` browser UI, `src/server/` composition/services, `src/core/` pure domain, `src/store/` filesystem adapters, `src/agent/` agents/tools, `electron/` desktop shell. Full setup/debugging: `docs/development.md`; runtime/storage: `docs/architecture.md`.
- `eslint.config.mjs` enforces the import law, not style: `components/` may import only `@/src/core`; `app/` only `@/src/core` and `@/src/server`, except `app/_account/**` which uses only `@/src/core` and the narrow `@/src/server/account-entry.ts`; `src/core/` never imports `src/{agent,server,store}`; `src/agent/` never imports `src/{server,store}`. Dependencies must arrive through injected ports/factories.
- Storage is synchronous JSON/JSONL under `LH_DATA_DIR`; `auth.json` is separate (`LH_AUTH_FILE`). Use **one server owner per data/auth profile**; do not add cross-process writers without an approved design.
- The desktop composition root is separate. Multi-user work must preserve desktop single-user behavior.

# Setup and checks

```sh
npm ci
npm run plugins:setup   # required after a fresh checkout; rerun after API/lockfile changes
npm run dev             # stages core plugins, then next dev on localhost:3000
```

- Never run raw `next dev` / `next build`: they skip core-plugin staging. Restart the server after editing core plugin sources; there is no plugin hot reload.
- CI order is `npm run typecheck`, `npm test`, `npm run lint`; use `npm run build` for production/standalone changes.
- Focused Node test: `NODE_ENV=test npx tsx --test tests/<name>.test.ts` (same for `.test.tsx`). Some renderer suites must run under Electron; see `docs/development.md#checks` and `docs/desktop-release.md`.
- Python skill tests are separate: `python3 -B -m unittest discover -s tests/skills -v`.
- Tests use fake providers/transports and need no paid keys or sign-in. Do not hand-edit `tests/fixtures/golden-data/` to make a test pass.

# Safe local work

Use a disposable data root and a separate empty auth file for manual testing. Never commit `data/`, `auth.json`, `.env*`, or provider credentials. `npm run dev:fresh` starts a keyless fresh instance on port 3005. Do not point tests at a live data/auth profile.

# Clerk per-user accounts workflow

- Work on branch `clerk` (base: `Experimental`). `origin` is the fork `PakRTsensen/learnharness`, not upstream `amosblomqvist/learnharness`. Commit on `clerk` and make the final push to `origin clerk` (create it on first push). Never push to `Experimental`, `main`, or upstream.
- Authoritative design: `docs/designs/per-user-accounts.md`. Review status and reading order: `docs/reviews/per-user-accounts/README.md`. Execution breakdown: `docs/reviews/per-user-accounts/EXECUTION_PLAN.md` (39 agents, strictly sequential). The design is currently **In Review, not approved**: Stage 7 findings are unresolved and Stages 8–9 have not run. Do not infer approval from the branch or docs; confirm explicit human approval before writing phase code.
- Implement one phase at a time, in order, using subagents; run implementation and testing sequentially rather than as parallel edits. Read the active phase's file list and current source first; the source tree is authoritative over old review reports.
- The design's per-phase **Resolution Step** is the gate. Do not start the next phase until a separate testing subagent reproduces that evidence and relevant checks pass. For isolation phases, kernel-enforced ownership/process evidence in the real Docker image is required; route-level `401`/`403` tests alone are insufficient.
- Phases 1–5 are security gates, not independent feature slices. Multi-user mode must be explicitly selected (`LH_DEPLOYMENT_MODE=multiuser-web` in the design), never inferred from Clerk variables; shared-storage fallback is prohibited.
- Hold commits and pushes until all phases pass their gates and the final full checks are green. The final push target is `origin clerk`; do not push to upstream.

# Web tools

- Context7 first for library, framework, and API documentation.
- Firecrawl for general web search and multi-page crawling.
- Playwright for interactive browser work: sign-in, forms, clicks, screenshots, and visual verification.
