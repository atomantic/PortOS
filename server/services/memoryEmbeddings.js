/**
 * Memory Embeddings Service
 *
 * Generates vector embeddings using LM Studio's OpenAI-compatible API.
 * Provides semantic search capabilities for the memory system.
 */

import { DEFAULT_MEMORY_CONFIG } from './memory.js';
import { getProviderById } from './providers.js';
import { getConfig as getCosConfig } from './cos.js';

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
 * Discover and auto-load an embedding model in LM Studio.
 * Uses the REST API to find downloaded embedding models and load one if needed.
 */
async function ensureEmbeddingModelLoaded(config) {
  if (modelEnsured) return;

  const baseUrl = getBaseUrl(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  // Query LM Studio's native API for all downloaded models
  const response = await fetch(`${baseUrl}/api/v0/models`, {
    signal: controller.signal
  });
  clearTimeout(timeout);

  if (!response.ok) return;

  const models = await response.json();
  const allModels = models.data || [];
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

  const loadController = new AbortController();
  const loadTimeout = setTimeout(() => loadController.abort(), 60000);
  const loadResponse = await fetch(`${baseUrl}/api/v1/models/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelToLoad.id }),
    signal: loadController.signal
  });
  clearTimeout(loadTimeout);

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
      embeddingEndpoint: endpoint,
      ...(configModel ? { embeddingModel: configModel } : {})
    };
    console.log(`📚 Memory embeddings using provider ${providerId}: ${endpoint}`);
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
 * Check if LM Studio is available and ensure embedding model is loaded
 */
export async function checkAvailability() {
  await initConfig();
  const config = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const response = await fetch(`${config.embeddingEndpoint.replace('/v1/embeddings', '/v1/models')}`, {
    method: 'GET',
    signal: controller.signal
  }).catch(err => {
    clearTimeout(timeout);
    return { ok: false, _err: err.message };
  });

  clearTimeout(timeout);

  if (!response.ok) {
    return { available: false, error: response._err || `LM Studio returned ${response.status}`, endpoint: config.embeddingEndpoint };
  }

  const data = await response.json();
  const models = data.data?.map(m => m.id) || [];

  // If no embedding models are loaded, try to auto-load one
  const hasEmbeddingModel = models.some(id => id.includes('embed'));
  if (!hasEmbeddingModel) {
    await ensureEmbeddingModelLoaded(config).catch(err =>
      console.warn(`⚠️ Could not auto-load embedding model: ${err.message}`)
    );
  } else {
    // Use the loaded embedding model's actual ID
    const embeddingModelId = models.find(id => id.includes('embed'));
    if (embeddingModelId) {
      config.embeddingModel = embeddingModelId;
      modelEnsured = true;
    }
  }

  return {
    available: true,
    models,
    embeddingModel: config.embeddingModel,
    endpoint: config.embeddingEndpoint
  };
}

/**
 * Generate embedding for a single text
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

  // Truncate very long texts to prevent issues
  const maxChars = 8000;
  const truncatedText = text.length > maxChars ? text.substring(0, maxChars) : text;

  const response = await fetch(config.embeddingEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: truncatedText
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`❌ Embedding generation failed: ${error}`);
    return null;
  }

  const data = await response.json();
  return data.data?.[0]?.embedding || null;
}

/**
 * Generate embeddings for multiple texts (batch)
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

  // LM Studio supports batch embeddings via array input
  const maxChars = 8000;
  const truncatedTexts = texts.map(t => t.length > maxChars ? t.substring(0, maxChars) : t);

  const response = await fetch(config.embeddingEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: truncatedTexts
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`❌ Batch embedding generation failed: ${error}`);
    return texts.map(() => null);
  }

  const data = await response.json();

  // Sort by index to maintain order
  const embeddings = new Array(texts.length).fill(null);
  for (const item of data.data || []) {
    embeddings[item.index] = item.embedding;
  }

  return embeddings;
}

/**
 * Generate embedding for memory content + metadata
 * Combines content with type/category/tags for richer semantic representation
 */
export async function generateMemoryEmbedding(memory) {
  const parts = [
    `Type: ${memory.type}`,
    `Category: ${memory.category || 'general'}`,
    memory.tags?.length > 0 ? `Tags: ${memory.tags.join(', ')}` : '',
    memory.summary || '',
    memory.content
  ].filter(Boolean);

  const text = parts.join('\n');
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
 * Estimate token count for text (rough approximation)
 * Used for context budgeting
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // Rough estimate: ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to fit within token budget
 */
export function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars - 3) + '...';
}
