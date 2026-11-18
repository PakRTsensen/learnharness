/**
 * Deployment-mode dispatch (per-user-accounts phase 1).
 *
 * Every Next entry shares this hook, so the composition root is chosen ONCE,
 * here, and never inferred per request:
 *
 *   desktop / single-user  the historical profile — initialize plugins in this
 *                          process exactly as before (unchanged behavior).
 *   multiuser-web          FAIL CLOSED. The readiness gate must pass or the
 *                          process exits before serving a single request; there
 *                          is no shared-storage fallback. Global plugin
 *                          initialization is deliberately skipped: plugins and
 *                          their storage belong to per-account workers (phase 3).
 *
 * Plugin failure in the single-user profiles still must not prevent access to
 * existing learning data or teaching/practice.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const { DEPLOYMENT_MODE, DEPLOYMENT_SELECTION } = await import("./config.ts");

	// A REFUSED SELECTION IS NOT A MODE. An invalid `LH_DEPLOYMENT_MODE` (a typo,
	// a retired value) must stop the process here, before any composition root
	// is chosen. Treating it as single-user would serve shared storage to an
	// operator who asked for per-account isolation.
	if (!DEPLOYMENT_SELECTION.ok) {
		console.error(`[deployment] REFUSING TO START: ${DEPLOYMENT_SELECTION.error}`);
		process.exit(1);
	}

	// Warnings are inert-but-suspicious configuration (e.g. Clerk keys outside
	// multiuser-web). They are secret-free by construction, and printing them
	// once at boot is the only chance an operator gets: nothing else in the
	// single-user/desktop path ever reads the selection.
	for (const warning of DEPLOYMENT_SELECTION.warnings) {
		console.warn(`[deployment] ${warning}`);
	}

	if (DEPLOYMENT_MODE === "multiuser-web") {
		// Loaded lazily so the single-user/desktop path pays nothing for it, and
		// so a multiuser-web process never pulls in the shared store adapters.
		const { startupRefusal } = await import("./src/runtime/readiness.ts");
		const refusal = startupRefusal();
		if (refusal) {
			console.error(refusal);
			// Refusing is the contract: the web process must not accept requests in a
			// deployment whose isolation prerequisites are unproven. Exiting is
			// deliberate (the process manager reports the crash and retries).
			process.exit(1);
		}
		console.info("[multiuser] web relay mode: global plugin initialization is skipped (plugins run in account workers).");
		return;
	}

	const { initializePlugins } = await import("./src/server/plugins.ts");
	try { await initializePlugins(); }
	catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
}
