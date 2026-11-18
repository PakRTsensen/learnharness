/**
 * Composition-root probe for tests/deployment-composition.test.ts.
 *
 * Deployment mode is module-load-bound (config.ts), so each probe must run in a
 * FRESH process with the environment already set. This helper never sets env
 * itself; the test supplies a throwaway LH_DATA_DIR/LH_AUTH_FILE so no real
 * profile is touched.
 *
 * Usage: node --import tsx tests/helpers/composition-root-probe.ts <probe>
 *   relay          call accountRelay.scope() and report the result shape
 *   stores         import the shared composition root directly
 *   instrumentation call instrumentation.register() (may exit(1) by design)
 */

const probe = process.argv[2];
const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

export {};

try {
	if (probe === "relay") {
		const { accountRelay } = await import("../../src/server/account-relay.ts");
		const scope = await accountRelay.scope();
		report({ ok: true, storeKeys: Object.keys(scope.stores).sort() });
	} else if (probe === "stores") {
		const { stores } = await import("../../src/server/stores.ts");
		report({ ok: true, storeKeys: Object.keys(stores).sort() });
	} else if (probe === "instrumentation") {
		const { register } = await import("../../instrumentation.ts");
		await register();
		report({ ok: true, registered: true });
	} else {
		report({ ok: false, error: `unknown probe: ${String(probe)}` });
		process.exitCode = 2;
	}
} catch (error) {
	report({ ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
	process.exitCode = 1;
}
