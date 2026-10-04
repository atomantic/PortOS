/**
 * Music Video project index model (#10167): the card pill, version grouping,
 * name filter and "recently touched" order. Pure; the pill reuses the same
 * stage / next-action / attention derivations as the project header so a card
 * and the header never disagree about whether a project needs the director.
 */
import { deriveStages, deriveNextAction, currentProductionRun } from './musicVideoStages.js';
import { deriveAttentionItems } from './musicVideoAttention.js';

const NEEDS_YOU_ACTIONS = new Set([
  'review-production', 'approve-cast-sets', 'resume-cast-sets', 'review-autonomous',
  'resume-autonomous', 'retry-autonomous', 'resume-production',
]);
const RUNNING_ACTIONS = new Set(['stop-production', 'busy', 'render-progress']);

/** Run state for a project card: `{ id, label, tone }` or null when idle. */
export function projectRunPill(project) {
  if (!project) return null;
  const interrupted = project.autonomousRun?.interrupted
    || project.castAndSets?.interrupted
    || currentProductionRun(project)?.interrupted;
  if (interrupted) return { id: 'interrupted', label: 'Interrupted', tone: 'warn' };
  const action = deriveNextAction(project);
  if (deriveAttentionItems(project).length > 0 || NEEDS_YOU_ACTIONS.has(action?.id)) {
    return { id: 'needs-you', label: 'Needs you', tone: 'warn' };
  }
  if (RUNNING_ACTIONS.has(action?.id) || project.status === 'rendering') {
    return { id: 'running', label: 'Running', tone: 'muted' };
  }
  if (deriveStages(project).stages.every((s) => s.state === 'done')) {
    return { id: 'done', label: 'Done', tone: 'ok' };
  }
  return null;
}

const touched = (p) => Date.parse(p?.updatedAt || p?.createdAt) || 0;

/** Most recently updated first (created time breaks ties). */
export function compareMusicVideoProjectsRecentlyTouched(a, b) {
  return touched(b) - touched(a) || (Date.parse(b?.createdAt) || 0) - (Date.parse(a?.createdAt) || 0);
}

/**
 * Collapse forks under their root project. Returns `[{ rootId, versions }]`
 * ordered by the most recent touch of any version; `versions` is newest
 * version first. A name `query` keeps only matching versions.
 */
export function groupMusicVideoProjects(projects, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  const groups = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (needle && !String(project.name || '').toLowerCase().includes(needle)) continue;
    const rootId = project.rootProjectId || project.id;
    if (!groups.has(rootId)) groups.set(rootId, []);
    groups.get(rootId).push(project);
  }
  return [...groups.entries()]
    .map(([rootId, versions]) => ({
      rootId,
      versions: versions.sort((a, b) => (b.version || 1) - (a.version || 1) || compareMusicVideoProjectsRecentlyTouched(a, b)),
      touchedAt: Math.max(...versions.map(touched)),
    }))
    .sort((a, b) => b.touchedAt - a.touchedAt)
    .map(({ rootId, versions }) => ({ rootId, versions }));
}
