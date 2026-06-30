/**
 * Memory Embeddings Service
 *
 * Generates vector embeddings using LM Studio's OpenAI-compatible API.
 * Provides semantic search capabilities for the memory system.
 */

import { DEFAULT_MEMORY_CONFIG } from './memoryBackend.js';
import { getProviderById } from './providers.js';
import { getConfig as getCosConfig } from './cos.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readResponseJson } from '../lib/readResponseJson.js';
import { estimateTokens, CHARS_PER_TOKEN } from '../lib/contextBudget.js';

// Re-export the canonical token estimator so existing importers
// (e.g. memoryRetriever.js) keep their `from './memoryEmbeddings.js'` path.
export { estimateTokens };

const MODEL_LIST_TIMEOUT_MS = 10000;
const MODEL_LOAD_TIMEOUT_MS = 60000;

// Cache for embedding config (loaded from CoS config)
let embeddingConfig = null;
let initialized = false;
let modelEnsured = false;

/**
 * Get the LM Studio base URL from config
 */
function getBaseUrl(config) {
  return config.embeddingEndpoint.replace(/\/v1\/embeddings$/, '');
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
 * case we skip the dance and trust the configured model id. Without this, an
 * Ollama-backed config would 404 the LMS-only URLs on every call (modelEnsured
 * never latches → repeated failed probes per embed).
 */
async function ensureEmbeddingModelLoaded(config) {
  if (modelEnsured) return;

  const allModels = await probeLmStudioModels(config);
  // Not an LM Studio backend (Ollama, etc.) — no load step exists; trust config.
  if (allModels === null) {
    modelEnsured = true;
    return;
  }

  const embeddingModels = allModels.filter(m => m.type === 'embeddings');

  // Check if an embedding model is already loaded
  const loaded = embeddingModels.find(m => m.state === 'loaded');
  if (loaded) {
    config.embeddingModel = loaded.id;
    modelEnsured = true;
    console.log(`📚 Embedding model already loaded: ${loaded.id}`);
    return;
  }

  // No embedding model loaded — try to load the configured one first, then any available
  const candidates = [
    embeddingModels.find(m => m.id.includes(config.embeddingModel)),
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
    modelEnsured = true;
    console.log(`✅ Embedding model loaded: ${modelToLoad.id}`);
  } else {
    const err = await loadResponse.text();
    console.error(`❌ Failed to auto-load embedding model ${modelToLoad.id}: ${err}`);
  }
}

/**
 * Reset initialization so the next embedding call re-reads config.
 */
export function reinitialize() {
  initialized = false;
  modelEnsured = false;
  embeddingConfig = null;
}

/**
 * Initialize embedding config from provider settings
 */
async function initConfig() {
  if (initialized) return;
  initialized = true;

  const cosConfig = await getCosConfig().catch(() => ({}));
  const providerId = cosConfig.embeddingProviderId || 'lmstudio';
  const configModel = cosConfig.embeddingModel || '';

  const provider = await getProviderById(providerId).catch(() => null);
  if (provider?.endpoint) {
    const endpoint = provider.endpoint.endsWith('/v1')
      ? `${provider.endpoint}/embeddings`
      : `${provider.endpoint}/v1/embeddings`;
    embeddingConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      // Track which provider backs embeddings so the LM-Studio-only model
      // auto-load dance (ensureEmbeddingModelLoaded) is skipped for others.
      embeddingProvider: providerId,
      embeddingEndpoint: endpoint,
      // The model id MUST come from config for a non-LM-Studio provider: the
      // DEFAULT model is an LM Studio model name that Ollama doesn't have.
      ...(configModel ? { embeddingModel: configModel } : {})
    };
    console.log(`📚 Memory embeddings using provider ${providerId} (model: ${embeddingConfig.embeddingModel}): ${endpoint}`);
  }
}

/**
 * Get embedding configuration
 */
function getConfig() {
  return embeddingConfig || DEFAULT_MEMORY_CONFIG;
}

/**
 * Set embedding configuration (called by CoS service on startup)
 */
export function setEmbeddingConfig(config) {
  embeddingConfig = { ...DEFAULT_MEMORY_CONFIG, ...config };
}

/**
 * Check if the embedding backend is reachable and an embedding model is usable.
 * Works for any OpenAI-compatible backend (LM Studio, Ollama, …) — all serve
 * `GET /v1/models`.
 */
