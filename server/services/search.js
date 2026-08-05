/**
 * Unified Search Service
 *
 * Fan-out search engine that queries all PortOS data sources in parallel.
 * Uses Promise.allSettled for fault isolation — a failing adapter never
 * blocks results from the other sources.
 *
 * Sources: Brain (inbox/people/projects/ideas/admin/memories/links, served from
 *          the in-memory projections in brainSearchIndex.js), CoS Memory
 *          (BM25/hybrid), Apps, History, Health metrics
 */

import { getBrainProjections } from './brainSearchIndex.js';
import { searchBM25 } from './memoryBM25.js';
import { getMemories, ensureBackend, hybridSearchMemories } from './memoryBackend.js';
import { getAllApps } from './apps.js';
import { getHistory } from './history.js';

// =============================================================================
// SNIPPET HELPER
// =============================================================================

/**
 * Extract a ~100-char window around the first keyword match in text.
 * Prepends/appends '...' when the excerpt is not at the text boundary.
 */
function extractSnippet(text, query, maxLen = 100) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) {
    return text.substring(0, maxLen);
  }
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, start + maxLen);
  const excerpt = text.substring(start, end);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return prefix + excerpt + suffix;
}

// =============================================================================
// SOURCE ADAPTERS
// =============================================================================

// Deep link into the Brain memory view for the id-addressed entity types.
const brainMemoryUrl = (type) => (record) => `/brain/memory?type=${type}&id=${record.id}`;

/**
 * Brain sources, in the order their matches appear in the result list.
 *
 * `match` names the fields a query is tested against; they must stay a subset
 * of the fields `brainSearchIndex` projects for that type, or the match
 * silently stops working.
 */
const BRAIN_SOURCES = Object.freeze([
  {
    type: 'inbox',
    resultType: 'inbox',
    match: ['capturedText'],
    title: (r) => (r.capturedText ?? '').substring(0, 60),
    snippet: (r) => r.capturedText,
    url: () => '/brain/inbox'
  },
  {
    type: 'people',
    resultType: 'person',
    match: ['name', 'context'],
    title: (r) => r.name,
    snippet: (r) => r.context,
    url: brainMemoryUrl('people')
  },
  {
    type: 'projects',
    resultType: 'project',
    match: ['name', 'notes'],
    title: (r) => r.name,
    snippet: (r) => r.notes,
    url: brainMemoryUrl('projects')
  },
  {
    type: 'ideas',
    resultType: 'idea',
    match: ['title', 'oneLiner', 'notes'],
    title: (r) => r.title,
    snippet: (r) => r.oneLiner || r.notes,
    url: brainMemoryUrl('ideas')
  },
  {
    type: 'admin',
    resultType: 'admin',
    match: ['title', 'notes', 'nextAction'],
    title: (r) => r.title,
    snippet: (r) => r.notes || r.nextAction,
    url: brainMemoryUrl('admin')
  },
  {
    type: 'memories',
    resultType: 'memory-entry',
    match: ['title', 'content', 'mood'],
    title: (r) => r.title,
    snippet: (r) => r.content,
    url: brainMemoryUrl('memories')
  },
  {
    type: 'links',
    resultType: 'link',
    match: ['title', 'url', 'description'],
    title: (r) => r.title || r.url,
    snippet: (r) => r.description || r.url,
    url: () => '/brain/links'
  }
]);

/**
 * Search the brain entity stores.
 *
 * Reads field projections from `brainSearchIndex` rather than
 * `brainStorage.getAll()`, so a keystroke costs an in-memory scan instead of a
 * full stat+read+parse of every record file across seven collection dirs
 * (issue #3506). The index also removes the old `limit: 200` cap on inbox
 * entries — that cap existed only to bound the per-query disk cost.
 */
async function searchBrain(query) {
  const q = query.toLowerCase();
  // allSettled per source: one unreadable store never blanks the others.
  const settled = await Promise.allSettled(BRAIN_SOURCES.map((s) => getBrainProjections(s.type)));

  const results = BRAIN_SOURCES.flatMap((source, i) => {
    const outcome = settled[i];
    if (outcome.status !== 'fulfilled') return [];
    return (outcome.value ?? [])
      .filter((r) => source.match.some((f) => typeof r[f] === 'string' && r[f].toLowerCase().includes(q)))
      .map((r) => ({
        id: r.id,
        title: source.title(r),
        snippet: extractSnippet(source.snippet(r), query),
        url: source.url(r),
        type: source.resultType
      }));
  }).slice(0, 8);

  return { id: 'brain', label: 'Brain', icon: 'Brain', results };
}

