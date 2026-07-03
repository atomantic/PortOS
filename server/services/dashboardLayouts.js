/**
 * Dashboard Layouts
 *
 * Named, user-customizable dashboard layouts. Each layout stores an ordered
 * list of widget ids; the client's widget registry decides how to render
 * each id. Persisted to data/dashboard-layouts.json.
 *
 * Built-ins seeded on first read: Everything, Focus, Morning Review, Ops,
 * Deep Work, Health, Agent Watch. The intent-named trio (Deep Work / Health
 * / Agent Watch) is also exported as INTENT_LAYOUTS so migration 030 can
 * seed them into existing installs without forking the grid geometry.
 */

import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { HHMM_STRICT_RE } from '../lib/timezone.js';

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

// Intent-named layouts shipped post-029. Exported so the migration that
// seeds them into existing installs (scripts/migrations/030-…) imports
// from this file rather than mirroring the grid by hand — fresh-install
// and migrated-install layouts can't drift on a future tweak.
export const INTENT_LAYOUTS = [
  {
    id: 'deep-work',
    name: 'Deep Work',
    widgets: ['quick-task', 'upcoming-tasks', 'cos', 'decision-log'],
    grid: [
      { id: 'quick-task',     x: 0, y: 0,  w: 6, h: 5 },
      { id: 'upcoming-tasks', x: 6, y: 0,  w: 6, h: 10 },
      { id: 'cos',            x: 0, y: 5,  w: 6, h: 3 },
      { id: 'decision-log',   x: 0, y: 8,  w: 6, h: 3 },
    ],
  },
  {
    id: 'health',
    name: 'Health',
    widgets: ['death-clock', 'goal-progress', 'activity-streak', 'daily-post', 'quick-brain', 'hourly-activity', 'meatspace-streak'],
    grid: [
      { id: 'death-clock',      x: 0, y: 0, w: 4, h: 3 },
      { id: 'goal-progress',    x: 4, y: 0, w: 5, h: 5 },
      { id: 'activity-streak',  x: 9, y: 0, w: 3, h: 3 },
      { id: 'daily-post',       x: 9, y: 3, w: 3, h: 2 },
      { id: 'quick-brain',      x: 0, y: 3, w: 4, h: 2 },
      { id: 'hourly-activity',  x: 0, y: 5, w: 12, h: 4 },
      // Gated on any health log existing — hidden on installs with no logs.
      { id: 'meatspace-streak', x: 0, y: 9, w: 4, h: 4 },
    ],
  },
  {
    id: 'agent-watch',
    name: 'Agent Watch',
    widgets: ['cos', 'proactive-alerts', 'review-hub', 'while-away', 'system-health', 'decision-log'],
    grid: [
      { id: 'cos',              x: 0, y: 0, w: 6, h: 5 },
      { id: 'proactive-alerts', x: 6, y: 0, w: 3, h: 3 },
      { id: 'review-hub',       x: 9, y: 0, w: 3, h: 3 },
      { id: 'while-away',       x: 6, y: 3, w: 6, h: 5 },
      { id: 'system-health',    x: 0, y: 5, w: 6, h: 5 },
      { id: 'decision-log',     x: 6, y: 8, w: 6, h: 3 },
    ],
  },
];

