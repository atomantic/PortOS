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
// instead of falling back to the client's row-flow synthesis. `x`/`w` are
// real: they place the widget in the 12 columns. `order` decides reading
// order — and therefore the order the client packs in — while `h` is only the
// first-paint height, because the renderer measures each widget and floats it
// up (see client/src/components/dashboard/DashboardGrid.jsx). There is no row
// coordinate: so order these grids by what should be seen first, and do NOT
// budget above-the-fold space by counting 80px rows, the arithmetic won't hold.

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
      { id: 'quick-task',     x: 0, w: 6, order: 0, h: 5 },
      { id: 'upcoming-tasks', x: 6, w: 6, order: 1, h: 10 },
      { id: 'cos',            x: 0, w: 6, order: 2, h: 3 },
      { id: 'decision-log',   x: 0, w: 6, order: 3, h: 3 },
    ],
  },
  {
    id: 'health',
    name: 'Health',
    widgets: ['death-clock', 'goal-progress', 'daily-post', 'quick-brain', 'hourly-activity', 'meatspace-streak'],
    grid: [
      { id: 'death-clock',      x: 0, w: 4,  order: 0, h: 3 },
      { id: 'goal-progress',    x: 4, w: 5,  order: 1, h: 5 },
      { id: 'quick-brain',      x: 0, w: 4,  order: 2, h: 2 },
      { id: 'daily-post',       x: 9, w: 3,  order: 3, h: 2 },
      { id: 'hourly-activity',  x: 0, w: 12, order: 4, h: 4 },
      // Gated on any health log existing — hidden on installs with no logs.
      { id: 'meatspace-streak', x: 0, w: 4,  order: 5, h: 4 },
    ],
  },
  {
    id: 'agent-watch',
    name: 'Agent Watch',
    widgets: ['cos', 'proactive-alerts', 'review-hub', 'while-away', 'system-health', 'decision-log'],
    grid: [
      { id: 'cos',              x: 0, w: 6, order: 0, h: 5 },
      { id: 'proactive-alerts', x: 6, w: 3, order: 1, h: 3 },
      { id: 'review-hub',       x: 9, w: 3, order: 2, h: 3 },
      { id: 'while-away',       x: 6, w: 6, order: 3, h: 5 },
      { id: 'system-health',    x: 0, w: 6, order: 4, h: 5 },
      { id: 'decision-log',     x: 6, w: 6, order: 5, h: 3 },
    ],
  },
];

// Product engagement is a landing action surface, so seed it at the front of
// the two user-facing day-start layouts. Existing installs receive the same
// change through migration 297; custom layouts remain user-owned.
const seedDailyActions = (layout) => {
  if (!['default', 'morning-review'].includes(layout.id)) return layout;
  const existingGrid = Array.isArray(layout.grid) ? layout.grid : [];
  if (layout.widgets.includes('daily-actions') && existingGrid.some((item) => item.id === 'daily-actions')) return layout;
  const grid = existingGrid.filter((item) => item.id !== 'daily-actions').map((item) => ({
    ...item,
    order: Number.isFinite(item.order) ? item.order + 1 : 1,
  }));
  return {
    ...layout,
    widgets: layout.widgets.includes('daily-actions') ? layout.widgets : ['daily-actions', ...layout.widgets],
    grid: [
      { id: 'daily-actions', x: 0, w: 12, order: 0, h: 4 },
      ...grid,
    ],
  };
};

