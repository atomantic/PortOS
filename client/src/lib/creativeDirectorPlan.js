// Pure helpers for the Creative Director studio Plan board (CDO Phase 4, #2186).
//
// Pure presentation helpers for the CD studio Plan board (CDO Phase 4) — annotate `plan.steps[]` with
// tool cost-class/timing/approval flags, cost/status summaries, owning-surface deep links, status/cost
// badge tone maps.
//
// The Plan tab renders a directive project's `plan.steps[]` as a step board with
// live status, cost-class badges (hydrated from the creative-tool catalog), run
// timing, and blocked-step triage. These helpers keep that presentation logic
// pure + unit-tested so the component stays a thin renderer. No React, no I/O.

import {
  BUDGETED_COST_CLASSES, COST_CLASSES, COST_FREE, COST_LLM, COST_RENDER, PLAN_STEP_STATUSES,
} from '../../../server/lib/creativeDirectorPresets.js';

// The directive `goal` cap is the server's own (server/lib/creativeBriefLimits.js),
// used as the composer's `maxLength`.
export { CREATIVE_DIRECTOR_GOAL_MAX } from '../../../server/lib/creativeBriefLimits.js';

// The deliverable checklist offered by the directive composer. Free-form on the
// wire (the planner reads the labels as intent); this is the curated menu the UI
// surfaces. `id` is the token stored in `directive.deliverables[]`.
export const DELIVERABLE_OPTIONS = Object.freeze([
  { id: 'story', label: 'Story / series' },
  { id: 'manuscript-polish', label: 'Manuscript polish' },
  { id: 'covers', label: 'Covers' },
  { id: 'video-teaser', label: 'Video teaser' },
  { id: 'concept-art', label: 'Concept art' },
  { id: 'music-bed', label: 'Music bed' },
]);

