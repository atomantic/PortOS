/**
 * Memory Embeddings Service
 *
 * Generates vector embeddings using LM Studio's OpenAI-compatible API.
 * Provides semantic search capabilities for the memory system.
 */

import { DEFAULT_MEMORY_CONFIG } from './memory.js';
import { getProviderById } from './providers.js';

// Cache for embedding config (loaded from CoS config)
let embeddingConfig = null;
let initialized = false;

/**
 * Initialize embedding config from provider settings
 */
async function initConfig() {
  if (initialized) return;
  initialized = true;

  const provider = await getProviderById('lmstudio').catch(() => null);
  if (provider?.endpoint) {
    const endpoint = provider.endpoint.endsWith('/v1')
      ? `${provider.endpoint}/embeddings`
      : `${provider.endpoint}/v1/embeddings`;
    embeddingConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      embeddingEndpoint: endpoint
    };
    console.log(`📚 Memory embeddings using provider endpoint: ${endpoint}`);
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
 * Check if LM Studio is available
 */
export async function checkAvailability() {
  await initConfig();
  const config = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${config.embeddingEndpoint.replace('/v1/embeddings', '/v1/models')}`, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { available: false, error: `LM Studio returned ${response.status}`, endpoint: config.embeddingEndpoint };
    }

    const data = await response.json();
    return {
      available: true,
      models: data.data?.map(m => m.id) || [],
      endpoint: config.embeddingEndpoint
    };
  } catch (err) {
    clearTimeout(timeout);
    return { available: false, error: err.message, endpoint: config.embeddingEndpoint };
  }
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