const DEFAULT_LAYOUTS = [
  {
    id: 'default',
    name: 'Everything',
    builtIn: true,
    widgets: [
      'quick-brain', 'quick-idea', 'quick-image', 'quick-task',
      'apps',
      'cos', 'goal-progress', 'upcoming-tasks',
      'proactive-alerts', 'review-hub', 'while-away', 'system-health', 'active-processing', 'network-exposure', 'backup', 'death-clock', 'quick-stats', 'decision-log',
      'hourly-activity', 'tribe-care', 'feeds',
    ],
    // Above-the-fold capture row stretches to h=5 so the Quick Task card
    // can show its expanded options (worktree/PR/simplify/etc.) without
    // forcing a "More options" click. Quick-brain stays small and
    // upcoming-tasks aligns with the taller capture cards.
    grid: [
      // Capture band + tasks
      { id: 'quick-brain',      x: 0, w: 3,  order: 0,  h: 2 },
      { id: 'quick-task',       x: 3, w: 5,  order: 1,  h: 5 },
      { id: 'upcoming-tasks',   x: 8, w: 4,  order: 2,  h: 5 },
      { id: 'quick-image',      x: 0, w: 3,  order: 3,  h: 3 },
      // Primary monitoring + alerts
      { id: 'system-health',    x: 0, w: 5,  order: 4,  h: 5 },
      { id: 'active-processing',x: 5, w: 3,  order: 5,  h: 5 },
      { id: 'proactive-alerts', x: 8, w: 3,  order: 6,  h: 3 },
      { id: 'death-clock',      x: 8, w: 4,  order: 7,  h: 2 },
      { id: 'review-hub',       x: 5, w: 3,  order: 8,  h: 2 },
      // Secondary widgets
      { id: 'backup',           x: 0, w: 3,  order: 9,  h: 4 },
      { id: 'quick-stats',      x: 3, w: 3,  order: 10, h: 3 },
      { id: 'goal-progress',    x: 6, w: 3,  order: 11, h: 4 },
      { id: 'network-exposure', x: 9, w: 3,  order: 12, h: 5 },
      // Lower-priority + cos
      { id: 'decision-log',     x: 0, w: 4,  order: 13, h: 2 },
      { id: 'cos',              x: 4, w: 5,  order: 14, h: 4 },
      { id: 'while-away',       x: 9, w: 3,  order: 15, h: 3 },
      // Full-width visualizations + apps
      { id: 'hourly-activity',  x: 0, w: 12, order: 16, h: 3 },
      { id: 'apps',             x: 0, w: 12, order: 17, h: 8 },
      // Quick-idea (catalog) is sequenced below apps so the seeded layout
      // doesn't crowd the tightly-packed above-the-fold band.
      // Reorderable via the Arrange button on the dashboard.
      { id: 'quick-idea',       x: 0, w: 4,  order: 18, h: 4 },
      // Gated on the Tribe having people — hidden on installs that don't use it.
      { id: 'tribe-care',       x: 4, w: 4,  order: 19, h: 4 },
      // Gated on having subscribed feeds — hidden on installs with none.
      { id: 'feeds',            x: 8, w: 3,  order: 20, h: 4 },
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
    // quick-task for status/progress context.
    grid: [
      { id: 'quick-task',     x: 0, w: 6, order: 0, h: 5 },
      { id: 'upcoming-tasks', x: 6, w: 6, order: 1, h: 10 },
      { id: 'cos',            x: 0, w: 6, order: 2, h: 5 },
    ],
  },
  {
    id: 'morning-review',
    name: 'Morning Review',
    builtIn: true,
    widgets: ['proactive-alerts', 'upcoming-tasks', 'review-hub', 'goal-progress', 'death-clock', 'daily-driver'],
    // Scan-and-act morning ritual — the classic scan quadrants above the fold.
    // Tasks list takes the tall center column (the actionable hot zone); alerts
    // top-left grab attention first; death-clock top-right for mortality framing;
    // review + goals fill the remaining quadrants. The Daily Driver (#2666) — the
    // first-visit-of-day sequence (POST → goal next-actions) — sits full-width in
    // a fresh row BELOW the scan quadrants: it self-hides once handled, and a
    // gated-off widget drops out of the sequence without disturbing what came
    // before it, so sequencing it last (like the gated tribe-care/feeds
    // widgets) means its absence leaves only harmless trailing space.
    grid: [
      { id: 'proactive-alerts', x: 0, w: 4,  order: 0, h: 4 },
      { id: 'upcoming-tasks',   x: 4, w: 5,  order: 1, h: 8 },
      { id: 'death-clock',      x: 9, w: 3,  order: 2, h: 2 },
      { id: 'goal-progress',    x: 9, w: 3,  order: 3, h: 4 },
      { id: 'review-hub',       x: 0, w: 4,  order: 4, h: 4 },
      { id: 'daily-driver',     x: 0, w: 12, order: 5, h: 6 },
    ],
  },
  {
    id: 'ops',
    name: 'Ops',
    builtIn: true,
    widgets: ['system-health', 'active-processing', 'network-exposure', 'cos', 'backup', 'apps', 'quick-stats'],
    // System monitoring focus — system-health takes the tall left column
    // (the primary alarm surface), cos in the center for ChiefOfStaff
    // status, active-processing + quick-stats stacked on the right, apps grid
    // fills the empty cell below cos so the monitoring widgets stay above fold.
    grid: [
      { id: 'system-health',    x: 0, w: 6,  order: 0, h: 5 },
      { id: 'active-processing',x: 6, w: 6,  order: 1, h: 5 },
      { id: 'quick-stats',      x: 6, w: 6,  order: 2, h: 3 },
      { id: 'cos',              x: 6, w: 6,  order: 3, h: 4 },
      { id: 'backup',           x: 0, w: 3,  order: 4, h: 3 },
      { id: 'network-exposure', x: 3, w: 3,  order: 5, h: 5 },
      { id: 'apps',             x: 0, w: 12, order: 6, h: 11 },
    ],
  },
  ...INTENT_LAYOUTS.map((l) => ({ ...l, builtIn: true })),
].map(seedDailyActions);

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

// Grid placement bounds. The dashboard is a 12-column responsive grid whose
// vertical placement is packed from measured content heights, so `x`/`w` are
// the only real coordinates. `order` is the reading/packing sequence, bounded
// by the widget count because a layout can never hold more entries than that.
// `h` stays bounded because a pinned cell renders at exactly that many rows.
export const GRID_COLS = 12;
export const GRID_ORDER_MAX = WIDGETS_MAX - 1;
export const GRID_ITEM_H_MAX = 50;
// Legacy `y` (pre-#4133 layouts and stale client bundles) is still accepted on
// read and converted to `order`; this bounds how far a hand-edited value can
// reach before it is discarded and resequenced.
export const GRID_LEGACY_Y_MAX = 200;

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

const intOr = (v, fallback) => (Number.isFinite(v) ? Math.floor(v) : fallback);

// Clamp a single grid item to valid bounds. Returns null when the entry is
// unusable (missing id, non-numeric coords, etc.). Numeric fields are
// floored before clamping so JSON containing decimals can't smuggle in
// off-grid positions that break the snap math in the client renderer.
//
// The sequence field (`order`) is NOT resolved here — it's a property of the
// grid as a whole, so `sequenceGrid` below assigns it once every entry has
// been vetted and deduped.
//
// `fixedH` marks a cell whose height the user pinned by dragging it. Absent
// (the default) means the client sizes the cell to its content and floats it
// up, using `h` only as the first-paint fallback — which is also what a
// client too old to know about `fixedH` renders. Normalized to a plain boolean
// here for the intermediate entry; `sequenceGrid` is what drops it when false,
// so a hand-read layouts file stays terse.
const sanitizeGridItem = (g, validIds) => {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.id !== 'string') return null;
  const id = g.id.trim();
  if (!id || !validIds.has(id)) return null;
  const x = Math.max(0, Math.min(GRID_COLS - 1, intOr(g.x, 0)));
  const wRaw = Math.max(1, Math.min(GRID_COLS, intOr(g.w, 1)));
  const w = Math.min(wRaw, GRID_COLS - x);
  const h = Math.max(1, Math.min(GRID_ITEM_H_MAX, intOr(g.h, 1)));
  return { id, x, w, h, fixedH: g.fixedH === true };
};

