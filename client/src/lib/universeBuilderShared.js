import { Users, MapPin, Package } from 'lucide-react';
// Imports direct from apiUniverseBuilder (NOT the global `services/api`
// barrel) — see universeBuilderExpand.js for why: tracing through the
// barrel pulls all ~40 service modules into this lib's dep graph.
import { WORLD_CATEGORIES, WORLD_CATEGORY_KEY_MAX } from '../services/apiUniverseBuilder';

// Shared constants + pure category/trunk/composite helpers for the Universe
// Builder page and its extracted tab/editor components (#2374). Kept free of
// React state so the helpers are unit-testable and importable from either the
// page or the component modules without a cycle.

export const CATEGORY_LABELS = {
  landscapes: 'Landscapes',
  environments: 'Environments',
  structures: 'Structures',
  vehicles: 'Vehicles',
};

// Tab order in the Universe Builder. Bible / Composites / Render / Graph are
// always visible; the three canon trunks (Cast / Places / Objects) render even when
// empty so the user has a discoverable target for canon+variation work; Other
// only renders when at least one un-kinded bucket exists.
export const TAB_BIBLE = 'bible';
export const TAB_CAST = 'cast';
export const TAB_PLACES = 'places';
export const TAB_OBJECTS = 'objects';
export const TAB_OTHER = 'other';
export const TAB_COMPOSITES = 'composites';
export const TAB_RENDER = 'render';
export const TAB_GRAPH = 'graph';

// Pseudo-bucket key for the canon-only view inside a trunk. Overloads
// `?bucket=` (alongside real bucket keys) AND a `promptMode` value on the
// render route; same string in both contexts to keep the contract consistent.
export const BUCKET_CANON = 'canon';

// `kind` doubles as the canon-array key on the universe (`draft[kind]`) and
// the canon-trunk identifier the server's `canonSelection` schema accepts.
export const TRUNK_TABS = [
  { id: TAB_CAST, kind: 'characters', label: 'Cast', icon: Users },
  { id: TAB_PLACES, kind: 'places', label: 'Places', icon: MapPin },
  { id: TAB_OBJECTS, kind: 'objects', label: 'Objects', icon: Package },
];
export const TRUNK_BY_ID = Object.fromEntries(TRUNK_TABS.map((t) => [t.id, t]));
export const TRUNK_BY_KIND = Object.fromEntries(TRUNK_TABS.map((t) => [t.kind, t]));

// Group category buckets by their `kind` tag. Buckets with an unknown / missing
// kind fall into the `other` bin — that bin drives whether the Other tab shows.
export const groupBucketsByKind = (categories = {}) => {
  const out = { characters: [], places: [], objects: [], other: [] };
  for (const [key, bucket] of Object.entries(categories || {})) {
    const kind = bucket?.kind || 'other';
    if (out[kind]) out[kind].push(key);
    else out.other.push(key);
  }
  return out;
};

export const normalizeCategoryKey = (raw) => (raw || '')
  .trim()
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .replace(/_{2,}/g, '_')
  .slice(0, WORLD_CATEGORY_KEY_MAX);

// `hasOwn`-guarded because category keys are user-authored and reach here from
// unvalidated sidecar metadata: a bare `CATEGORY_LABELS[key]` resolves
// `'constructor'` / `'toString'` to an inherited function, which then flows into
// callers as a label and throws the moment one calls a string method on it.
export const humanizeCategory = (key) => (Object.hasOwn(CATEGORY_LABELS, key) ? CATEGORY_LABELS[key] : null)
  || (key || '').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

export const ensureDraftCategories = (categories = {}) => ({
  ...Object.fromEntries(WORLD_CATEGORIES.map((c) => [c, { variations: [] }])),
  ...(categories || {}),
});

export const getCategoryKeys = (categories = {}) => {
  const seen = new Set();
  const keys = [];
  for (const key of [...WORLD_CATEGORIES, ...Object.keys(categories || {})]) {
    const normalized = normalizeCategoryKey(key);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    keys.push(normalized);
  }
  return keys;
};

