/**
 * Unified Search Service
 *
 * Fan-out search engine that queries all PortOS data sources in parallel.
 * Uses Promise.allSettled for fault isolation — a failing adapter never
 * blocks results from the other sources.
 *
 * Sources: Brain (inbox/people/projects/ideas/links), CoS Memory (BM25),
 *          Apps, History, Health metrics
 */

import { getInboxLog, getPeople, getProjects, getIdeas, getLinks } from './brainStorage.js';
import { searchBM25 } from './memoryBM25.js';
import { getMemories } from './memory.js';
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

async function searchBrain(query) {
  const q = query.toLowerCase();
  const [inboxResult, peopleResult, projectsResult, ideasResult, linksResult] =
    await Promise.allSettled([
      getInboxLog({ limit: 200 }),
      getPeople(),
      getProjects(),
      getIdeas(),
      getLinks()
    ]);

  const inboxMatches = inboxResult.status === 'fulfilled'
    ? (inboxResult.value.entries ?? [])
        .filter(e => e.text?.toLowerCase().includes(q))
        .map(e => ({
          id: e.id,
          title: (e.text ?? '').substring(0, 60),
          snippet: extractSnippet(e.text, query),
          url: '/brain/inbox',
          type: 'inbox'
        }))
    : [];

  const peopleMatches = peopleResult.status === 'fulfilled'
    ? (peopleResult.value ?? [])
        .filter(p => p.name?.toLowerCase().includes(q) || p.notes?.toLowerCase().includes(q))
        .map(p => ({
          id: p.id,
          title: p.name,
          snippet: extractSnippet(p.notes, query),
          url: '/brain/inbox',
          type: 'person'
        }))
    : [];

  const projectMatches = projectsResult.status === 'fulfilled'
    ? (projectsResult.value ?? [])
        .filter(p => p.name?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q))
        .map(p => ({
          id: p.id,
          title: p.name,
          snippet: extractSnippet(p.description, query),
          url: '/brain/inbox',
          type: 'project'
        }))
    : [];

  const ideaMatches = ideasResult.status === 'fulfilled'
    ? (ideasResult.value ?? [])
        .filter(i => i.title?.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q))
        .map(i => ({
          id: i.id,
          title: i.title,
          snippet: extractSnippet(i.description, query),
          url: '/brain/inbox',
          type: 'idea'
        }))
    : [];

  const linkMatches = linksResult.status === 'fulfilled'
    ? (linksResult.value ?? [])
        .filter(l =>
          l.title?.toLowerCase().includes(q) ||
          l.url?.toLowerCase().includes(q) ||
          l.description?.toLowerCase().includes(q)
        )
        .map(l => ({
          id: l.id,
          title: l.title || l.url,
          snippet: extractSnippet(l.description || l.url, query),
          url: '/brain/inbox',
          type: 'link'
        }))
    : [];

  const results = [
    ...inboxMatches,
    ...peopleMatches,
    ...projectMatches,
    ...ideaMatches,
    ...linkMatches
  ].slice(0, 5);

  return { id: 'brain', label: 'Brain', icon: 'Brain', results };
}

async function searchMemory(query) {
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
