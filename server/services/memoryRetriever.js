/**
 * Memory Retriever Service
 *
 * Retrieves relevant memories for agent context injection.
 * Combines semantic search with importance scoring.
 */

import { getMemories, searchMemories, hybridSearchMemories, peekMemories, recordMemoryAccess, DEFAULT_MEMORY_CONFIG } from './memoryBackend.js';
import { generateQueryEmbedding, estimateTokens } from './memoryEmbeddings.js';
import { fenceBlock, UNTRUSTED_REFERENCE_NOTICE } from '../lib/promptFencing.js';
import { isPersistentMindPrivateMemory } from '../lib/memoryQuery.js';

// Search mode preference: 'hybrid' (FTS + vector) or 'vector' (embedding-only)
const SEARCH_MODE = 'hybrid';

// The memory types formatForPrompt renders; any other type is left out of the prompt.
const FORMATTED_TYPES = new Set(['preference', 'fact', 'learning', 'observation', 'decision', 'context']);

/**
 * Get relevant memories for a task
 * Returns formatted text ready for injection into agent prompt
 */
export async function getRelevantMemories(task, options = {}) {
  const maxTokens = options.maxTokens || DEFAULT_MEMORY_CONFIG.maxContextTokens;
  const minRelevance = options.minRelevance || DEFAULT_MEMORY_CONFIG.minRelevanceThreshold;
  // Cap the semantic-search fan-out. Callers that only inject a handful of
  // memories (e.g. voice's buildMemoryContext) pass a small `limit` so retrieval
  // doesn't fetch 20 rows just to slice down to 5. Search results are
  // relevance-sorted, so the top-`limit` are the most relevant. Defaults to 20
  // (prior behavior) when unset; the token budget still applies on top.
  const searchLimit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 20;

  // Preference and codebase lists do not depend on the semantic search, and
  // none of them needs a total count. Start them together so the three
  // stages overlap instead of stacking.
  const searchPromise = task.description
    ? retrieveSearchHits(task.description, { searchLimit, minRelevance })
    : Promise.resolve([]);
  const preferencePromise = getMemories({
    types: ['preference'],
    status: 'active',
    sortBy: 'importance',
    sortOrder: 'desc',
    limit: 5,
    includeCount: false,
    excludePersistentMind: true,
  });
  const codebasePromise = task.metadata?.app
    ? getMemories({
      types: ['fact', 'observation'],
      categories: ['codebase', 'architecture', 'patterns'],
      status: 'active',
      sortBy: 'importance',
      sortOrder: 'desc',
      limit: 5,
      includeCount: false,
      excludePersistentMind: true,
    })
    : Promise.resolve({ memories: [] });

  const [searchHits, preferences, codebase] = await Promise.all([
    searchPromise,
    preferencePromise,
    codebasePromise,
  ]);
  const preferenceHits = preferences.memories || [];
  const codebaseHits = codebase.memories || [];

  const candidateIds = [];
  const seen = new Set();
  const pushId = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    candidateIds.push(id);
  };
  for (const hit of searchHits) pushId(hit.id);
  for (const hit of preferenceHits) pushId(hit.id);
  for (const hit of codebaseHits) pushId(hit.id);

  // One hydration for every candidate. Rows the token budget later drops
  // were still read, but they are not written: access bumps happen below,
  // only for memories that fit.
  const hydrated = candidateIds.length > 0 ? await peekMemories(candidateIds) : [];
  // A file index or result from before a concurrent update can have stale tags.
  const byId = new Map(hydrated
    .filter(memory => memory && !isPersistentMindPrivateMemory(memory))
    .map(memory => [memory.id, memory]));

  const memories = [];
  let tokenCount = 0;
  const consider = (id, relevance, source) => {
    if (memories.some(memory => memory.id === id)) return;
    const memory = byId.get(id);
    if (!memory) return;
    const tokens = estimateTokens(memory.content);
    if (tokenCount + tokens <= maxTokens) {
      memories.push({ ...memory, relevance, source });
      tokenCount += tokens;
    }
  };

  // Precedence is unchanged: search hits, then preferences, then codebase
  // facts. The budget is applied in that order before the relevance sort.
  for (const hit of searchHits) {
    consider(hit.id, hit.rrfScore || hit.similarity || 0.5, hit.searchMethod || 'semantic');
  }
  for (const hit of preferenceHits) {
    const memory = byId.get(hit.id);
    if (memory) consider(hit.id, memory.importance, 'preference');
  }
  for (const hit of codebaseHits) {
    const memory = byId.get(hit.id);
    if (memory) consider(hit.id, memory.importance * 0.8, 'codebase');
  }

  memories.sort((a, b) => b.relevance - a.relevance);

  // recordMemoryAccess returns how many rows changed. The prompt uses the
  // peeked text, so a missing counter on the returned object is fine.
  if (memories.length > 0) await recordMemoryAccess(memories.map(memory => memory.id));

  return memories;
}

async function retrieveSearchHits(description, { searchLimit, minRelevance }) {
  const queryEmbedding = await generateQueryEmbedding(description);
  if (SEARCH_MODE === 'hybrid' && queryEmbedding) {
    const searchResults = await hybridSearchMemories(description, queryEmbedding, {
      limit: searchLimit,
      minRelevance,
      excludePersistentMind: true,
      ftsWeight: 0.4,
      vectorWeight: 0.6
    });
    return searchResults.memories || [];
  }
  if (queryEmbedding) {
    const searchResults = await searchMemories(queryEmbedding, {
      minRelevance,
      limit: searchLimit,
      excludePersistentMind: true,
    });
    return searchResults.memories || [];
  }
  return [];
}

/**
 * Format memories for prompt injection
 */
export function formatForPrompt(memories, maxTokens = DEFAULT_MEMORY_CONFIG.maxContextTokens) {
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

  const label = 'Memory reference data';
  // Include the notice, delimiters and possible truncation marker in the same
  // budget used for retrieval; an oversized preference cannot crowd them out.
  const overhead = UNTRUSTED_REFERENCE_NOTICE.length + 2
    + fenceBlock(label, 'x', 1).length - 1 + '\n… [truncated]'.length;
  const block = fenceBlock(label, lines.join('\n'), Math.max(0, maxTokens * 4 - overhead));
  return block ? `${UNTRUSTED_REFERENCE_NOTICE}\n\n${block}` : '';
}

/**
 * Get memory section for agent prompt
 * Main entry point for subAgentSpawner integration
 */
export async function getMemorySection(task, options = {}) {
  const { section, injected } = await getMemoryInjection(task, options);
  // Lets a caller that builds a run record (agentPromptBuilder) capture the
  // lineage without changing this function's string-or-null return contract.
  if (typeof options.onInjected === 'function') options.onInjected(injected);
  return section;
}

/**
 * Same retrieval as getMemorySection, but also reports WHICH memories made it
 * into the prompt text: `injected: [{ id, version, relevance }]`. `version` is
 * null until memory versioning lands. Only memories the formatter actually
 * renders are listed (an unrecognised type is dropped from the prompt, so it is
 * dropped here too); `section` is null when nothing relevant was found.
 */
async function getMemoryInjection(task, options = {}) {
  const memories = await getRelevantMemories(task, options);

  if (memories.length === 0) {
    return { section: null, injected: [] };
  }

  const section = formatForPrompt(memories, options.maxTokens);
  const injected = section
    ? memories
      .filter(m => FORMATTED_TYPES.has(m.type || 'context'))
      .map(m => ({ id: m.id, version: m.version ?? null, relevance: m.relevance ?? null }))
    : [];
  return { section: section || null, injected };
}
