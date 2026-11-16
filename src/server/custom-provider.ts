/**
 * The custom OpenAI-compatible endpoint: turns the user's non-secret config
 * (base URL + discovered models) into a pi-ai provider registered in
 * `piModels()`, so its models fill the same slots as any built-in. Keyless
 * local servers work via a placeholder key resolved at request time.
 */

import { createProvider, type Api, type Model, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { configureProviderSource, piModels } from "../agent/models.ts";
import { readSettings } from "../store/settings.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { CUSTOM_PROVIDER } from "../core/auth-keys.ts";
import { customBindingMatches } from "../core/custom-provider-auth.ts";
import { customAuthState, customKeyAuthorized } from "./custom-provider-auth.ts";
import {
	CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
	CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
	customProviderUsable,
	normalizeBaseUrl,
	type CustomModel,
	type CustomModelOverride,
} from "../core/settings.ts";


/** Placeholder bearer for keyless endpoints (the OpenAI client needs *a* key). */
const KEYLESS_PLACEHOLDER = "not-needed";

/** Narrow an unknown to a plain object (not null, not an array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Install the sole custom source: donor settings + explicit authentication.
 * Publication captures a consistent snapshot; an already-started operation
 * cannot acquire a later endpoint's key. No file configuration source exists. */
export function installCustomProviderSource(readAuth = customAuthState): void {
	let fingerprint: string | undefined;
	configureProviderSource({
		isCustom: (id) => id === CUSTOM_PROVIDER.id,
		sync(models) {
			const cp = readSettings()?.customProvider;
			// Validate the durable nonce/URL/mode before resolving ANY credential.
			// Keyless reads only the nonsecret marker, never a file/env key.
			const auth = readAuth(cp?.authMode === "apiKey", cp);
			const key = auth.key;
			const ready = customProviderUsable(cp) && auth.readable && customBindingMatches(cp, auth.binding) && (cp.authMode === "keyless" || customKeyAuthorized(cp, auth));
			const next = JSON.stringify([cp, auth]); // Private in-memory fingerprint, never a public revision.
			if (next === fingerprint) return;
			if (ready) models.setProvider(buildOpenAiCompatibleProvider({ ...cp, baseUrl: cp.baseUrl, models: cp.models ?? [], apiKey: key }));
			else models.deleteProvider(CUSTOM_PROVIDER.id);
			fingerprint = next;
		},
	});
}

export function customProviderAvailable(): boolean {
	return piModels().getProvider(CUSTOM_PROVIDER.id) !== undefined;
}

/** Map a discovered model to a pi-ai entry: image→input, reasoning→thinking
 *  levels, context/maxTokens→limits. Resolution ladder (owner, 2026-10-27):
 *  the user's pin wins, then the endpoint's own metadata, then the compiled
 *  default — a local server that says nothing (or says 8k) can be corrected.
 *  baseUrl is stamped per-model. */
function toPiModel(
	model: CustomModel,
	baseUrl: string,
	overrides: Record<string, CustomModelOverride>,
): Model<Api> {
	const pin = overrides[model.id];
	const reasoning = pin?.reasoning ?? Boolean(model.reasoning);
	const thinkingLevelMap = reasoning ? thinkingLevelMapFor(model) : undefined;
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: CUSTOM_PROVIDER.id,
		baseUrl,
		// Pin wins; else detected from the endpoint's metadata (see
		// detectReasoning). true makes pi-ai offer the standard levels and send
		// reasoning_effort on the wire; a declared level set replaces that
		// standard set with exactly the endpoint's own.
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		// A declared level contract means the endpoint accepts the effort
		// parameter even when the URL looks like a backend pi-ai knows as
		// non-effort (z.ai, Moonshot, …). Metadata beats URL heuristics.
		...(thinkingLevelMap ? { compat: { supportsReasoningEffort: true } } : {}),
		input: model.image ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: pin?.context ?? model.context ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
		maxTokens: pin?.maxTokens ?? model.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
		type: "chat",
	};
}

/** The endpoint's declared reasoning vocabulary → pi-ai's fixed scale.
 *  `thinking` is the binary gate some servers publish (zai/minimax): one on
 *  level, mapped to High. `ultra` has no pi level and collapses to max. */
const DECLARED_THINKING_LEVELS: Readonly<Record<string, { level: keyof ThinkingLevelMap; wire: string }>> = {
	none: { level: "off", wire: "none" },
	off: { level: "off", wire: "none" },
	disabled: { level: "off", wire: "none" },
	thinking: { level: "high", wire: "high" },
	on: { level: "high", wire: "high" },
	enabled: { level: "high", wire: "high" },
	minimum: { level: "minimal", wire: "minimal" },
	minimal: { level: "minimal", wire: "minimal" },
	low: { level: "low", wire: "low" },
	med: { level: "medium", wire: "medium" },
	medium: { level: "medium", wire: "medium" },
	high: { level: "high", wire: "high" },
	xhigh: { level: "xhigh", wire: "xhigh" },
	"extra-high": { level: "xhigh", wire: "xhigh" },
	max: { level: "max", wire: "max" },
	maximum: { level: "max", wire: "max" },
	ultra: { level: "max", wire: "max" },
};

