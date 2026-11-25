/**
 * Memory Embeddings Service
 *
 * Generates vector embeddings through an OpenAI-compatible `/v1/embeddings`
 * endpoint (LM Studio, Ollama, …) for the memory system's semantic search.
 *
 * Configuration (#18296): `settings.embeddings` ({ provider, model }, saved from
 * Models → Embeddings or AI Assignments) is the single source of truth, shared
 * with the catalog's `embeddings.js`. The legacy CoS `embeddingProviderId` /
 * `embeddingModel` pair is read ONLY while `settings.embeddings` has never been
 * saved, so an upgraded install keeps the backend it already had.
 */

import { DEFAULT_MEMORY_CONFIG } from './memoryConfig.js';
import { getProviderById } from './provider/providers.js';
import { getConfig as getCosConfig } from './cos/cosState.js';
import { getSettings, settingsEvents } from './settings.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readResponseJson } from '../lib/readResponseJson.js';
import { estimateTokens } from '../lib/contextBudget.js';
import { isEmbeddingModel } from '../lib/localModelHeuristics.js';
import { getNavPageForPath } from '../lib/navManifest.js';

// Re-export the canonical token estimator so existing importers
// (e.g. memoryRetriever.js) keep their `from './memoryEmbeddings.js'` path.
export { estimateTokens };

const MODEL_LIST_TIMEOUT_MS = 10000;
const MODEL_LOAD_TIMEOUT_MS = 60000;

// Memoized resolved config. `configGeneration` invalidates an in-flight build
// that a reinitialize() overtook, so a stale settings read never replaces the
// fresh one. Model-load state (`modelEnsured`) lives on the config object so a
// stale build can't latch it for the new config.
let configPromise = null;
let configGeneration = 0;
// The `settings.embeddings` value the active config was built from; a
// `settings:updated` event that changes it reinitializes (no restart needed).
let activeSettingsKey;

// Names the one editor of settings.embeddings by route, so a page move never
// leaves stale copy behind (#7419).
export const embeddingsSettingsPage = () => getNavPageForPath('/models/embeddings')?.breadcrumb ?? 'the Embeddings settings page';

const settingsEmbeddingsKey = (settings) => JSON.stringify(settings?.embeddings ?? null);

// Managers own the base URL `embeddings.js` embeds catalog rows against, so the
// memory path resolves the very same backend. Lazy: only the chosen one loads.
const SETTINGS_BACKEND_BASE_URL = {
  ollama: async () => (await import('./ollamaManager.js')).getBaseUrl(),
  lmstudio: async () => (await import('./lmStudioManager.js')).getBaseUrl(),
};

