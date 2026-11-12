/**
 * Startup composition is selected by the explicit deployment mode.
 *
 * multiuser-web NEVER initializes the process-global plugin host or the
 * single-user store composition: those run inside a per-account worker once
 * Phase 3 lands. This milestone only proves configuration/readiness and
 * leaves every learning route gated.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const { deploymentMode } = await import("./src/runtime/deployment-mode.ts");
	const mode = deploymentMode();

	if (mode === "multiuser-web") {
		const { loadMultiuserConfig } = await import("./src/runtime/multiuser-config.ts");
		const { assertReady, prepareLocalDevelopmentDirectories } = await import("./src/runtime/readiness.ts");
		const loaded = loadMultiuserConfig();
		// The local provider is the explicit offline simulation: make its
		// runtime directories before the fail-closed readiness check. Clerk
		// deployments must provide host-created, root-owned mounts instead.
		if (loaded.ok) prepareLocalDevelopmentDirectories(loaded.config);
		const report = assertReady(mode, loaded);
		console.log(
			`[multiuser] readiness passed (${report.checks.filter((check) => check.ok).length} checks). ` +
			"Learning routes remain gated until the per-account worker runtime exists.",
		);
		return;
	}

	// Single-user/desktop: the existing plugin initialization hook. A plugin
	// failure must not prevent access to existing learning data or teaching.
	const { initializePlugins } = await import("./src/server/plugins.ts");
	try { await initializePlugins(); }
	catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
}