/** The picker set is exactly what the endpoint declared: every pi level is
 *  first marked unsupported, then declared ones are mapped to their wire
 *  value. Off is a real request (reasoning_effort "none") only when the
 *  endpoint says thinking can be disabled — otherwise it stays hidden and
 *  the stored "off" clamps up honestly. Undefined → pi-ai's standard set. */
function thinkingLevelMapFor(model: CustomModel): ThinkingLevelMap | undefined {
	const declared = model.thinkingLevels;
	if (!declared?.length) return undefined;
	const map: ThinkingLevelMap = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
	for (const raw of declared) {
		const entry = DECLARED_THINKING_LEVELS[raw];
		if (entry) map[entry.level] = entry.wire;
	}
	if (map.off === "none" && model.thinkingCanDisable === false) map.off = null;
	return map;
}

/** Build an OpenAI-compatible provider from parts. baseUrl must be normalized. */
export function buildOpenAiCompatibleProvider(input: {
	baseUrl: string;
	models: readonly CustomModel[];
	/** User pins by model id (see CustomModelOverride) — absent = none. */
	overrides?: Record<string, CustomModelOverride>;
	/** Already resolved for this publication; absent means explicit keyless. */
	apiKey?: string;
}): Provider<Api> {
	const overrides = input.overrides ?? {};
	return createProvider<Api>({
		id: CUSTOM_PROVIDER.id,
		name: CUSTOM_PROVIDER.label,
		baseUrl: input.baseUrl,
		auth: { apiKey: {
			name: `${CUSTOM_PROVIDER.label} API key`,
			resolve: async () => ({ auth: { apiKey: input.apiKey ?? KEYLESS_PLACEHOLDER }, source: input.apiKey ? CUSTOM_PROVIDER.envVar : "keyless" }),
		} },
		models: input.models.map((m) => toPiModel(m, input.baseUrl, overrides)),
		api: openAICompletionsApi(),
	});
}

/** Re-sync the provider into piModels() (idempotent): usable → rebuild;
 *  not usable → remove. Never throws. */
export function syncCustomProvider(): void {
	piModels();
}

/** Outcome of a model-discovery probe. `status` is the endpoint's HTTP status
 *  when it answered at all, so callers can tell a rejected key from a missing
 *  model list. */
export type DiscoverResult =
	| { ok: true; models: CustomModel[] }
	| { ok: false; error: string; status?: number; fatal?: boolean };

/** Probe GET {baseUrl}/models for model ids. Scheme validated (http/https
 *  only); keyless endpoints answer without a bearer. Non-2xx or unparseable
 *  body → honest error, never a silent empty list. */
export async function discoverModels(baseUrl: string, apiKey?: string): Promise<DiscoverResult> {
	const base = normalizeBaseUrl(baseUrl);
	if (!base) return { ok: false, error: "Base URL must be a valid http(s) URL" };
	const key = apiKey?.trim();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const res = await fetch(`${base}/models`, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: controller.signal,
			redirect: "manual",
		});
		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel();
			return { ok: false, error: "Discovery redirects are not allowed", fatal: true };
		}
		if (!res.ok) { await res.body?.cancel(); return { ok: false, error: `Endpoint returned HTTP ${res.status}`, status: res.status }; }
		const body = await readBoundedJson(res, 8 * 1024 * 1024);
		const list = extractModels(body);
		if (list === null) return { ok: false, error: "Endpoint response was not a model list" };
		return { ok: true, models: list };
	} catch (err) {
		return { ok: false, error: err instanceof CustomBodyLimitError ? err.message : controller.signal.aborted ? "Endpoint timed out" : "Discovery request failed", fatal: err instanceof CustomBodyLimitError };
	} finally {
		clearTimeout(timer);
	}
}

/** The connect's model list: what the endpoint advertises, plus every typed id
 *  it does not advertise (at default limits, so the pins can correct them).
 *  Discovered metadata always wins over a typed id of the same name. */
