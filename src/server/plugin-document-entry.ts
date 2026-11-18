import { createPluginDocumentRoute } from "./plugin-document-route.ts";

/**
 * Narrow composition for the streamed plugin-document endpoint. Do not import
 * the main server barrel at module load: it reaches the shared stores and
 * initializes process-global plugin services. The local composition is loaded
 * only after the mode-aware route gate has accepted the request.
 */
export function createPluginDocumentEndpoint() {
	return createPluginDocumentRoute({
		async convertDocument(id, request) {
			const { pluginTransport } = await import("./plugins.ts");
			return pluginTransport.convertDocument(id, request);
		},
	});
}
