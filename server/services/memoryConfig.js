/**
 * Shared memory configuration defaults.
 *
 * Extracted into its own module to avoid circular dependencies between
 * memoryBackend.js (which re-exports both backends) and the backend
 * implementations (memory.js, memoryDB.js) that it imports.
 */

export const DEFAULT_MEMORY_CONFIG = {
  enabled: true,
  embeddingProvider: 'lmstudio',
  embeddingEndpoint: 'http://localhost:1234/v1/embeddings',
  embeddingModel: 'text-embedding-nomic-embed-text-v2-moe',
  embeddingDimension: 768,
  // Token context window of the embedding model. nomic-embed-text (and most
  // small local embedders) cap at 2048; we truncate input to a safe fraction
  // of this before embedding. A too-long input is rejected outright by the
  // backend ("input length exceeds the context length") and yields a NULL
  // embedding, so this must stay at/under the real model context.
  embeddingMaxTokens: 2048,
  maxMemories: 10000,
  maxContextTokens: 2000,
  minRelevanceThreshold: 0.7,
  autoExtractEnabled: true,
  consolidationIntervalMs: 86400000,
  decayIntervalMs: 86400000
};

/**
 * Generate summary from content using simple truncation
 */
export function generateSummary(content, maxLength = 150) {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength - 3) + '...';
}

/**
 * Decrement agent's pendingApproval count after approve/reject
 */
export async function decrementAgentPendingApproval(sourceAgentId) {
  if (!sourceAgentId) return;

  const { getAgent, updateAgent } = await import('./cos.js');
  const agent = await getAgent(sourceAgentId).catch(() => null);
  if (!agent?.memoryExtraction?.pendingApproval) return;

  const currentPending = agent.memoryExtraction.pendingApproval;
  if (currentPending > 0) {
    await updateAgent(sourceAgentId, {
      memoryExtraction: {
        ...agent.memoryExtraction,
        pendingApproval: currentPending - 1
      }
    });
  }
}