export function mergeManualModels(discovered: readonly CustomModel[], manualIds: readonly string[]): CustomModel[] {
	const byId = new Map(discovered.map((m) => [m.id, m]));
	for (const id of manualIds) if (!byId.has(id)) byId.set(id, { id });
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Model rows from a list response ({data:[…]} | {models:[…]} | bare array),
 *  or null if unrecognized. */
function modelRows(body: unknown): unknown[] | null {
	if (Array.isArray(body)) return body;
	if (isRecord(body)) {
		if (Array.isArray(body.data)) return body.data;
		if (Array.isArray(body.models)) return body.models;
	}
	return null;
}

/** Does a /models row advertise image input? Scans the common modality/
 *  capability fields; absent or unrecognized → false (text-only). */
function detectImage(row: Record<string, unknown>): boolean {
	const architecture = isRecord(row.architecture) ? row.architecture : undefined;
	const capabilities = isRecord(row.capabilities) ? row.capabilities : undefined;
	// 9router and several gateways declare capabilities as an object of
	// booleans (`vision: true`), not the string list older servers publish.
	if (capabilities?.vision === true || capabilities?.imageInput === true) return true;
	const candidates = [
		architecture?.input_modalities,
		row.input_modalities,
		row.modalities,
		row.supported_modalities,
		row.capabilities,
	];
	for (const c of candidates) {
		if (Array.isArray(c) && c.some((v) => typeof v === "string" && /image|vision/i.test(v))) return true;
	}
	return false;
}

/** Does a /models row advertise reasoning? Metadata only — no name guessing,
 *  because a false positive sends reasoning_effort an endpoint will reject.
 *  Trusted signals: an explicit boolean (reasoning / supports_reasoning /
 *  thinking) or a reasoning token in the capability/parameter lists servers
 *  publish (vLLM + OpenRouter's supported_parameters, capabilities, tags).
 *  Absent or unrecognized → false (thinking stays "off"). */
function detectReasoning(row: Record<string, unknown>): boolean {
	for (const key of ["reasoning", "supports_reasoning", "thinking"] as const) {
		if (row[key] === true) return true;
	}
	// Object-shaped capability blocks (9router: capabilities.reasoning) are
	// the modern spelling; the list scan below only handles arrays.
	if (isRecord(row.capabilities) && row.capabilities.reasoning === true) return true;
	const architecture = isRecord(row.architecture) ? row.architecture : undefined;
	const candidates = [row.supported_parameters, row.capabilities, row.tags, architecture?.output_modalities];
	return candidates.some(
		(list) =>
			Array.isArray(list) &&
			list.some((v) => typeof v === "string" && (/reasoning/i.test(v) || v.toLowerCase() === "thinking")),
	);
}

/** First positive integer among `keys` on a row (endpoints name limits
 *  inconsistently). */
function firstPositive(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	}
	return undefined;
}

// Field names seen in the wild for each limit (first present wins).
const CONTEXT_KEYS = ["max_input_tokens", "context_length", "context_window", "max_context", "n_ctx", "max_seq_len", "max_position_embeddings"] as const;
const MAX_TOKEN_KEYS = ["max_output_tokens", "max_completion_tokens"] as const;
// 9router (and gateways that mirror its schema) mirror the same limits inside
// the camelCase capability block. Top-level stays authoritative; the nested
// copy is the fallback, never a competing truth.
const CAPABILITY_CONTEXT_KEYS = ["contextWindow"] as const;
const CAPABILITY_MAX_TOKEN_KEYS = ["maxOutput"] as const;
// llama.cpp's llama-server nests the runtime context (per slot) under `meta`.
// Its sibling `n_ctx_train` is the model's training maximum, not what the
// server accepts, so it is deliberately not read.
const META_CONTEXT_KEYS = ["n_ctx"] as const;

/** The declared reasoning levels, verbatim (trimmed, lowercased, unique). */
function declaredThinkingLevels(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[] = [];
	for (const value of raw) {
		if (typeof value !== "string") continue;
		const level = value.trim().toLowerCase();
		if (level && !out.includes(level)) out.push(level);
	}
	return out.length ? out : undefined;
}

/** Pull models from a list response (objects with `id` or bare strings), each
 *  with detected image + token limits. Null if the shape is unrecognized. */
function extractModels(body: unknown): CustomModel[] | null {
	const rows = modelRows(body);
	if (rows === null) return null;
	if (rows.length > 10_000) throw new CustomBodyLimitError("Model list exceeds 10000 entries");
	const byId = new Map<string, CustomModel>();
	for (const row of rows) {
		if (typeof row === "string") {
			if (row.trim()) byId.set(row, { id: row });
			continue;
		}
		if (isRecord(row) && typeof row.id === "string" && row.id.trim()) {
			const model: CustomModel = { id: row.id };
			const capabilities = isRecord(row.capabilities) ? row.capabilities : undefined;
			if (detectImage(row)) model.image = true;
			if (detectReasoning(row)) model.reasoning = true;
			const context =
				firstPositive(row, CONTEXT_KEYS) ??
				(capabilities ? firstPositive(capabilities, CAPABILITY_CONTEXT_KEYS) : undefined) ??
				(isRecord(row.meta) ? firstPositive(row.meta, META_CONTEXT_KEYS) : undefined);
			if (context) model.context = context;
			const maxTokens =
				firstPositive(row, MAX_TOKEN_KEYS) ??
				(capabilities ? firstPositive(capabilities, CAPABILITY_MAX_TOKEN_KEYS) : undefined);
			if (maxTokens) model.maxTokens = maxTokens;
			// The endpoint's own level contract: pi-ai will offer exactly this
			// set instead of its standard one, so a max-only model stops
			// capping the picker at high.
			const thinkingLevels = declaredThinkingLevels(row.thinking_levels);
			if (thinkingLevels) model.thinkingLevels = thinkingLevels;
			if (typeof capabilities?.thinkingCanDisable === "boolean") model.thinkingCanDisable = capabilities.thinkingCanDisable;
			byId.set(row.id, model);
		}
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