const toEmbeddingsEndpoint = (endpoint) => {
  const base = String(endpoint).replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/embeddings` : `${base}/v1/embeddings`;
};

/**
 * Resolve which embedding backend memory uses, without probing it (no network,
 * no LM Studio auto-load), so read-only status surfaces can call it.
 *
 * Returns `{ source, provider, model, endpoint, disabled, error? }`:
 *   - source `'settings'`: from `settings.embeddings`; `provider: 'none'` (or an
 *     unknown provider) is `disabled: true`.
 *   - source `'legacy'`: `settings.embeddings` unset → CoS config fallback.
 *     `endpoint: null` means the provider has no endpoint and the LM Studio
 *     default endpoint is used (pre-#18296 behavior).
 */
export async function resolveEmbeddingSource(settingsArg) {
  const settings = settingsArg ?? await getSettings().catch(() => ({}));
  const cfg = settings?.embeddings;
  if (cfg?.provider) {
    const provider = cfg.provider;
    const model = cfg.model || null;
    if (provider === 'none') return { source: 'settings', provider, model: null, endpoint: null, disabled: true };
    const resolveBaseUrl = SETTINGS_BACKEND_BASE_URL[provider];
    if (!resolveBaseUrl) {
      return { source: 'settings', provider, model, endpoint: null, disabled: true, error: `Unknown embeddings provider: ${provider}` };
    }
    return { source: 'settings', provider, model, endpoint: toEmbeddingsEndpoint(await resolveBaseUrl()), disabled: false };
  }

  const cosConfig = await getCosConfig().catch(() => ({}));
  const provider = cosConfig?.embeddingProviderId || 'lmstudio';
  // The legacy path has always fallen back to the default (LM Studio) model.
  const model = cosConfig?.embeddingModel || DEFAULT_MEMORY_CONFIG.embeddingModel;
  // Keys off `endpoint` alone and does NOT gate on `enabled`: embeddings have
  // always generated from a disabled-but-endpoint'd provider.
  const record = await getProviderById(provider).catch(() => null);
  return { source: 'legacy', provider, model, endpoint: record?.endpoint ? toEmbeddingsEndpoint(record.endpoint) : null, disabled: false };
}

async function buildConfig() {
  const settings = await getSettings().catch(() => ({}));
  const settingsKey = settingsEmbeddingsKey(settings);
  const resolved = await resolveEmbeddingSource(settings);
  const config = {
    ...DEFAULT_MEMORY_CONFIG,
    source: resolved.source,
    disabled: resolved.disabled,
    disabledReason: resolved.error || null,
    // Which provider backs embeddings; the LM-Studio-only auto-load dance is
    // gated on a capability probe, not this id.
    embeddingProvider: resolved.provider,
    embeddingEndpoint: resolved.endpoint || DEFAULT_MEMORY_CONFIG.embeddingEndpoint,
    // A settings-sourced backend never inherits the DEFAULT model (an LM Studio
    // model name Ollama doesn't have): `null` there means "discover one".
    embeddingModel: resolved.model,
    modelEnsured: false,
  };
  if (config.disabled) {
    console.log(`📚 Memory embeddings disabled (${config.disabledReason || 'settings.embeddings provider is none'})`);
  } else if (resolved.endpoint) {
    console.log(`📚 Memory embeddings using ${resolved.source} provider ${resolved.provider} (model: ${config.embeddingModel || 'auto'}): ${config.embeddingEndpoint}`);
  }
  return { config, settingsKey };
}

/**
 * The active resolved config (memoized until reinitialize()).
 */
function loadConfig() {
  if (!configPromise) {
    const generation = configGeneration;
    configPromise = buildConfig().then(({ config, settingsKey }) => {
      if (generation === configGeneration) activeSettingsKey = settingsKey;
      return config;
    });
  }
  return configPromise;
}

/**
 * Reset so the next embedding call re-reads config.
 */
export function reinitialize() {
  configGeneration++;
  configPromise = null;
  activeSettingsKey = undefined;
}

// Saving `settings.embeddings` (Models → Embeddings, AI Assignments) takes
// effect immediately. Other settings writes leave the cached config alone. A
// save landing while the first build is still in flight (no key recorded yet)
// also reinitializes, so that build's possibly-stale read is never cached.
settingsEvents.on('settings:updated', (settings) => {
  if (configPromise && settingsEmbeddingsKey(settings) !== activeSettingsKey) reinitialize();
});
settingsEvents.on('settings:invalidated', reinitialize);

/**
 * The embedding model memory vectors are currently produced with, or `null`
 * when embeddings are disabled / no model is resolved yet. Writers stamp this
 * into `embedding_model` so the column names the model that made the vector.
 */
export async function getActiveEmbeddingModel() {
  const config = await loadConfig();
  return config.disabled ? null : (config.embeddingModel || null);
}

const getBaseUrl = (config) => config.embeddingEndpoint.replace(/\/v1\/embeddings$/, '');

// First embedding-looking id, for a backend configured without a model.
const pickEmbeddingModel = (ids) => ids.find((id) => isEmbeddingModel(id)) || null;

async function listOpenAiModelIds(config) {
  const response = await fetchWithTimeout(`${getBaseUrl(config)}/v1/models`, {}, MODEL_LIST_TIMEOUT_MS)
    .catch(() => null);
  if (!response?.ok) return [];
  const data = await readResponseJson(response);
  return Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
}

/**
 * Probe whether the configured endpoint is an LM Studio backend by hitting its
 * NATIVE `/api/v0/models` API (which lists every downloaded model + type +
 * load-state). Returns the parsed model list when it's LM Studio, or `null`
 * when the endpoint doesn't speak that API — i.e. any other OpenAI-compatible
 * backend (Ollama, llama.cpp, …), which serves only `/v1/*` and 404s this.
 *
 * Detecting by CAPABILITY rather than by provider id (`=== 'lmstudio'`) means a
 * renamed/custom provider id still pointing at LM Studio keeps its lazy-load
 * behavior, and a non-LM-Studio backend is recognized regardless of its id.
 */
async function probeLmStudioModels(config) {
  const baseUrl = getBaseUrl(config);
  const response = await fetchWithTimeout(`${baseUrl}/api/v0/models`, {}, MODEL_LIST_TIMEOUT_MS)
    .catch(() => null);
  if (!response || !response.ok) return null;
  const models = await readResponseJson(response);
  // A non-LM-Studio backend that happens to 200 this path won't carry the
  // native shape (array of { id, type, state }); guard on it.
  return Array.isArray(models?.data) ? models.data : null;
}

/**
 * Discover and auto-load an embedding model in LM Studio.
 * Uses the REST API to find downloaded embedding models and load one if needed.
 *
 * This dance is LM-Studio-specific: LM Studio lazy-loads models and exposes a
 * native `/api/v0/models` + `/api/v1/models/load` API to discover and pin one.
 * Other OpenAI-compatible embedding backends (Ollama, etc.) serve
 * `/v1/embeddings` directly with no load step and don't implement those
 * endpoints — detected here by the native-API probe coming back empty, in which
 * case we skip the dance and trust the configured model id (or, when none is
 * configured, discover one from `/v1/models`). Without this, an Ollama-backed
 * config would 404 the LMS-only URLs on every call (modelEnsured never latches
 * → repeated failed probes per embed).
 */
async function ensureEmbeddingModelLoaded(config) {
  if (config.modelEnsured) return;

  const allModels = await probeLmStudioModels(config);
  // Not an LM Studio backend (Ollama, etc.) — no load step exists; trust config.
  if (allModels === null) {
    if (!config.embeddingModel) {
      config.embeddingModel = pickEmbeddingModel(await listOpenAiModelIds(config));
      if (!config.embeddingModel) {
        console.warn(`⚠️ No embedding model configured or installed at ${config.embeddingEndpoint} — pick one on ${embeddingsSettingsPage()}`);
        return;
      }
      console.log(`📚 Embedding model discovered: ${config.embeddingModel}`);
    }
    config.modelEnsured = true;
    return;
  }

  const embeddingModels = allModels.filter(m => m.type === 'embeddings');

  // Check if an embedding model is already loaded
  const loaded = embeddingModels.find(m => m.state === 'loaded');
  if (loaded) {
    config.embeddingModel = loaded.id;
    config.modelEnsured = true;
    console.log(`📚 Embedding model already loaded: ${loaded.id}`);
    return;
  }

  // No embedding model loaded — try to load the configured one first, then any available
  const candidates = [
    config.embeddingModel ? embeddingModels.find(m => m.id.includes(config.embeddingModel)) : null,
    ...embeddingModels
  ].filter(Boolean);

  if (candidates.length === 0) {
    console.warn(`⚠️ No embedding models found in LM Studio — download one in the Discover tab`);
    return;
  }

  const modelToLoad = candidates[0];
  console.log(`📦 Auto-loading embedding model: ${modelToLoad.id}`);

  const baseUrl = getBaseUrl(config);
  const loadResponse = await fetchWithTimeout(`${baseUrl}/api/v1/models/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelToLoad.id })
  }, MODEL_LOAD_TIMEOUT_MS);

  if (loadResponse.ok) {
    config.embeddingModel = modelToLoad.id;
    config.modelEnsured = true;
    console.log(`✅ Embedding model loaded: ${modelToLoad.id}`);
  } else {
    const err = await loadResponse.text();
    console.error(`❌ Failed to auto-load embedding model ${modelToLoad.id}: ${err}`);
  }
}

/**
 * Load/discover the model before a request. `false` only when there is no
 * model id to send at all (nothing configured, nothing discoverable) — posting
 * `model: null` would just fail on the backend.
 */
async function ensureModelReady(config) {
  if (!config.modelEnsured) {
    await ensureEmbeddingModelLoaded(config).catch(err =>
      console.warn(`⚠️ Could not ensure embedding model: ${err.message}`)
    );
  }
  return !!config.embeddingModel;
}

/**
 * Check if the embedding backend is reachable and an embedding model is usable.
 * Works for any OpenAI-compatible backend (LM Studio, Ollama, …) — all serve
 * `GET /v1/models`.
 */
export async function checkAvailability() {
  const config = await loadConfig();
  const origin = { source: config.source, provider: config.embeddingProvider };

  if (config.disabled) {
    return {
      ...origin,
      available: false,
      disabled: true,
      error: config.disabledReason || `Embeddings are disabled on ${embeddingsSettingsPage()}`,
      embeddingModel: null,
      modelPresent: false,
      endpoint: null
    };
  }

  const response = await fetch(`${config.embeddingEndpoint.replace('/v1/embeddings', '/v1/models')}`, {
    method: 'GET',
    signal: AbortSignal.timeout(5000)
  }).catch(err => ({ ok: false, _err: err.message }));

  if (!response.ok) {
    return { ...origin, available: false, error: response._err || `Embedding backend returned ${response.status}`, endpoint: config.embeddingEndpoint };
  }

  const data = await readResponseJson(response);
  const models = data.data?.map(m => m.id) || [];

  // Is this an LM Studio backend? Detect by capability (native API), not id, so
  // a renamed provider still gets the load behavior.
  const lmsModels = await probeLmStudioModels(config);

  if (lmsModels === null) {
    // Non-LM-Studio (Ollama, etc.): the configured model id is authoritative —
    // don't guess from `.includes('embed')` (could latch onto the wrong model).
    // Only a backend configured WITHOUT a model discovers one. The load dance
    // is a no-op for these backends.
    if (!config.embeddingModel) config.embeddingModel = pickEmbeddingModel(models);
    const present = !!config.embeddingModel
      && models.some(id => id === config.embeddingModel || id.startsWith(`${config.embeddingModel}:`));
    if (config.embeddingModel) config.modelEnsured = true;
    return { ...origin, available: true, models, embeddingModel: config.embeddingModel, modelPresent: present, endpoint: config.embeddingEndpoint };
  }

  // LM Studio: auto-load an embedding model if none is loaded, then report
  // whether one is actually loaded so the UI can't show green on an empty LMS.
  const loaded = lmsModels.find(m => m.type === 'embeddings' && m.state === 'loaded');
  if (loaded) {
    config.embeddingModel = loaded.id;
    config.modelEnsured = true;
  } else {
    await ensureEmbeddingModelLoaded(config).catch(err =>
      console.warn(`⚠️ Could not auto-load embedding model: ${err.message}`)
    );
  }

  return {
    ...origin,
    available: true,
    models,
    embeddingModel: config.embeddingModel,
    // `modelEnsured` latches true only once an embeddings model is loaded (here
    // or inside ensureEmbeddingModelLoaded) — the honest model-present signal.
    modelPresent: config.modelEnsured,
    endpoint: config.embeddingEndpoint
  };
}

/**
 * Embedding-input budgeting.
 *
 * The embedding model has a hard token context (config.embeddingMaxTokens —
 * 2048 for nomic-embed-text). Input over it is REJECTED ("input length exceeds
 * the context length") → a NULL embedding, not a truncated one. Our token
 * estimate (~4 chars/token) is optimistic for dense transcripts (code/JSON/
 * non-English run ~3 chars/token), so we budget against a conservative
 * chars-per-token AND only fill a fraction of the context, leaving headroom for
 * the few prompt tokens the backend wraps around the input.
 */
const EMBED_CONTEXT_FILL = 0.85;      // use ≤85% of the model context
const CONSERVATIVE_CHARS_PER_TOKEN = 3; // dense text floor (vs the 4 estimate)

function embeddingCharBudget(config) {
  const maxTokens = config.embeddingMaxTokens || 2048;
  return Math.floor(maxTokens * EMBED_CONTEXT_FILL * CONSERVATIVE_CHARS_PER_TOKEN);
}

const isContextOverflowError = (msg) =>
  /context length|context window|too (?:long|large)|exceeds? .*length|maximum context/i.test(String(msg || ''));

const clampToChars = (text, maxChars) => (text.length > maxChars ? text.slice(0, maxChars) : text);

/**
 * POST one input to the embedding endpoint. Returns
 * { ok, embedding, error, overflow } so callers can decide whether to shrink
 * and retry on a context-overflow rejection.
 */
async function postEmbedding(config, input) {
  // Refused connection / DNS failure / timeout resolves as a failed result so
  // callers keep the documented "null when unavailable" contract.
  const response = await fetch(config.embeddingEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.embeddingModel, input }),
    signal: AbortSignal.timeout(30000)
  }).catch(err => ({ transportError: err }));
  if (response.transportError) {
    return { ok: false, error: response.transportError.message, overflow: false };
  }
  if (!response.ok) {
    const error = await response.text();
    return { ok: false, error, overflow: isContextOverflowError(error) };
  }
  const data = await readResponseJson(response);
  return { ok: true, data };
}

/**
 * Generate embedding for a single text. Truncates to the model's context
 * budget up front, and if the backend still reports a context overflow (our
 * char estimate undershot for very dense text), halves the input and retries a
 * couple of times before giving up — so a pathological doc still embeds rather
 * than landing NULL.
 */
export async function generateEmbedding(text) {
  const config = await loadConfig();

  if (config.disabled || !text || text.trim().length === 0) {
    return null;
  }

  if (!await ensureModelReady(config)) return null;

  let maxChars = embeddingCharBudget(config);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await postEmbedding(config, clampToChars(text, maxChars));
    if (result.ok) return result.data.data?.[0]?.embedding || null;
    if (result.overflow && maxChars > 500) {
      maxChars = Math.floor(maxChars / 2); // undershoot — shrink and retry
      console.log(`🔁 Embedding input over context; retrying at ${maxChars} chars`);
      continue;
    }
    console.error(`❌ Embedding generation failed: ${result.error}`);
    return null;
  }
  console.error('❌ Embedding generation failed: input still over context after shrinking');
  return null;
}

/**
 * Generate embedding for memory content + metadata.
 *
 * Combines content with type/category/tags for a richer semantic vector. When
 * the combined text fits the embedding model's context, it's embedded directly
 * (the common case — no extra cost). When it OVERFLOWS the budget, plain
 * truncation would drop everything past the first ~budget chars (for a long
 * ChatGPT chat, most of it), so we first try to summarize the record to a
 * embedding-sized gist via a larger-context local model (memorySummarizer) and
 * embed THAT — the vector then represents the whole record. If summarization is
 * unavailable or fails, we fall back to generateEmbedding's truncate+retry so
 * the record still gets some embedding.
 */
export async function generateMemoryEmbedding(memory, sourceHints = {}) {
  const config = await loadConfig();
  // Disabled: no vector, and no summarization call to build one.
  if (config.disabled) return null;

  const parts = [
    `Type: ${memory.type}`,
    `Category: ${memory.category || 'general'}`,
    memory.tags?.length > 0 ? `Tags: ${memory.tags.join(', ')}` : '',
    memory.summary || '',
    memory.content
  ].filter(Boolean);
  const text = parts.join('\n');

  // Within budget → embed as-is (no summarization call).
  if (text.length <= embeddingCharBudget(config)) {
    return generateEmbedding(text);
  }

  // Over budget → summarize to fit (lazy import avoids a startup cycle:
  // memorySummarizer imports chatgptImport, which need not load at boot).
  // `sourceHints` ({ source, sourceRef }) lets the summarizer pull the FULL
  // archived transcript for an import record rather than the capped preview;
  // it's passed separately because the memory payload has no such columns.
  const { summarizeForEmbedding } = await import('./memorySummarizer.js');
  const summary = await summarizeForEmbedding({ ...memory, ...sourceHints }, text).catch((err) => {
    console.warn(`⚠️ Embedding summarization errored: ${err.message}`);
    return null;
  });
  if (summary) {
    // Keep the metadata header so summary vectors share the type/category/tags
    // signal with directly-embedded ones.
    const header = parts.slice(0, parts.length - 1).join('\n'); // everything except raw content
    console.log(`🧠 Summarized over-budget memory before embedding (${text.length}→${summary.length} chars)`);
    return generateEmbedding(`${header}\n${summary}`);
  }

  // Summarizer unavailable/failed — truncate+retry fallback.
  return generateEmbedding(text);
}

/**
 * Generate embeddings for a query (used in search)
 * Optionally enriches query with context hints
 */
export async function generateQueryEmbedding(query, context = {}) {
  const parts = [query];

  // Add context hints if provided
  if (context.types?.length > 0) {
    parts.push(`Looking for: ${context.types.join(', ')}`);
  }
  if (context.categories?.length > 0) {
    parts.push(`In categories: ${context.categories.join(', ')}`);
  }

  const text = parts.join('\n');
  return generateEmbedding(text);
}
