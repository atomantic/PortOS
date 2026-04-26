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
// Built-in layouts ship with a `grid` so they look right out-of-the-box
// instead of falling back to the client's row-flow synthesis. The grids
// are designed for a typical desktop viewport (12 cols × ~80px rows): the
// most useful widgets sit in rows 0–7 (~768px) so they're above the fold
// without scrolling, and lower-priority widgets stack below.
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
    // Above-the-fold capture row stretches to h=5 so the Quick Task card
    // can show its expanded options (worktree/PR/simplify/etc.) without
    // forcing a "More options" click. Quick-brain stays small and
    // upcoming-tasks aligns with the taller capture cards.
    grid: [
      // Row 0–4: capture row + tasks
      { id: 'quick-brain',      x: 0,  y: 0,  w: 3, h: 2 },
      { id: 'quick-task',       x: 3,  y: 0,  w: 5, h: 5 },
      { id: 'upcoming-tasks',   x: 8,  y: 0,  w: 4, h: 5 },
      // Row 5–9: primary monitoring + alerts
      { id: 'system-health',    x: 0,  y: 5,  w: 5, h: 5 },
      { id: 'proactive-alerts', x: 5,  y: 5,  w: 3, h: 3 },
      { id: 'death-clock',      x: 8,  y: 5,  w: 4, h: 2 },
      { id: 'review-hub',       x: 5,  y: 8,  w: 3, h: 2 },
      { id: 'activity-streak',  x: 8,  y: 7,  w: 4, h: 3 },
      // Row 10–13: secondary widgets
      { id: 'backup',           x: 0,  y: 10, w: 3, h: 4 },
      { id: 'quick-stats',      x: 3,  y: 10, w: 3, h: 3 },
      { id: 'goal-progress',    x: 6,  y: 10, w: 3, h: 4 },
      // Row 14–17: lower-priority + cos
      { id: 'decision-log',     x: 0,  y: 14, w: 4, h: 2 },
      { id: 'cos',              x: 4,  y: 14, w: 5, h: 4 },
      // Row 18+: full-width visualizations + apps
      { id: 'hourly-activity',  x: 0,  y: 18, w: 12, h: 3 },
      { id: 'apps',             x: 0,  y: 21, w: 12, h: 8 },
    ],
  },
  {
    id: 'focus',
    name: 'Focus',
    builtIn: true,
    widgets: ['quick-task', 'upcoming-tasks', 'cos'],
    // All three widgets above the fold. Quick-task small at top-left for
    // capture; upcoming-tasks tall on the right (the focus list); cos
    // below quick-task for streak/progress context.
    grid: [
      { id: 'quick-task',     x: 0, y: 0, w: 6, h: 2 },
      { id: 'upcoming-tasks', x: 6, y: 0, w: 6, h: 8 },
      { id: 'cos',            x: 0, y: 2, w: 6, h: 6 },
    ],
  },
  {
    id: 'morning-review',
    name: 'Morning Review',
    builtIn: true,
    widgets: ['proactive-alerts', 'upcoming-tasks', 'review-hub', 'goal-progress', 'death-clock'],
    // Scan-and-act morning ritual — all 5 widgets above the fold.
    // Tasks list takes the tall center column (the actionable hot zone);
    // alerts top-left grab attention first; death-clock top-right for
    // mortality framing; review + goals fill the remaining quadrants.
    grid: [
      { id: 'proactive-alerts', x: 0, y: 0, w: 4, h: 4 },
      { id: 'upcoming-tasks',   x: 4, y: 0, w: 5, h: 8 },
      { id: 'death-clock',      x: 9, y: 0, w: 3, h: 2 },
      { id: 'goal-progress',    x: 9, y: 2, w: 3, h: 4 },
      { id: 'review-hub',       x: 0, y: 4, w: 4, h: 4 },
    ],
  },
  {
    id: 'ops',
    name: 'Ops',
    builtIn: true,
    widgets: ['system-health', 'cos', 'backup', 'apps', 'quick-stats'],
    // System monitoring focus — system-health takes the tall left column
    // (the primary alarm surface), cos in the center for ChiefOfStaff
    // status, backup + quick-stats stacked on the right, apps grid fills
    // the empty cell below cos so all 5 widgets fit above the fold.
    grid: [
      { id: 'system-health', x: 0, y: 0, w: 6, h: 5 },
      { id: 'quick-stats',   x: 6, y: 0, w: 6, h: 3 },
      { id: 'cos',           x: 6, y: 3, w: 6, h: 4 },
      { id: 'backup',        x: 0, y: 5, w: 6, h: 3 },
      { id: 'apps',          x: 0, y: 8, w: 12, h: 11 },
    ],
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

// Grid placement bounds. The dashboard is a 12-column responsive grid; rows
// are integer steps (each ~80px tall). GRID_ROW_MAX caps total layout depth
// so a hand-edited file can't push y to absurd values that break the
// container-height calculation in DashboardGrid.jsx.
export const GRID_COLS = 12;
export const GRID_ROW_MAX = 200;
export const GRID_ITEM_H_MAX = 50;

// Clamp a single grid item to valid bounds. Returns null when the entry is
// unusable (missing id, non-numeric coords, etc.). Numeric fields are
// floored before clamping so JSON containing decimals can't smuggle in
// off-grid positions that break the snap math in the client renderer.
const sanitizeGridItem = (g, validIds) => {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.id !== 'string') return null;
  const id = g.id.trim();
  if (!id || !validIds.has(id)) return null;
  const numOr = (v, fallback) => (Number.isFinite(v) ? Math.floor(v) : fallback);
  const x = Math.max(0, Math.min(GRID_COLS - 1, numOr(g.x, 0)));
  const y = Math.max(0, Math.min(GRID_ROW_MAX, numOr(g.y, 0)));
  const wRaw = Math.max(1, Math.min(GRID_COLS, numOr(g.w, 1)));
  const w = Math.min(wRaw, GRID_COLS - x);
  const h = Math.max(1, Math.min(GRID_ITEM_H_MAX, numOr(g.h, 1)));
  return { id, x, y, w, h };
};

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
  // Grid items must reference a widget in the layout's `widgets` list — a
  // grid entry without a matching widget is dead data and would render
  // nothing. Dedup by id so two entries can't both claim the same widget.
  const validIds = new Set(widgets);
  const grid = [];
  const seenGrid = new Set();
  if (Array.isArray(l.grid)) {
    for (const g of l.grid) {
      const item = sanitizeGridItem(g, validIds);
      if (!item) continue;
      if (seenGrid.has(item.id)) continue;
      seenGrid.add(item.id);
      grid.push(item);
    }
  }
  return { id: l.id, name, builtIn: BUILTIN_IDS.has(l.id), widgets, grid };
};

// Bundled so clients can enforce the same limits without duplicating magic
// numbers. Lives on every /api/dashboard/layouts response.
export const LIMITS = Object.freeze({
  idMaxLength: ID_MAX_LENGTH,
  nameMaxLength: NAME_MAX_LENGTH,
  widgetsMax: WIDGETS_MAX,
  widgetIdMaxLength: WIDGET_ID_MAX_LENGTH,
  gridCols: GRID_COLS,
  gridRowMax: GRID_ROW_MAX,
  gridItemHeightMax: GRID_ITEM_H_MAX,
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
