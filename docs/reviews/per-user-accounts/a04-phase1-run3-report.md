# A04 Phase 1 Run 3 — Final Independent Test Report

**Date:** 2026-11-15  
**Final result time:** 2026-11-15T02:01:00+00:00 (full suite completed)  
**Agent:** A04, independent Phase 1 test run 3  
**Repository:** `/root/learnharness-code`  
**Branch / base commit:** `clerk` / `4143bc604ae0a6de8237318c2155f0493eef0f6d`  
**Verdict:** **GATE PASS — Phase 1 Resolution Step, prior D1–D5 regressions, and human-approved Option A findings #1–#4.**  
**Not a claim that multi-user support or the complete Phase 3 real-Docker isolation gate is complete.**

## 1. Scope and decision standard

This run reproduced the Phase 1 requirement in `docs/designs/per-user-accounts.md`:

> Run existing tests, typecheck, desktop payload tests, and the new readiness tests; confirm desktop retains its original local stores and multi-user web startup refuses global account stores or missing mount controls.

The selected human-approved **Option A** was tested against the current working-tree implementation, not only against the previous handoff:

1. Each non-account writable root must be UID-0-owned and have permission bits **exactly `0700`**.
2. The account root must be root-owned and grant the actual web UID/GID, **including supplementary groups**, no access.
3. Bind-mount aliases with the same **`device + sourceRoot`** pair must be rejected; distinct sources on one filesystem remain valid.
4. Mounted Docker sockets named **`docker.sock` and `docker.socket`** must be detected, including `/run/docker.socket`.

The run also checked valid and invalid deployment modes, explicit-mode selection, fail-closed startup, shared single-user/desktop stores, Clerk warnings, unchanged desktop payload, D1–D5, unavailable/malformed process `Groups`, and account-window identity rejection.

Historical entries D1–D5 were evaluated as follows:

- **D1/D1b:** the web identity is declared and cross-checked against the real process UID/GID; inaccessible roots are judged using the bits that identity receives; web identity in the account UID/GID window or a privileged web identity is refused.
- **D2:** controller and helper IPC endpoints cannot alias.
- **D3:** both legacy `LH_DATA_DIR` and `LH_AUTH_FILE` containment rules apply; the legacy parent `/data` remains valid.
- **D4:** relative legacy paths are refused; canonicalization defeats trailing-slash/`./` containment bypasses.
- **D5:** Clerk keys outside multiuser-web remain inert and produce a secret-free startup warning.

No new Phase 1 security defect was reproduced in this run.

## 2. Environment, constraints, and integrity

| Item | Value |
| --- | --- |
| Host | Linux, 1 CPU, approximately 4.9 GiB RAM |
| Host Node / npm | Node `v24.22.2`, npm `12.2.2` |
| tsx / ESLint | `v4.23.12` / `v9.39.5` |
| Docker | Client/server `29.9.3` |
| Readiness probe image | `node:26-bookworm-slim`, Node **`v26.13.1`** |
| Image observed digest | `node@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1` |
| Full suite | 430 test files, 22 sequential batches; maximum 20 files per process |
| Suite window | 2026-11-15T01:23:09+00:00 through 02:01:00+00:00 |

Host and CI/runtime version differences are **not hidden**: host unit checks used Node 24, whereas Docker readiness probes used Node 26. Tests were never run concurrently with TypeScript typecheck. Plain `npm test` was deliberately not used.

The working tree was already dirty with the Phase 1 uncommitted work at the beginning of this run. No source, configuration, test, or fixture was edited; no test was weakened, skipped, or removed; no fixture was changed. No commit or push was performed. Temporary scripts/probe files were confined to `/tmp/opencode/a04-run3/` and disposable `/tmp/opencode/lh-a04-run3-*` directories.

The originally referenced `/tmp/opencode/run-chunks.sh` was absent. A runner with the same sorted `tests/*.test.ts tests/*.test.tsx` file list and 20-file limit was therefore written outside the repository as `/tmp/opencode/a04-run3/run-chunks.sh`. Its output directory was confined to `/tmp/opencode/chunks`; no unrelated temporary data was deleted.

For non-root and Docker probes, the three runtime modules were copied read-only into `/tmp/opencode`. SHA-256 matched the repository files:

```text
65a9035446db0fafa9eae8d32387026f9287dbc8377148a261ffabfcf49f9a56  deployment-mode.ts
da6a33bec3362d70d0d1de34bd9ce81a830b4706177bc6316a2ae70a76f734a8  multiuser-config.ts
aa79e5f62938b34162c9f4f5ecd0aa00786f29c09f446c2a5b5e613297551828  readiness.ts
```

The parent-provided progress record `a04-phase1-run3-progress.md` was read before this report was produced. Its completed-check results agree with this report; its earlier in-progress suite status is superseded by the complete batch evidence below.

## 3. Required checks and Resolution Step

### 3.1 Typecheck, focused, desktop, lint

| Exact command | Outcome |
| --- | --- |
| `npm run typecheck` | **PASS**, exit 0. |
| `NODE_ENV=test npx tsx --test tests/deployment-mode.test.ts tests/deployment-composition.test.ts tests/desktop-payload.test.ts` | **PASS**, **75 tests, 75 pass**, 0 fail, cancelled, skipped, or todo; duration 28.509 s. |
| `npm run lint` | **PASS**, exit 0; **0 errors, 1 pre-existing warning**. |

The focused result consists of 62 deployment/readiness/composition tests and 9 desktop-payload tests; the subagent's earlier session memory with older counts was not treated as evidence for this run.

The remaining lint warning is unrelated and unchanged:

```text
/root/learnharness-code/tests/source-name-ui.test.tsx
  27:45  warning  Do not use `<head>` element. Use `<Head />` from `next/head` instead.
```

### 3.2 Mode selection, startup and composition-root behavior

The focused composition tests use fresh child processes and throwaway `LH_DATA_DIR`/`LH_AUTH_FILE`, with `NEXT_RUNTIME=nodejs` so instrumentation is not a meaningless no-op. Verified behavior:

| Scenario | Result |
| --- | --- |
| No explicit mode and no desktop markers | Selects `single-user`, not multi-user. |
| `LH_DESKTOP_SERVER=1` / `LH_DESKTOP_API_SECRET=...` | Selects desktop. |
| Explicit desktop/single-user/multiuser-web | Accepted according to the explicit selection. |
| Clerk keys alone | Still `single-user`; no mode inference from Clerk. |
| `LH_DEPLOYMENT_MODE=multiuser-webb` | Invalid selection is refused, not downgraded. |
| Desktop markers plus multiuser-web | Refused as contradictory. |
| Default and desktop relay | Same seven original stores: `chatStore`, `graphStore`, `jobStore`, `settingsStore`, `sourceOrganizationStore`, `studyStore`, `themeStore`. |
| Single-user instrumentation | Original in-process plugin path still runs. |
| Multiuser-web stores import | Refused; shared stores are not initialized. |
| Multiuser-web relay | Raises `AccountRelayUnavailableError`; no shared-store fallback. |
| Multiuser-web without all 11 resource limits and mount controls | Instrumentation exits 1, names every missing limit, and has no `[plugins]` line. |
| Invalid mode instrumentation/relay/stores | Refused through every one of those paths. |
| Build-only route import | Per current design, `NEXT_PHASE=phase-production-build` imports shared modules successfully. This remains the documented #6 boundary. |

The real startup probe for D5 used:

```sh
env -i PATH="$PATH" HOME="$T" NODE_ENV=test NODE_OPTIONS='' \
  NEXT_RUNTIME=nodejs LH_DATA_DIR="$T/data" LH_AUTH_FILE="$T/auth.json" \
  LH_IGNORE_ENV_KEYS=0 CLERK_SECRET_KEY=sk_test_A04RUN3_DUMMY \
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_A04RUN3_DUMMY \
  node --import tsx tests/helpers/composition-root-probe.ts instrumentation
```

It exited 0 with the warning `Clerk authentication is inactive in this profile`, never printed either supplied key value. Adding `LH_DEPLOYMENT_MODE=multiuser-web` caused a refusal, process exit 1, named all 11 missing resource limits, and did not initialize plugins.

The desktop payload suite passed **9/9**, including clean/idempotent payload creation, runtime/native assets, authoring documentation, no leaked `.env`, `.env.local`, `auth.json`, or data, and unchanged core/plugin fixture behavior. This directly satisfies the desktop-payload portion of the Phase 1 gate.

### 3.3 D1–D5 regression and path-identity evidence

All D1–D5 checks in the 62 deployment tests passed. Additional direct configuration probes returned refusal reasons for:

- `LH_WEB_GID=30005`: `LH_WEB_GID must lie outside the account GID window`.
- controller/helper set to the same `.sock`: `must be separate endpoints`.
- `LH_DATA_DIR` and `LH_AUTH_FILE` inside a canonicalized account root: both must be quarantined rather than reused as account data.

Root running with declared web UID 1000 was rejected by the real identity mismatch check:

```text
this process runs as uid 0 but LH_WEB_UID declares 1000;
the web identity must be the identity the server actually runs as
```

These are in addition to unit assertions for web-owned/web-writable roots, root UID/GID 0 detection, account-window UID detection, real host fail-closed behavior, canonicalization, credential redaction, absolute-path checks, and inherited Clerk warning behavior. **No prior D1–D5 regression was observed.**

## 4. Real Docker Node 26 probe evidence

### 4.1 Method and validity control

The final clean probe was:

```sh
cd /tmp/opencode
bash /tmp/opencode/a04-run3/docker-verify.sh
```

Its reusable helper calls the actual `inspectReadiness(env, currentProcessIdentity())`, so the real process UID/GID, `/proc/self/status` groups, `/proc/self/mountinfo`, root mount options, and root-directory `lstat` facts are inspected by the module itself. The aliases and socket cases use actual Docker bind mounts. UID/GID are real `1000:1000`; valid cases combine six root-owned mode-0700 directories on a genuine read-only container root.

| Probe command / case | Observed result | Verdict |
| --- | --- | --- |
| `docker run --rm --read-only --user 1000:1000 ... node:26-bookworm-slim node --experimental-strip-types .../docker-outcome.ts valid` | UID/GID 1000, groups `[1000]`; `ok:true` | **PASS** — valid control, proving the gate is not always-closed. |
| Same native probe with mode-0700 `accountRoot root:1001` made `root:1001 0770`, and `--group-add 1001` | Actual process groups `[1000,1001]`; `root-not-web-writable:accountRoot` and `account-root-sealed` fail; measured access bits `7` | **PASS** — #2 rejected the genuinely supplementary-group-writable root. |
| Native six-bind-alias probe: `src=<same>/accounts` mounted separately at `/a04/{accounts,registry,instance,staging,snapshots,private-work}` | `writable-mount-sources-distinct` failure names all six roots | **PASS** — #3; parser retained real source roots and detected common device/source pairing. |
| Real `/run/docker.socket` bind mount | `docker-socket-absent` fails | **PASS** — #4, through actual mount parsing and `inspectReadiness`, not only a synthetic boolean. |
| Real instance root `0755` and its `instance-keys.json` `0644` as UID 1000 | Kernel read returns `SECRET-INSTANCE-KEY`, while `root-private:instanceStateDir` fails with exactly-0700 requirement | **PASS** — #1 closed despite the actual OS permitting the read. |
| `parseProcessGroups("")` / identity with `groups:undefined` | `web-identity-matches-process` refuses | **PASS** — missing `Groups` fails closed. |
| `parseProcessGroups("Groups: malformed\n")` / identity with undefined groups | Same fail-closed identity refusal | **PASS** — malformed `Groups` fails closed, no later `.filter` exception in the proper parser-derived path. |
| Real UID/GID plus extra account-window group 30005 | `web-supplementary-groups` refuses `30005` | **PASS** — no account-window supplementary identity. |

A separate real Linux bind mount before the final container case yielded, for example, device `0:41` and an actual host-derived `sourceRoot`. Supplying those actual kernel values for all six designated roots made `evaluateReadiness` reject them, naming all six shared sources. The injected mount test controlled only the mount facts; UID/GID came from the actual process.

All five real Node 26 negative scenarios above fail closed while their independent valid controls pass. For #1, the kernel access difference is particularly important: this is not merely checking a config parser's response. For #2, the extra group was created by Docker (`--group-add 1001`), not invented only in configuration.

The short-term `dock.sock`-versus-`docker.sock` wording was checked against code and focal tests: the detector is `/\/docker\.sock(?:et)?$/`, and both Docker API socket spellings are covered. A generic unrelated `app.sock` remains negative. No claim is made that arbitrary filenames necessarily identify a Docker API socket.

### 4.2 Probe boundaries and discarded setup attempts

