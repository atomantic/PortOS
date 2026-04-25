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

// Shape constraints shared with routes/dashboardLayouts.js#layoutSchema.
// Exported so routes build their Zod schema from the same source; edits
// here automatically flow to the API boundary.
export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ID_MAX_LENGTH = 60;
export const NAME_MAX_LENGTH = 80;
export const WIDGETS_MAX = 50;
export const WIDGET_ID_MAX_LENGTH = 80;

// Sanitize a single layout entry — protect against hand-edits that produce
// non-object elements, missing fields, non-array widget lists, or duplicate
// widget ids (duplicates would collide on React keys in the grid).
// `builtIn` is derived from the id, not the persisted flag, so flipping the
// flag can't downgrade a built-in into a deletable user layout.
const sanitizeLayout = (l) => {
  if (!l || typeof l !== 'object') return null;
  if (typeof l.id !== 'string' || !ID_PATTERN.test(l.id) || l.id.length > ID_MAX_LENGTH) return null;
  if (typeof l.name !== 'string' || !l.name) return null;
  const name = l.name.slice(0, NAME_MAX_LENGTH);
  const widgets = [];
  const seen = new Set();
  if (Array.isArray(l.widgets)) {
    for (const w of l.widgets) {
      if (typeof w !== 'string') continue;
      // Trim first so hand-edited JSON ("apps ") normalizes to the
      // canonical id and dedup catches whitespace-only duplicates.
      const widgetId = w.trim();
      if (!widgetId || widgetId.length > WIDGET_ID_MAX_LENGTH) continue;
      if (seen.has(widgetId)) continue;
      seen.add(widgetId);
      widgets.push(widgetId);
      if (widgets.length >= WIDGETS_MAX) break;
    }
  }
  return { id: l.id, name, builtIn: BUILTIN_IDS.has(l.id), widgets };
};

// Bundled so clients can enforce the same limits without duplicating magic
// numbers. Lives on every /api/dashboard/layouts response.
export const LIMITS = Object.freeze({
  idMaxLength: ID_MAX_LENGTH,
  nameMaxLength: NAME_MAX_LENGTH,
  widgetsMax: WIDGETS_MAX,
  widgetIdMaxLength: WIDGET_ID_MAX_LENGTH,
});

export async function getState() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(STATE_PATH, DEFAULT_STATE, { logError: false });
  const sanitized = [];
  const seenIds = new Set();
  if (Array.isArray(raw.layouts)) {
    for (const entry of raw.layouts) {
      const s = sanitizeLayout(entry);
      if (!s || seenIds.has(s.id)) continue; // first-occurrence wins; no React key collisions
      seenIds.add(s.id);
      sanitized.push(s);
    }
  }
  const layouts = sanitized.length > 0 ? sanitized : DEFAULT_LAYOUTS;
  const activeLayoutId = layouts.find((l) => l.id === raw.activeLayoutId)
    ? raw.activeLayoutId
    : layouts[0].id;
  return { activeLayoutId, layouts, limits: LIMITS };
}

export async function setActiveLayout(id) {
  const state = await getState();
  if (!state.layouts.find((l) => l.id === id)) {
    throw makeErr(`Unknown layout id: ${id}`, ERR_NOT_FOUND);
  }
  const next = { activeLayoutId: id, layouts: state.layouts };
  await atomicWrite(STATE_PATH, next);
  return { ...next, limits: LIMITS };
}

export async function saveLayout(layout) {
  const state = await getState();
  const idx = state.layouts.findIndex((l) => l.id === layout.id);
  // Derive `builtIn` from BUILTIN_IDS at write-time (not from the persisted
  // flag) so a hand-edited JSON that deleted the default `ops` entry can't
  // produce a new `ops` that sanitizeLayout() later treats as built-in while
  // the write-path echoed `builtIn: false` to the client.
  const builtIn = BUILTIN_IDS.has(layout.id);
  const merged = idx >= 0
    ? state.layouts.map((l, i) => i === idx ? { ...l, ...layout, builtIn } : l)
    : [...state.layouts, { ...layout, builtIn }];
  const next = { activeLayoutId: state.activeLayoutId, layouts: merged };
  await atomicWrite(STATE_PATH, next);
  return { ...next, limits: LIMITS };
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
  return { ...next, limits: LIMITS };
}