// Default per-render knobs. Mirrors the Image Gen page's default chip.
export const DEFAULT_RENDER_OPTS = {
  width: 1024,
  height: 1024,
  steps: 30,
  guidance: '',
  cfgScale: 7,
  quantize: '8',
  modelId: '',
  mode: '',
  promptMode: 'variations',
  batchPerVariation: 1,
  // Extended Image Gen surface used by the batch render form. Server accepts
  // these as optional patches on top of the universe's stored influences.
  seed: '',
  negativePrompt: '',
  extraStyle: '',
  stylePreset: null,
  loras: [],
};

// Mirror of COMPOSITE_SHEET_KINDS in server/services/universeBuilder.js — keep
// in sync when adding kinds.
export const COMPOSITE_BOARD_KINDS = [
  { value: 'reference_sheet', label: 'Reference sheet' },
  { value: 'world_pitch_poster', label: 'World pitch poster' },
];

export const compositeKindLabel = (kind) =>
  COMPOSITE_BOARD_KINDS.find((k) => k.value === kind)?.label || 'Reference sheet';

// The server sanitizer mints an `id` for every entry that arrives without one,
// but a save returns that record without the draft adopting it — so an entry
// created and used in the same session stays id-less on the client. That breaks
// any client state keyed by entry id: the render queue's per-row pending-job map
// is keyed by the id the SERVER stamped onto `entryJobs`, so a board (or
// variation) added and immediately rendered would never match its own job — no
// spinner, no thumbnail until reload, and a pending entry with no consumer to
// clear it.
//
// The same mismatch has a second shape, on records written before entry ids were
// persisted at all: `ensureEntryId` mints a FRESH uuid on every read for an
// id-less entry, so the draft's copy is transient and differs from the one the
// next reader sees. `POST /render` detects that and persists a real set before
// queueing — so those jobs are keyed by ids this draft has never seen, and the
// draft's own ids exist nowhere on the server. So an id is adopted when the local
// entry has none OR when the id it has is absent from the server record: an id
// the server doesn't know is by definition not the key anything is stored under.
// An id that IS present server-side is always kept, so a row is never re-keyed
// out from under an in-flight job.
//
// Matching is by `label`, the same key the render `selection` / `sheetSelection`
// payloads already use to name an entry across the wire. Each server id is
// claimed at most once, so duplicate labels fill in order instead of collapsing
// onto the first match. Returns the SAME array when nothing changed (the common
// case, since the sanitizer has already stamped ids on anything round-tripped)
// so callers can skip the write.
export const adoptServerEntryIds = (local, server) => {
  if (!Array.isArray(local) || !Array.isArray(server)) return local;
  const serverIds = new Set(server.map((entry) => entry?.id).filter(Boolean));
  const keepsOwnId = (entry) => !!entry?.id && serverIds.has(entry.id);
  // Ids already held by a local entry that keeps them are off the table.
  const claimed = new Set(local.filter(keepsOwnId).map((entry) => entry.id));
  const idsByLabel = new Map();
  for (const entry of server) {
    if (!entry?.id || typeof entry.label !== 'string' || claimed.has(entry.id)) continue;
    const queue = idsByLabel.get(entry.label);
    if (queue) queue.push(entry.id);
    else idsByLabel.set(entry.label, [entry.id]);
  }
  let changed = false;
  const next = local.map((entry) => {
    if (!entry || keepsOwnId(entry)) return entry;
    const id = idsByLabel.get(entry.label)?.shift();
    if (!id || id === entry.id) return entry;
    changed = true;
    return { ...entry, id };
  });
  return changed ? next : local;
};

// `adoptServerEntryIds` over every bucket's `variations`, for the keyed
// `categories` map. Same same-reference-when-unchanged contract.
export const adoptServerCategoryIds = (local, server) => {
  if (!local || typeof local !== 'object' || !server || typeof server !== 'object') return local;
  let changed = false;
  const next = {};
  for (const [key, bucket] of Object.entries(local)) {
    const variations = adoptServerEntryIds(bucket?.variations, server[key]?.variations);
    if (variations !== bucket?.variations) {
      changed = true;
      next[key] = { ...bucket, variations };
    } else {
      next[key] = bucket;
    }
  }
  return changed ? next : local;
};