This is an independent, focused readiness probe using the current modules in a Node 26 image—not the full A13 test of the project image, account workers, cross-home attacks, symlink/hardlink attacks, IPC, helper launch, or a completed Docker deployment. A13 evidence is still required by the design.

Several probe-construction attempts were **not used as passing evidence**:

- A direct `setpriv` probe could not read package configuration beneath `/root` and spawned no tests. This triggered read-only copies with hashes checked against the source.
- A first host `test -r/-x` parent process reported access failure on a supplementary-group directory. This host-shell-specific negative OS result was not substituted for the final Docker `--group-add` evidence.
- An earlier helper had branch-label mismatches (`groupMode` versus labels). Those outputs were discarded and the corrected cases rerun.
- One deliberately valid control inadvertently still mounted `/run/docker.socket`, so it correctly failed `docker-socket-absent`; it was not mislabeled a valid pass. A clean valid control was rerun successfully.
- One malformed-group probe passed `NaN` instead of the parser's `undefined` result and raised `identity.groups.filter is not a function`. It was a defective helper input, not a real `/proc/self/status` outcome. It was discarded and replaced by the successful proper-parser malformed-string case above and the repository unit test.
- An image command ordering attempt tried to fetch `valid:latest`; this was a caller scripting mistake, not a repository error. The corrected commands above all executed the Node 26 image.
- The full suite continued throughout these probes; no failing run of a test suite was hidden or silently replaced.

## 5. Full suite — exact results for all 22 batches

The invocation for each offset was:

```sh
NODE_ENV=test npx tsx --test "${FILES[@]:offset:20}"
```

with `FILES` built using `ls tests/*.test.ts tests/*.test.tsx | sort`; the last batch has ten files. Prior outputs in `/tmp/opencode/chunks` were cleared before starting, and only that temporary output directory's contents were removed.

| Batch | Test files (1-based sorted range) | Exit | Tests | Pass | Fail | Cancelled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 01 | 1–20 | 0 | 220 | 219 | 0 | 0 |
| 02 | 21–40 | 0 | 246 | 246 | 0 | 0 |
| 03 | 41–60 | 0 | 239 | 239 | 0 | 0 |
| 04 | 61–80 | 0 | 195 | 195 | 0 | 0 |
| 05 | 81–100 | 0 | 302 | 302 | 0 | 0 |
| 06 | 101–120 | 0 | 273 | 273 | 0 | 0 |
| 07 | 121–140 | 0 | 252 | 252 | 0 | 0 |
| 08 | 141–160 | 0 | 248 | 248 | 0 | 0 |
| 09 | 161–180 | 0 | 315 | 315 | 0 | 0 |
| 10 | 181–200 | 0 | 244 | 244 | 0 | 0 |
| 11 | 201–220 | 0 | 262 | 262 | 0 | 0 |
| 12 | 221–240 | 0 | 247 | 247 | 0 | 0 |
| 13 | 241–260 | 0 | 173 | 173 | 0 | 0 |
| 14 | 261–280 | 0 | 150 | 150 | 0 | 0 |
| 15 | 281–300 | 0 | 326 | 326 | 0 | 0 |
| 16 | 301–320 | 0 | 317 | 317 | 0 | 0 |
| 17 | 321–340 | 0 | 285 | 285 | 0 | 0 |
| 18 | 341–360 | 0 | 370 | 370 | 0 | 0 |
| 19 | 361–380 | 0 | 294 | 291 | 0 | 0 |
| 20 | 381–400 | 0 | 200 | 200 | 0 | 0 |
| 21 | 401–420 | 0 | 215 | 215 | 0 | 0 |
| 22 | 421–430 | 0 | 144 | 144 | 0 | 0 |
| **Total** | **430 files / 22 batches** | **22/22 exit 0** | **5,517** | **5,513** | **0** | **0** |

The correct numerical reconciliation was parsed with Python from `summary.txt`: batches=22, exit_zero=22, tests=5517, pass=5513, fail=0, cancelled=0. **The remaining four are platform-conditional skips: one in batch 01, three in batch 19.** They are not hidden failures: e.g. Windows path/UNC and Windows rename-semantic tests are skipped on this Linux host.

During execution, one temporary commentary message mistakenly predicted 5,819/5,816 before all processes finished. It was immediately retracted in-session; it is **not** a suite result. The verified table above supersedes it. The earlier 5,511 full-suite count in old session memory is historical and was not used to judge this run.

