/**
 * Memory Retriever Service
 *
 * Retrieves relevant memories for agent context injection.
 * Combines semantic search with importance scoring.
 */

import { getMemories, searchMemories, hybridSearchMemories, getMemory } from './memory.js';
import { generateQueryEmbedding, estimateTokens, truncateToTokens } from './memoryEmbeddings.js';
import { DEFAULT_MEMORY_CONFIG } from './memory.js';

// Search mode preference
const SEARCH_MODE = 'hybrid'; // 'hybrid' | 'vector' | 'bm25'

/**
 * Get relevant memories for a task
 * Returns formatted text ready for injection into agent prompt
 */
export async function getRelevantMemories(task, options = {}) {
  const maxTokens = options.maxTokens || DEFAULT_MEMORY_CONFIG.maxContextTokens;
  const minRelevance = options.minRelevance || DEFAULT_MEMORY_CONFIG.minRelevanceThreshold;

  const memories = [];
  let tokenCount = 0;

  // 1. Search based on task description (hybrid BM25 + vector or vector-only)
  if (task.description) {
    const queryEmbedding = await generateQueryEmbedding(task.description);
    let searchResults = { memories: [] };

    if (SEARCH_MODE === 'hybrid' && queryEmbedding) {
      // Use hybrid BM25 + vector search with reciprocal rank fusion
      searchResults = await hybridSearchMemories(task.description, queryEmbedding, {
        limit: 20,
        minRelevance,
        bm25Weight: 0.4,
        vectorWeight: 0.6
      });
    } else if (queryEmbedding) {
      // Fallback to vector-only search
      searchResults = await searchMemories(queryEmbedding, {
        minRelevance,
        limit: 20
      });
    }

    for (const result of searchResults.memories) {
      const mem = await getMemory(result.id);
      if (mem) {
        const tokens = estimateTokens(mem.content);
        if (tokenCount + tokens <= maxTokens) {
          memories.push({
            ...mem,
            relevance: result.rrfScore || result.similarity || 0.5,
            source: result.searchMethod || 'semantic'
          });
          tokenCount += tokens;
        }
      }
    }
  }

  // 2. Add high-importance preferences (always include user preferences)
  const preferences = await getMemories({
    types: ['preference'],
    status: 'active',
    sortBy: 'importance',
    sortOrder: 'desc',
    limit: 5
  });

  for (const pref of preferences.memories) {
    if (memories.some(m => m.id === pref.id)) continue;

    const mem = await getMemory(pref.id);
    if (mem) {
      const tokens = estimateTokens(mem.content);
      if (tokenCount + tokens <= maxTokens) {
        memories.push({
          ...mem,
          relevance: mem.importance,
          source: 'preference'
        });
        tokenCount += tokens;
      }
    }
  }

  // 3. Add recent high-importance facts about the codebase
  if (task.metadata?.app) {
    const appMemories = await getMemories({
      types: ['fact', 'observation'],
      categories: ['codebase', 'architecture', 'patterns'],
      status: 'active',
      sortBy: 'importance',
      sortOrder: 'desc',
      limit: 5
    });

    for (const appMem of appMemories.memories) {
      if (memories.some(m => m.id === appMem.id)) continue;

      const mem = await getMemory(appMem.id);
      if (mem) {
        const tokens = estimateTokens(mem.content);
        if (tokenCount + tokens <= maxTokens) {
          memories.push({
            ...mem,
            relevance: mem.importance * 0.8,
            source: 'codebase'
          });
          tokenCount += tokens;
        }
      }
    }
  }

  // Sort by relevance
  memories.sort((a, b) => b.relevance - a.relevance);

  return memories;
}

/**
 * Format memories for prompt injection
 */
export function formatForPrompt(memories) {
  if (!memories || memories.length === 0) {
    return '';
  }

  const sections = {
    preference: [],
    fact: [],
    learning: [],
    observation: [],
    decision: [],
    context: []
  };

  for (const memory of memories) {
    const type = memory.type || 'context';
    if (sections[type]) {
      sections[type].push(memory);
    }
  }

  const lines = ['## Relevant Context from Memory\n'];

  // Format preferences first (most important)
  if (sections.preference.length > 0) {
    lines.push('### User Preferences');
    for (const mem of sections.preference) {
      lines.push(`- ${mem.content}`);
    }
    lines.push('');
  }

  // Format facts about codebase
  if (sections.fact.length > 0) {
    lines.push('### Codebase Facts');
    for (const mem of sections.fact) {
      lines.push(`- ${mem.content}`);
    }
    lines.push('');
  }

  // Format learnings
  if (sections.learning.length > 0) {
    lines.push('### Previous Learnings');
    for (const mem of sections.learning) {
      lines.push(`- ${mem.content}`);
    }
    lines.push('');
  }

  // Format observations
  if (sections.observation.length > 0) {
    lines.push('### Observations');
    for (const mem of sections.observation) {
      lines.push(`- ${mem.content}`);
    }
    lines.push('');
  }

  // Format decisions
  if (sections.decision.length > 0) {
    lines.push('### Past Decisions');
    for (const mem of sections.decision) {
      lines.push(`- ${mem.content}`);
    }
    lines.push('');
  }

  // Format context
  if (sections.context.length > 0) {
    lines.push('### Additional Context');
    for (const mem of sections.context) {
      lines.push(`- ${mem.content}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get memory section for agent prompt
 * Main entry point for subAgentSpawner integration
 */
export async function getMemorySection(task, options = {}) {
  const memories = await getRelevantMemories(task, options);

  if (memories.length === 0) {
    return null;
  }

  return formatForPrompt(memories);
}

/**
 * Get memory stats for a task (useful for debugging)
 */
export async function getRetrievalStats(task) {
  const memories = await getRelevantMemories(task, { maxTokens: 10000 });

  return {
    total: memories.length,
    byType: memories.reduce((acc, m) => {
      acc[m.type] = (acc[m.type] || 0) + 1;
      return acc;
    }, {}),
    bySource: memories.reduce((acc, m) => {
      acc[m.source] = (acc[m.source] || 0) + 1;
      return acc;
    }, {}),
    totalTokens: memories.reduce((acc, m) => acc + estimateTokens(m.content), 0),
    topMemories: memories.slice(0, 5).map(m => ({
      type: m.type,
      summary: m.summary,
      relevance: m.relevance.toFixed(2)
    }))
  };
}
