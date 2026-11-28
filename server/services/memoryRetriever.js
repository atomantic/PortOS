/**
 * Memory Retriever Service
 *
 * Retrieves relevant memories for agent context injection.
 * Combines semantic search with importance scoring.
 */

import { getMemories, hybridSearchMemories, peekMemories, recordMemoryAccess, DEFAULT_MEMORY_CONFIG } from './memoryBackend.js';
import { generateQueryEmbedding, estimateTokens } from './memoryEmbeddings.js';
import { fenceBlock, neutralizeFences, UNTRUSTED_REFERENCE_NOTICE } from '../lib/promptFencing.js';
import { isPersistentMindPrivateMemory } from '../lib/memoryQuery.js';

const MEMORY_HEADINGS = {
  preference: 'User Preferences',
  fact: 'Codebase Facts',
  learning: 'Previous Learnings',
  observation: 'Observations',
  decision: 'Past Decisions',
  context: 'Additional Context',
};

/** Retrieve relevant memories and record access for the selected list (used by voice). */
export async function getRelevantMemories(task, options = {}) {
  const memories = await selectMemories(task, options);
  if (memories.length > 0) await recordMemoryAccess(memories.map(memory => memory.id));
  return memories;
}

async function selectMemories(task, options) {
  const maxTokens = options.maxTokens || DEFAULT_MEMORY_CONFIG.maxContextTokens;
  const minRelevance = options.minRelevance || DEFAULT_MEMORY_CONFIG.minRelevanceThreshold;
  // Background jobs may search their own app's memories only. A missing app
  // is not permission to fall back to a search of the user's entire Brain.
  const appId = task.metadata?.app;
  if (options.scopedToApp && (!appId || !task.description?.trim())) return [];
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
    ? retrieveSearchHits(task.description, { searchLimit, minRelevance, appId: options.scopedToApp ? appId : undefined })
    : Promise.resolve([]);
  const preferencePromise = options.scopedToApp ? Promise.resolve({ memories: [] }) : getMemories({
    types: ['preference'],
    status: 'active',
    sortBy: 'importance',
    sortOrder: 'desc',
    limit: 5,
    includeCount: false,
    excludePersistentMind: true,
  });
  const codebasePromise = !options.scopedToApp && appId
    ? getMemories({
      types: ['fact', 'observation'],
      categories: ['codebase', 'architecture', 'patterns'],
      appId: task.metadata.app,
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

  // Hydrate candidates without bumping access before the consumer selects its final list.
  const hydrated = candidateIds.length > 0 ? await peekMemories(candidateIds) : [];
  // A file index or result from before a concurrent update can have stale tags.
  const byId = new Map(hydrated
    .filter(memory => memory && !isPersistentMindPrivateMemory(memory)
      && (!options.scopedToApp || (memory.sourceAppId === appId && memory.status === 'active')))
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

  return memories;
}

async function retrieveSearchHits(description, { searchLimit, minRelevance, appId }) {
  const queryEmbedding = await generateQueryEmbedding(description);
  const searchResults = await hybridSearchMemories(description, queryEmbedding, {
    limit: searchLimit,
    minRelevance,
    ...(appId ? { appId } : {}),
    excludePersistentMind: true,
    ftsWeight: 0.4,
    vectorWeight: 0.6,
    lexicalMatch: queryEmbedding ? 'all' : 'any',
  });
  return searchResults.memories || [];
}

function formatForPrompt(memories, maxTokens = DEFAULT_MEMORY_CONFIG.maxContextTokens) {
  if (memories.length === 0) return { section: null, visibleMemories: [] };

  const label = 'Memory reference data';
  // Reserve room for the notice, delimiters and possible truncation marker.
  const overhead = UNTRUSTED_REFERENCE_NOTICE.length + 2
    + fenceBlock(label, 'x', 1).length - 1 + '\n… [truncated]'.length;
  const maxBodyChars = Math.max(0, maxTokens * 4 - overhead);

  const sections = Object.groupBy(memories, memory => memory.type || 'context');
  const visible = new Set();
  let body = '## Relevant Context from Memory\n';
  for (const [type, heading] of Object.entries(MEMORY_HEADINGS)) {
    const sectionMemories = sections[type];
    if (!sectionMemories) continue;
    body += `\n### ${heading}\n`;
    for (const memory of sectionMemories) {
      body += '- ';
      // Use the neutralized length so positions match the body fenceBlock caps.
      const content = neutralizeFences(memory.content);
      const visibleContent = content.trimStart();
      const contentStart = body.length + content.length - visibleContent.length;
      if (visibleContent && contentStart + 1 <= maxBodyChars) visible.add(memory);
      body += `${content}\n`;
    }
  }

  const block = fenceBlock(label, body, maxBodyChars);
  return {
    section: block ? `${UNTRUSTED_REFERENCE_NOTICE}\n\n${block}` : null,
    visibleMemories: block ? memories.filter(memory => visible.has(memory)) : [],
  };
}

const PREVIEW_CHARS = 120;

// A short, single-line snapshot of what was sent, so the agent card can name
// each memory instead of showing only its id.
function memoryPreview(memory) {
  const text = (memory.summary?.trim() || memory.content?.trim() || '').replace(/\s+/g, ' ');
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** Get the fenced memory section and report the memories that contributed content. */
export async function getMemorySection(task, options = {}) {
  const memories = await selectMemories(task, options);
  const { section, visibleMemories } = formatForPrompt(memories, options.maxTokens);

  if (visibleMemories.length > 0) await recordMemoryAccess(visibleMemories.map(memory => memory.id));
  if (typeof options.onInjected === 'function') {
    options.onInjected(visibleMemories.map(memory => ({
      id: memory.id,
      version: memory.version ?? null,
      relevance: memory.relevance ?? null,
      preview: memoryPreview(memory),
    })));
  }
  return section;
}
