/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 *
 * MULTIUSER GATE (per-user accounts, Phase 1): this module is the
 * single-account composition root. In multiuser-web it must not exist in the
 * web process at all — account data belongs to an isolated worker. Importing
 * it there is a deployment bug, so it fails loudly instead of exposing one
 * shared store set to every signed-in user.
 */

import { deploymentMode } from "../runtime/deployment-mode.ts";
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

if (deploymentMode() === "multiuser-web") {
	throw new Error(
		"Global account stores are unavailable in multiuser-web. Account data must be served by an isolated account worker.",
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