// Plan-step lifecycle → display metadata.
export const PLAN_STEP_STATUS_META = Object.freeze({
  pending: { label: 'Pending', tone: 'muted' },
  running: { label: 'Running', tone: 'accent' },
  blocked: { label: 'Blocked', tone: 'warning' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  skipped: { label: 'Skipped', tone: 'muted' },
});

// Cost class → display metadata.
export const COST_CLASS_META = Object.freeze({
  [COST_FREE]: { label: 'Free', tone: 'muted' },
  [COST_LLM]: { label: 'LLM', tone: 'accent' },
  [COST_RENDER]: { label: 'Render', tone: 'warning' },
});

// A tone token → Tailwind badge classes (port design tokens). Central so status
// and cost badges stay visually consistent.
export const TONE_BADGE = Object.freeze({
  muted: 'bg-port-border text-port-text',
  accent: 'bg-port-accent/30 text-port-accent',
  warning: 'bg-port-warning/30 text-port-warning',
  success: 'bg-port-success/30 text-port-success',
  error: 'bg-port-error/30 text-port-error',
});

/**
 * Does a step need explicit human approval before dispatch? True when the tool
 * is destructive (delete/overwrite) or a budgeted (llm/render) tool while the
 * shared action budget is exhausted. Absent metadata (unknown tool) never
 * auto-approves — surface it as "unknown" instead.
 *
 * @param {{costClass?: string, destructive?: boolean}|null} meta
 * @param {{withinBudget?: boolean}} [ctx]
 */
export function stepRequiresApproval(meta, { withinBudget } = {}) {
  if (!meta) return false;
  if (meta.destructive) return true;
  if (BUDGETED_COST_CLASSES.has(meta.costClass) && withinBudget === false) return true;
  return false;
}

// Normalize a `toolMap` accessor over either a Map or a plain object.
function resolveMeta(toolMap, name) {
  if (!toolMap) return null;
  if (typeof toolMap.get === 'function') return toolMap.get(name) || null;
  return toolMap[name] || null;
}

/**
 * Annotate a plan's steps with tool metadata, the latest matching run's timing,
 * and gate flags (cost class, longRunning, destructive, requiresApproval,
 * unknownTool). Pure — returns a fresh array; never mutates inputs.
 *
 * @param {Array<object>} steps      plan.steps[]
 * @param {Array<object>} runs       project.runs[] (kind:'plan-step' carry timing)
 * @param {Map|object} toolMap       toolName → { costClass, longRunning, destructive }
 * @param {{withinBudget?: boolean}} [ctx]
 */
export function annotatePlanSteps(steps, runs, toolMap, { withinBudget } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const runList = Array.isArray(runs) ? runs : [];
  // Latest plan-step run per stepId — the board shows the current attempt's timing.
  const runByStep = new Map();
  for (const r of runList) {
    if (!r || r.kind !== 'plan-step' || !r.stepId) continue;
    const prev = runByStep.get(r.stepId);
    if (!prev || new Date(r.startedAt || 0) >= new Date(prev.startedAt || 0)) {
      runByStep.set(r.stepId, r);
    }
  }
  return list.map((s) => {
    const meta = resolveMeta(toolMap, s.toolName);
    const run = runByStep.get(s.stepId) || null;
    return {
      ...s,
      status: s.status || 'pending',
      costClass: meta?.costClass || null,
      longRunning: Boolean(meta?.longRunning),
      destructive: Boolean(meta?.destructive),
      unknownTool: !meta,
      requiresApproval: stepRequiresApproval(meta, { withinBudget }),
      startedAt: run?.startedAt || null,
      completedAt: run?.completedAt || null,
    };
  });
}

/** Count annotated steps by cost class (for the plan summary header). */
export function planCostSummary(annotated) {
  const counts = Object.fromEntries(COST_CLASSES.map((costClass) => [costClass, 0]));
  for (const s of annotated || []) {
    if (Object.hasOwn(counts, s.costClass)) counts[s.costClass] += 1;
  }
  return counts;
}

/** Count annotated steps by lifecycle status (for the progress header). */
export function planStatusSummary(annotated) {
  const counts = Object.fromEntries(PLAN_STEP_STATUSES.map((status) => [status, 0]));
  for (const s of annotated || []) {
    if (Object.hasOwn(counts, s.status)) counts[s.status] += 1;
  }
  return counts;
}

const CREATED_RECORD_ROUTES = Object.freeze({
  pipeline_createSeries: (id) => ({ to: `/pipeline/series/${id}`, label: 'Open series' }),
  universe_createUniverse: (id) => ({ to: `/universes/${id}`, label: 'Open universe' }),
  writersRoom_createWork: (id) => ({ to: `/writers-room/works/${id}`, label: 'Open work' }),
});

/**
 * Resolve a deep link into the owning surface from a step's `result` summary
 * (the compact id-only digest the advance loop writes). Returns `{ to, label }`
 * or null. Resolves primary created-record links from `toolName + r.id` before
 * falling back to secondary keys (so e.g. a series created inside a universe
 * links to the series, not its parent universe).
 */
export function stepResultLink(step) {
  const r = step?.result;
  if (!r || typeof r !== 'object') return null;
  const toolName = typeof step.toolName === 'string' ? step.toolName : '';
  if (r.id) {
    if (Object.hasOwn(CREATED_RECORD_ROUTES, toolName)) return CREATED_RECORD_ROUTES[toolName](r.id);
    // A minted CD sub-project (cd.* tools return an `id`).
    if (toolName.startsWith('cd')) return { to: `/creative-director/${r.id}/overview`, label: 'Open project' };
  }
  if (r.seriesId) return { to: `/pipeline/series/${r.seriesId}`, label: 'Open series' };
  if (r.issueId) return { to: `/pipeline/issues/${r.issueId}`, label: 'Open issue' };
  if (r.universeId) return { to: `/universes/${r.universeId}`, label: 'Open universe' };
  if (r.workId) return { to: `/writers-room/works/${r.workId}`, label: 'Open work' };
  return null;
}

/**
 * Is this project directive-driven (studio mode) vs a legacy video project?
 * The Plan tab renders the composer/empty-state for a bare project and the board
 * once a directive exists.
 */
export function isDirectiveProject(project) {
  return Boolean(project?.directive);
}
