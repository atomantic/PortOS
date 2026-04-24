/**
 * Dashboard Layouts
 *
 * Named, user-customizable dashboard layouts. Each layout stores an ordered
 * list of widget ids; the client's widget registry decides how to render
 * each id. Persisted to data/dashboard-layouts.json.
 *
 * Seeded on first read with the "Everything" layout (id `default`, mirrors
 * the current hardcoded dashboard) plus "Focus", "Morning Review", and "Ops"
 * starter layouts so the feature has value out of the box.
 */

import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../lib/fileUtils.js';

const STATE_PATH = join(PATHS.data, 'dashboard-layouts.json');

// Service errors carry a `code` field so routes can map to HTTP status
// without string-matching on err.message (which breaks on rename/i18n).
export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_BUILTIN_PROTECTED = 'BUILTIN_PROTECTED';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// Widget ids are the contract between this file and the client registry —
// see client/src/components/dashboard/widgetRegistry.jsx. If a layout refers
// to an unknown id, the client skips it gracefully.
const DEFAULT_LAYOUTS = [
  {
    id: 'default',
    name: 'Everything',
    builtIn: true,
    widgets: [
      'quick-brain', 'quick-task',
      'apps',
      'cos', 'goal-progress', 'upcoming-tasks',
      'proactive-alerts', 'review-hub', 'system-health', 'backup', 'death-clock', 'quick-stats', 'decision-log',
      'activity-streak', 'hourly-activity',
    ],
  },
  {
    id: 'focus',
    name: 'Focus',
    builtIn: true,
    widgets: ['quick-task', 'upcoming-tasks', 'cos'],
  },
  {
    id: 'morning-review',
    name: 'Morning Review',
    builtIn: true,
    widgets: ['proactive-alerts', 'upcoming-tasks', 'review-hub', 'goal-progress', 'death-clock'],
  },
  {
    id: 'ops',
    name: 'Ops',
    builtIn: true,
    widgets: ['system-health', 'cos', 'backup', 'apps', 'quick-stats'],
  },
];

const DEFAULT_STATE = {
  activeLayoutId: 'default',
  layouts: DEFAULT_LAYOUTS,
};

const BUILTIN_IDS = new Set(DEFAULT_LAYOUTS.map((l) => l.id));

// Sanitize a single layout entry — protect against hand-edits that produce
// non-object elements, missing fields, non-array widget lists, or duplicate
// widget ids (duplicates would collide on React keys in the grid).
// `builtIn` is derived from the id, not the persisted flag, so flipping the
// flag can't downgrade a built-in into a deletable user layout.
const sanitizeLayout = (l) => {
  if (!l || typeof l !== 'object') return null;
  if (typeof l.id !== 'string' || !l.id) return null;
  if (typeof l.name !== 'string' || !l.name) return null;
  const widgets = [];
  const seen = new Set();
  if (Array.isArray(l.widgets)) {
    for (const w of l.widgets) {
      if (typeof w === 'string' && !seen.has(w)) {
        seen.add(w);
        widgets.push(w);
      }
    }
  }
  return { id: l.id, name: l.name, builtIn: BUILTIN_IDS.has(l.id), widgets };
};

export async function getState() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(STATE_PATH, DEFAULT_STATE, { logError: false });
  const sanitized = Array.isArray(raw.layouts)
    ? raw.layouts.map(sanitizeLayout).filter(Boolean)
    : [];
  const layouts = sanitized.length > 0 ? sanitized : DEFAULT_LAYOUTS;
  const activeLayoutId = layouts.find((l) => l.id === raw.activeLayoutId)
    ? raw.activeLayoutId
    : layouts[0].id;
  return { activeLayoutId, layouts };
}

export async function setActiveLayout(id) {
  const state = await getState();
  if (!state.layouts.find((l) => l.id === id)) {
    throw makeErr(`Unknown layout id: ${id}`, ERR_NOT_FOUND);
  }
  const next = { ...state, activeLayoutId: id };
  await atomicWrite(STATE_PATH, next);
  return next;
}

export async function saveLayout(layout) {
  const state = await getState();
  const idx = state.layouts.findIndex((l) => l.id === layout.id);
  const merged = idx >= 0
    ? state.layouts.map((l, i) => i === idx ? { ...l, ...layout, builtIn: l.builtIn } : l)
    : [...state.layouts, { ...layout, builtIn: false }];
  const next = { ...state, layouts: merged };
  await atomicWrite(STATE_PATH, next);
  return next;
}

export async function deleteLayout(id) {
  const state = await getState();
  const target = state.layouts.find((l) => l.id === id);
  if (!target) throw makeErr(`Unknown layout id: ${id}`, ERR_NOT_FOUND);
  if (target.builtIn) throw makeErr(`Cannot delete built-in layout: ${id}`, ERR_BUILTIN_PROTECTED);
  const remaining = state.layouts.filter((l) => l.id !== id);
  // Guard against the pathological case where the JSON was hand-edited to
  // remove every built-in — fall back to reseeding defaults rather than
  // indexing into an empty array.
  const nextLayouts = remaining.length > 0 ? remaining : DEFAULT_LAYOUTS;
  const activeLayoutId = state.activeLayoutId === id ? nextLayouts[0].id : state.activeLayoutId;
  const next = { activeLayoutId, layouts: nextLayouts };
  await atomicWrite(STATE_PATH, next);
  return next;
}