Logs are retained in `/tmp/opencode/chunks/batch-01.log` through `batch-22.log`; aggregate exit/test results are in `/tmp/opencode/chunks/summary.txt`.

### 5.1 Known study-time environment flake

The official batch 20 passed, including:

```text
✔ summarizes one year of data (100 intervals a day) in under 100 ms
ℹ tests 200
ℹ pass 200
ℹ fail 0
ℹ cancelled 0
```

After the complete suite, a separate focused probe was run twice:

```sh
npx tsx --test tests/study-time.test.ts
NODE_ENV=test npx tsx --test tests/study-time.test.ts
```

Both reported **29 tests / 28 pass / 1 fail**, only the wall-clock assertion:

```text
AssertionError [ERR_ASSERTION]: took 173.3 ms
AssertionError [ERR_ASSERTION]: took 158.0 ms
```

This is the known environment-sensitive sub-100 ms assertion explicitly noted by the human. It passed within the full batch and failed the two independent focused timing runs; the host's wall-clock timing is therefore not stable enough to treat this assertion as deterministic. No source, timeout, fixture, or test was changed and no retries were made for reputation. This evidence does **not** show a Phase 1 functional regression: `src/core/` was untouched, and the pass-rate difference is the timing assertion alone. It is recorded as the known accepted environment flake rather than a blocker to this specific gate.

## 6. Deferred Option A boundaries #5–#7

`docs/docker.md` documents these boundaries for **A12/A13**, and this run does not silently mark them fixed:

1. **#5 Identity/path bounds:** the gate still leaves strict host/service identity bounds and legacy-data path handling for deployment controls and real-Docker validation. This report's checks are explicitly limited to non-root, outside-account-window identity collisions and `Groups` behavior described above.
2. **#6 `NEXT_PHASE` trust boundary:** the build-only shared-import exception remains a process-environment boundary. Preventing a running process from spoofing `phase-production-build` is not established here; the lifted build-phase behavior tested in composition is deliberate, not a claim of runtime hardening.
3. **#7 ACL and special permission bits:** POSIX ACL evaluation and setuid/setgid bits are not covered by the current injected-facts gate. This run's exact-0700 assertion checks ordinary owner/group/other bits; it does not resolve ACL or set-id concerns.

The current multi-user profile therefore remains preview-only and not usable for real users until subsequent phases close their own gates. The Option A choice fixes #1–#4 in Phase 1 and deliberately preserves #5–#7 for A12/A13; it is not authorization to treat A12/A13 as already passed.

## 7. Final verdict

| Gate element | Evidence | Verdict |
| --- | --- | --- |
| Resolution Step: modes/startup/composition | Valid/invalid mode, explicit-only multi-user, shared-store refusal, secret-free Clerk warning, disposable desktop/single-user stores | **PASS** |
| Prior D1–D5 | Focused regressions and real identity/containment/warning checks | **PASS; no regressions** |
| Option A #1: exact root-owned 0700 non-account roots | Invalid 0755 root and readable 0644 key are rejected; real UID 1000 kernel read demonstrates why | **PASS** |
| Option A #2: account-root and supplementary identities | Native Docker group `[1000,1001]` gives measured bits 7 and is rejected; account-window and missing/malformed group rejections | **PASS** |
| Option A #3: mount source uniqueness | Six genuine aliases rejected by device/sourceRoot; valid distinct sources accepted | **PASS** |
| Option A #4: Docker socket detection | Native `/run/docker.socket` and focused `.sock`/`.socket` coverage | **PASS** |
| Desktop payload | 9/9 passed unchanged in focused 75/75 | **PASS** |
| Typecheck/lint | Exit 0; lint has only known warning | **PASS** |
| Full suite | 430 files, 22 batches, 5,517 tests, 5,513 pass, 4 platform skips, no fail/cancel | **PASS** |
| Known study-time timing flake | Passed in batch; two independent post-suite focused runs measured 173.3/158.0 ms and failed only that known assertion | **Recorded; not hidden or repo-modified** |
| #5–#7 and complete A12/A13 isolation | Explicitly deferred; not established | **OUT OF SCOPE / FUTURE GATE** |

**FINAL PHASE 1 RUN-3 GATE: PASS.** The Resolution Step, Option A #1–#4, D1–D5 non-regression, typecheck, focused tests, lint, desktop payload checks, and full batched suite all support this verdict. No commit or push was performed.