export async function checkAvailability() {
  await initConfig();
  const config = getConfig();

  const response = await fetch(`${config.embeddingEndpoint.replace('/v1/embeddings', '/v1/models')}`, {
    method: 'GET',
    signal: AbortSignal.timeout(5000)
  }).catch(err => ({ ok: false, _err: err.message }));

  if (!response.ok) {
    return { available: false, error: response._err || `Embedding backend returned ${response.status}`, endpoint: config.embeddingEndpoint };
  }

  const data = await readResponseJson(response);
  const models = data.data?.map(m => m.id) || [];

  // Is this an LM Studio backend? Detect by capability (native API), not id, so
  // a renamed provider still gets the load behavior.
  const lmsModels = await probeLmStudioModels(config);

  if (lmsModels === null) {
    // Non-LM-Studio (Ollama, etc.): the configured model id is authoritative —
    // don't guess from `.includes('embed')` (could latch onto the wrong model).
    // The load dance is a no-op for these backends.
    modelEnsured = true;
    const present = models.some(id => id === config.embeddingModel || id.startsWith(`${config.embeddingModel}:`));
    return { available: true, models, embeddingModel: config.embeddingModel, modelPresent: present, endpoint: config.embeddingEndpoint };
  }

  // LM Studio: auto-load an embedding model if none is loaded, then report
  // whether one is actually loaded so the UI can't show green on an empty LMS.
  const loaded = lmsModels.find(m => m.type === 'embeddings' && m.state === 'loaded');
  if (loaded) {
    config.embeddingModel = loaded.id;
    modelEnsured = true;
  } else {
    await ensureEmbeddingModelLoaded(config).catch(err =>
      console.warn(`⚠️ Could not auto-load embedding model: ${err.message}`)
    );
  }

  return {
    available: true,
    models,
    embeddingModel: config.embeddingModel,
    // `modelEnsured` latches true only once an embeddings model is loaded (here
    // or inside ensureEmbeddingModelLoaded) — the honest model-present signal.
    modelPresent: modelEnsured,
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
  const response = await fetch(config.embeddingEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.embeddingModel, input }),
    signal: AbortSignal.timeout(30000)
  });
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
  await initConfig();
  const config = getConfig();

  if (!text || text.trim().length === 0) {
    return null;
  }

  // Ensure embedding model is loaded before requesting
  if (!modelEnsured) {
    await ensureEmbeddingModelLoaded(config).catch(err =>
      console.warn(`⚠️ Could not ensure embedding model: ${err.message}`)
    );
  }

  let maxChars = embeddingCharBudget(config);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await postEmbedding(config, clampToChars(text, maxChars));
    if (result.ok) return result.data.data?.[0]?.embedding || null;
    if (result.overflow && maxChars > 500) {
      maxChars = Math.floor(maxChars / 2); // undershoot — shrink and retry
      console.warn(`⚠️ Embedding input over context; retrying at ${maxChars} chars`);
      continue;
    }
    console.error(`❌ Embedding generation failed: ${result.error}`);
    return null;
  }
  console.error('❌ Embedding generation failed: input still over context after shrinking');
  return null;
}

/**
 * Generate embeddings for multiple texts (batch).
 *
 * A batch shares one request, so one over-long member would 400 the WHOLE
 * batch. We can't selectively retry inside a batch response, so on a
 * context-overflow rejection we fall back to embedding each input individually
 * (generateEmbedding handles per-item shrink/retry) rather than nulling all.
 */
export async function generateBatchEmbeddings(texts) {
  await initConfig();
  const config = getConfig();

  if (!texts || texts.length === 0) {
    return [];
  }

  // Ensure embedding model is loaded before requesting
  if (!modelEnsured) {
    await ensureEmbeddingModelLoaded(config).catch(err =>
      console.warn(`⚠️ Could not ensure embedding model: ${err.message}`)
    );
  }

  const maxChars = embeddingCharBudget(config);
  const truncatedTexts = texts.map(t => clampToChars(t, maxChars));

  const result = await postEmbedding(config, truncatedTexts);
  if (!result.ok) {
    if (result.overflow) {
      // One member still overflowed — re-embed each individually so the rest
      // aren't lost to a single oversized input.
      console.warn('⚠️ Batch embedding over context; falling back to per-item embedding');
      const out = [];
      for (const t of texts) out.push(await generateEmbedding(t));
      return out;
    }
    console.error(`❌ Batch embedding generation failed: ${result.error}`);
    return texts.map(() => null);
  }

  // Sort by index to maintain order
  const embeddings = new Array(texts.length).fill(null);
  for (const item of result.data.data || []) {
    embeddings[item.index] = item.embedding;
  }

  return embeddings;
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
  await initConfig();
  const config = getConfig();

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

/**
 * Truncate text to fit within token budget
 */
export function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars - 3) + '...';
}
