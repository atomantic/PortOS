import { Users, MapPin, Package } from 'lucide-react';
import { WORLD_CATEGORIES, WORLD_CATEGORY_KEY_MAX } from '../services/api';

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

// Tab order in the Universe Builder. Bible / Composites / Render are always
// visible; the three canon trunks (Cast / Places / Objects) render even when
// empty so the user has a discoverable target for canon+variation work; Other
// only renders when at least one un-kinded bucket exists.
export const TAB_BIBLE = 'bible';
export const TAB_CAST = 'cast';
export const TAB_PLACES = 'places';
export const TAB_OBJECTS = 'objects';
export const TAB_OTHER = 'other';
export const TAB_COMPOSITES = 'composites';
export const TAB_RENDER = 'render';

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

export const humanizeCategory = (key) => CATEGORY_LABELS[key]
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