const DEFAULT_LAYOUTS = [
  {
    id: 'default',
    name: 'Everything',
    builtIn: true,
    widgets: [
      'quick-brain', 'quick-idea', 'quick-image', 'quick-task',
      'apps',
      'cos', 'goal-progress', 'upcoming-tasks',
      'proactive-alerts', 'review-hub', 'while-away', 'system-health', 'network-exposure', 'backup', 'death-clock', 'quick-stats', 'decision-log',
      'activity-streak', 'hourly-activity', 'tribe-care', 'feeds',
    ],
    // Above-the-fold capture row stretches to h=5 so the Quick Task card
    // can show its expanded options (worktree/PR/simplify/etc.) without
    // forcing a "More options" click. Quick-brain stays small and
    // upcoming-tasks aligns with the taller capture cards.
    grid: [
      // Row 0–4: capture row + tasks
      { id: 'quick-brain',      x: 0,  y: 0,  w: 3, h: 2 },
      { id: 'quick-image',      x: 0,  y: 2,  w: 3, h: 3 },
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
      { id: 'network-exposure', x: 9,  y: 10, w: 3, h: 5 },
      // Row 14–17: lower-priority + cos. while-away fills the x9–11 column
      // in rows 15–17 — below network-exposure (ends at row 14) and above
      // hourly-activity (starts at row 18), so it overlaps neither.
      { id: 'decision-log',     x: 0,  y: 14, w: 4, h: 2 },
      { id: 'cos',              x: 4,  y: 14, w: 5, h: 4 },
      { id: 'while-away',       x: 9,  y: 15, w: 3, h: 3 },
      // Row 18+: full-width visualizations + apps
      { id: 'hourly-activity',  x: 0,  y: 18, w: 12, h: 3 },
      { id: 'apps',             x: 0,  y: 21, w: 12, h: 8 },
      // Quick-idea (catalog) is positioned below apps so the seeded layout
      // doesn't collide with the tightly-packed above-the-fold rows.
      // Reorderable via the Arrange button on the dashboard.
      { id: 'quick-idea',       x: 0,  y: 29, w: 4,  h: 4 },
      // Gated on the Tribe having people — hidden on installs that don't use it.
      { id: 'tribe-care',       x: 4,  y: 29, w: 4,  h: 4 },
      // Gated on having subscribed feeds — hidden on installs with none.
      { id: 'feeds',            x: 8,  y: 29, w: 3,  h: 4 },
    ],
  },
  {
    id: 'focus',
    name: 'Focus',
    builtIn: true,
    widgets: ['quick-task', 'upcoming-tasks', 'cos'],
    // All three widgets above the fold. Quick-task is sized to show its
    // expanded options (matches the Everything layout's h=5 capture row);
    // upcoming-tasks tall on the right (the focus list); cos below
    // quick-task for streak/progress context.
    grid: [
      { id: 'quick-task',     x: 0, y: 0, w: 6, h: 5 },
      { id: 'upcoming-tasks', x: 6, y: 0, w: 6, h: 10 },
      { id: 'cos',            x: 0, y: 5, w: 6, h: 5 },
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
    widgets: ['system-health', 'network-exposure', 'cos', 'backup', 'apps', 'quick-stats'],
    // System monitoring focus — system-health takes the tall left column
    // (the primary alarm surface), cos in the center for ChiefOfStaff
    // status, backup + quick-stats stacked on the right, apps grid fills
    // the empty cell below cos so all 5 widgets fit above the fold.
    grid: [
      { id: 'system-health',    x: 0, y: 0,  w: 6,  h: 5 },
      { id: 'quick-stats',      x: 6, y: 0,  w: 6,  h: 3 },
      { id: 'cos',              x: 6, y: 3,  w: 6,  h: 4 },
      { id: 'backup',           x: 0, y: 5,  w: 3,  h: 3 },
      { id: 'network-exposure', x: 3, y: 5,  w: 3,  h: 5 },
      { id: 'apps',             x: 0, y: 10, w: 12, h: 11 },
    ],
  },
  ...INTENT_LAYOUTS.map((l) => ({ ...l, builtIn: true })),
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

// Time-window auto-activation: HH:MM strings (24h). When a layout carries an
// activateWindow and the local clock falls inside it, the dashboard
// auto-selects that layout on a fresh visit (unless the user picked a
// different one today). Stored as a literal "HH:MM" pair so a hand-edited
// JSON is human-readable. Sourced from the strict (zero-padded) shared regex
// in server/lib/timezone.js; mirrored client-side in client/src/utils/timeWindow.js.
export const TIME_STRING_RE = HHMM_STRICT_RE;

// Sanitize a layout's activateWindow. Returns null for any malformed shape
// (missing fields, non-string types, off-format strings). A null result
// strips the field on read so a hand-edited JSON with garbage can't
// accidentally drive an auto-switch. start === end collapses to null —
// a zero-length window can never match.
const sanitizeActivateWindow = (w) => {
  if (!w || typeof w !== 'object') return null;
  if (typeof w.start !== 'string' || typeof w.end !== 'string') return null;
  if (!TIME_STRING_RE.test(w.start) || !TIME_STRING_RE.test(w.end)) return null;
  if (w.start === w.end) return null;
  return { start: w.start, end: w.end };
};

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
  const activateWindow = sanitizeActivateWindow(l.activateWindow);
  return { id: l.id, name, builtIn: BUILTIN_IDS.has(l.id), widgets, grid, activateWindow };
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

// All mutations to dashboard-layouts.json funnel through this tail so two
// concurrent writers (e.g. an auto-window-activate PUT + a manual layout
// save firing from the same browser, or palette + dashboard tabs) can't
// interleave load → modify → write and lose each other's changes. Mirrors
// the `issueWriteTail` / `cacheWriteTails` pattern documented in CLAUDE.md
// ("Async PATCH races on shared records — serialize writes server-side").
let layoutsWriteTail = Promise.resolve();
const queueLayoutsWrite = (fn) => {
  const tail = layoutsWriteTail.then(fn, fn); // run even after a prior failure
  layoutsWriteTail = tail.then(() => null, () => null); // tail keeps chaining
  return tail;
};

export function setActiveLayout(id) {
  return queueLayoutsWrite(async () => {
    const state = await getState();
    if (!state.layouts.find((l) => l.id === id)) {
      throw makeErr(`Unknown layout id: ${id}`, ERR_NOT_FOUND);
    }
    const next = { activeLayoutId: id, layouts: state.layouts };
    await atomicWrite(STATE_PATH, next);
    return { ...next, limits: LIMITS };
  });
}

export function saveLayout(layout) {
  return queueLayoutsWrite(async () => {
    const state = await getState();
    const idx = state.layouts.findIndex((l) => l.id === layout.id);
    // Derive `builtIn` from BUILTIN_IDS at write-time (not from the persisted
    // flag) so a hand-edited JSON that deleted the default `ops` entry can't
    // produce a new `ops` that sanitizeLayout() later treats as built-in while
    // the write-path echoed `builtIn: false` to the client.
    const builtIn = BUILTIN_IDS.has(layout.id);
    // Partial-aware merge: `activateWindow` is preserved when the caller
    // doesn't include the key, but cleared when the caller sends `null`. The
    // existing editor's saveLayout() doesn't send activateWindow, so a vanilla
    // widget edit must NOT wipe a previously-configured morning window.
    // Mirrors the "absent vs intentionally empty" convention in CLAUDE.md.
    const existing = idx >= 0 ? state.layouts[idx] : null;
    const buildEntry = () => {
      const entry = {
        id: layout.id,
        name: layout.name,
        builtIn,
        widgets: layout.widgets,
        grid: layout.grid ?? [],
      };
      // `undefined` (key absent OR set undefined) means "preserve"; `null` is
      // the explicit clear. Spread alone would clobber existing.activateWindow
      // with undefined when the caller omits the key.
      entry.activateWindow = layout.activateWindow !== undefined
        ? layout.activateWindow
        : (existing?.activateWindow ?? null);
      return entry;
    };
    const merged = idx >= 0
      ? state.layouts.map((l, i) => i === idx ? buildEntry() : l)
      : [...state.layouts, buildEntry()];
    const next = { activeLayoutId: state.activeLayoutId, layouts: merged };
    await atomicWrite(STATE_PATH, next);
    return { ...next, limits: LIMITS };
  });
}

export function deleteLayout(id) {
  return queueLayoutsWrite(async () => {
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
  });
}
