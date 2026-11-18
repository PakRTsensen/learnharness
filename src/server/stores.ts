/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { sourceOrganizationStore } from "../store/source-organization.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { studyStore } from "../store/study.ts";
import { themeStore } from "../store/themes.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import { configureWorkerRequestAdmission } from "../agent/worker-request-admission.ts";
import { DEPLOYMENT_MODE, DEPLOYMENT_SELECTION } from "../../config.ts";

/**
 * HARD REFUSAL IN MULTI-USER WEB (per-user-accounts phase 1).
 *
 * This module is the SINGLE-ACCOUNT composition root: one shared data/auth
 * profile per process. In multiuser-web every account has its own worker
 * process and its own LH_DATA_DIR/LH_AUTH_FILE, so loading these adapters in
 * the web process would hand one process the whole instance's records.
 *
 * The barrel (`src/server/index.ts`) re-exports this module statically, so any
 * route importing the barrel loads it. Refusing here — at module load, before
 * the shared store constants are used — turns an accidental import into a loud
 * failure instead of a silent shared-storage fallback. Routing in multiuser-web
 * goes through the account relay (src/server/account-relay.ts) and its
 * controller transport (phase 3).
 *
 * REFUSED SELECTION: an invalid `LH_DEPLOYMENT_MODE` is not a mode. It is
 * refused here as well, because a route import can load this module without
 * instrumentation.ts having run first.
 *
 * NEXT_PHASE exception: `next build` imports route modules while collecting page
 * data in the BUILD environment. No store is read then, and a build host may
 * legitimately export LH_DEPLOYMENT_MODE=multiuser-web for its compose file.
 * The runtime refusal (and the readiness gate in instrumentation.ts) is what
 * protects a running server; the build phase gets no free pass beyond that.
 */
const buildPhase = process.env.NEXT_PHASE === "phase-production-build";
const selection = DEPLOYMENT_SELECTION;
if (!selection.ok && !buildPhase) {
	throw new Error(`[stores] Refusing to load the shared single-account composition root: ${selection.error}`);
}
if (DEPLOYMENT_MODE === "multiuser-web" && !buildPhase) {
	throw new Error(
		"[stores] The shared single-account composition root must not load in multiuser-web. " +
			"Use the account relay (src/server/account-relay.ts); account stores live in per-account workers.",
	);
}

/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	chatStore,
	graphStore,
	sourceOrganizationStore,
	jobStore,
	settingsStore,
	studyStore,
	themeStore,
};

export type Stores = typeof stores;

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}

// Runtime policy is supplied at the composition root, never imported by agents.
configureWorkerRequestAdmission(() => effectiveSettings().agent.workerRequestConcurrency);

// Boot: register the custom endpoint (when configured) into piModels(); the
// POST /api/custom-provider route re-syncs after every connect.
syncCustomProvider();