// Resolve the layout's reading sequence and emit dense `order` values.
//
// Version-gated by SHAPE rather than by a stored version number, so a layout
// that predates the conversion — an install that hasn't run migration 269, a
// restored backup, a save posted by a stale client bundle — still yields
// usable geometry instead of collapsing into one arbitrary order:
//   - New shape: entries carry `order`; that's the sequence.
//   - Legacy shape: entries carry a row position `y`, and the sequence is the
//     reading order it implied — top-to-bottom, then left-to-right.
//   - Mixed (a widget-seeding migration appending a legacy entry to an
//     already-converted file) treats the layout as new-shape and puts the
//     order-less entries last in file order, which is where those migrations
//     mean to append.
// Output is always renumbered 0..n-1, so gaps and duplicates in the input
// can't survive a read. This is also the one place the emitted item shape is
// built, so `fixedH: false` is dropped rather than persisted.
const sequenceGrid = (entries) => {
  const anyOrder = entries.some((e) => e.order !== null);
  const ranked = entries.map((e, idx) => ({
    ...e,
    idx,
    rank: anyOrder ? (e.order ?? Number.MAX_SAFE_INTEGER) : (e.y ?? 0),
    // Ties in legacy layouts are side-by-side cells: column decides. Ties in
    // the new shape are corrupt data: file order decides.
    tie: anyOrder ? idx : e.item.x,
  }));
  ranked.sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.idx - b.idx);
  return ranked.map(({ item }, order) => ({
    id: item.id,
    x: item.x,
    w: item.w,
    order,
    h: item.h,
    ...(item.fixedH ? { fixedH: true } : {}),
  }));
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
  const entries = [];
  const seenGrid = new Set();
  if (Array.isArray(l.grid)) {
    for (const g of l.grid) {
      const item = sanitizeGridItem(g, validIds);
      if (!item) continue;
      if (seenGrid.has(item.id)) continue;
      seenGrid.add(item.id);
      entries.push({
        item,
        // `null` = "this entry declares no sequence", distinct from a
        // legitimate 0 — the shape probe in sequenceGrid depends on telling
        // those apart.
        order: Number.isFinite(g.order) ? Math.max(0, Math.min(GRID_ORDER_MAX, Math.floor(g.order))) : null,
        y: Number.isFinite(g.y) ? Math.max(0, Math.min(GRID_LEGACY_Y_MAX, Math.floor(g.y))) : null,
      });
    }
  }
  const grid = sequenceGrid(entries);
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
  gridOrderMax: GRID_ORDER_MAX,
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
// the `issueWriteTail` / `cacheWriteTails` pattern documented in AGENTS.md
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
    // Mirrors the "absent vs intentionally empty" convention in AGENTS.md.
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