async function searchMemory(query) {
  const activeBackend = await ensureBackend();

  // Postgres backend: use hybrid search (tsvector full-text, no embedding needed)
  if (activeBackend === 'postgres') {
    const searchResult = await hybridSearchMemories(query, null, { limit: 10 });
    const results = (searchResult?.memories ?? [])
      .map(mem => {
        const summary = mem.summary ?? '';
        return {
          id: mem.id,
          title: summary.substring(0, 60),
          snippet: summary,
          url: '/cos/memory',
          type: 'memory'
        };
      })
      .slice(0, 5);
    return { id: 'memory', label: 'Memory', icon: 'Cpu', results };
  }

  // File backend: use BM25 index + getMemories for metadata
  const [bm25Results, memoriesResult] = await Promise.allSettled([
    searchBM25(query, { limit: 10, threshold: 0.1 }),
    getMemories()
  ]);

  if (bm25Results.status !== 'fulfilled' || memoriesResult.status !== 'fulfilled') {
    return { id: 'memory', label: 'Memory', icon: 'Cpu', results: [] };
  }

  const hits = bm25Results.value ?? [];
  const allMemories = memoriesResult.value?.memories ?? [];
  const memoryMap = new Map(allMemories.map(m => [m.id, m]));

  const results = hits
    .map(hit => {
      const mem = memoryMap.get(hit.id);
      if (!mem) return null;
      const summary = mem.summary ?? mem.content?.substring(0, 150) ?? '';
      return {
        id: mem.id,
        title: summary.substring(0, 60),
        snippet: summary,
        url: '/cos/memory',
        type: 'memory'
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  return { id: 'memory', label: 'Memory', icon: 'Cpu', results };
}

async function searchApps(query) {
  const q = query.toLowerCase();
  const apps = await getAllApps({ includeArchived: false });
  const results = (apps ?? [])
    .filter(a => a.name?.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q))
    .map(a => ({
      id: a.id,
      title: a.name,
      snippet: extractSnippet(a.description, query),
      url: '/apps',
      type: 'app'
    }))
    .slice(0, 5);

  return { id: 'apps', label: 'Apps', icon: 'Package', results };
}

async function searchHistory(query) {
  const q = query.toLowerCase();
  const { entries } = await getHistory({ limit: 500 });
  const results = (entries ?? [])
    .filter(e => e.targetName?.toLowerCase().includes(q) || e.action?.toLowerCase().includes(q))
    .map(e => ({
      id: e.id,
      title: e.targetName || e.action,
      snippet: extractSnippet((e.action ?? '') + ' ' + (e.targetName ?? ''), query),
      url: '/devtools/history',
      type: 'history'
    }))
    .slice(0, 5);

  return { id: 'history', label: 'History', icon: 'History', results };
}

const HEALTH_METRICS = [
  'step_count',
  'heart_rate',
  'sleep_analysis',
  'hrv',
  'blood_pressure',
  'body_mass',
  'respiratory_rate',
  'blood_glucose',
  'body_temperature'
];

const HEALTH_DISPLAY_NAMES = {
  step_count: 'Steps',
  heart_rate: 'Heart Rate',
  sleep_analysis: 'Sleep',
  hrv: 'HRV',
  blood_pressure: 'Blood Pressure',
  body_mass: 'Body Mass',
  respiratory_rate: 'Respiratory Rate',
  blood_glucose: 'Blood Glucose',
  body_temperature: 'Body Temperature'
};

function searchHealth(query) {
  const q = query.toLowerCase();
  const results = HEALTH_METRICS
    .filter(key => {
      const displayName = HEALTH_DISPLAY_NAMES[key] ?? key;
      return key.toLowerCase().includes(q) || displayName.toLowerCase().includes(q);
    })
    .map(key => {
      const displayName = HEALTH_DISPLAY_NAMES[key] ?? key;
      return {
        id: key,
        title: displayName,
        snippet: `${displayName} health metric data`,
        url: '/meatspace/health',
        type: 'health-metric'
      };
    });

  return { id: 'health', label: 'Health', icon: 'HeartPulse', results };
}

// =============================================================================
// FAN-OUT ENGINE
// =============================================================================

const ADAPTERS = ['brain', 'memory', 'apps', 'history', 'health'];

/**
 * Fan out a keyword query to all PortOS data sources in parallel.
 * Returns an array of non-empty source result objects.
 */
export async function fanOutSearch(query) {
  console.log(`🔍 Search fan-out for "${query}" across ${ADAPTERS.length} sources`);

  const [brainResult, memoryResult, appsResult, historyResult, healthResult] =
    await Promise.allSettled([
      searchBrain(query),
      searchMemory(query),
      searchApps(query),
      searchHistory(query),
      Promise.resolve(searchHealth(query))
    ]);

  const FALLBACKS = [
    { id: 'brain', label: 'Brain', icon: 'Brain', results: [] },
    { id: 'memory', label: 'Memory', icon: 'Cpu', results: [] },
    { id: 'apps', label: 'Apps', icon: 'Package', results: [] },
    { id: 'history', label: 'History', icon: 'History', results: [] },
    { id: 'health', label: 'Health', icon: 'HeartPulse', results: [] }
  ];

  const settled = [brainResult, memoryResult, appsResult, historyResult, healthResult];
  const sources = settled.map((r, i) => r.status === 'fulfilled' ? r.value : FALLBACKS[i]);
  const nonEmpty = sources.filter(s => s.results.length > 0);

  const totalResults = nonEmpty.reduce((sum, s) => sum + s.results.length, 0);
  console.log(`✅ Search complete for "${query}": ${totalResults} results across ${nonEmpty.length} sources`);

  return nonEmpty;
}
