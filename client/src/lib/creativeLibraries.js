import { Sparkles, Drama, Mountain, Package } from 'lucide-react';
import { GREYBOX_SHOT_ROLE_PREFIX } from '../../../server/lib/greyboxVocabulary.js';
import { isDesignRole } from '../../../server/lib/catalogDesign.js';

// Casting, Environments and Objects: focused library pages over the catalog's
// character, place and object ingredients. The catalog row stays the single
// record; these entries only say which page owns a type and how to name it.

export const CATALOG_NAV_TABS = Object.freeze([
  Object.freeze({ id: 'catalog', label: 'Catalog', to: '/catalog', icon: Sparkles }),
  Object.freeze({ id: 'casting', label: 'Casting', to: '/casting', icon: Drama }),
  Object.freeze({ id: 'environments', label: 'Environments', to: '/environments', icon: Mountain }),
  Object.freeze({ id: 'objects', label: 'Objects', to: '/objects', icon: Package }),
]);

// `detailTabs` are the record page's sections (`/casting/:id/:tab`); the
// first is the default and an unknown tab falls back to it.
const tab = (id, label) => Object.freeze({ id, label });
const PROFILE = tab('profile', 'Profile');
const SHEETS = tab('sheets', 'Sheets');

export const CREATIVE_LIBRARIES = Object.freeze([
  Object.freeze({
    id: 'casting', type: 'character', path: '/casting', label: 'Casting', singular: 'cast member', empty: 'No cast yet.',
    detailTabs: Object.freeze([PROFILE, tab('design', 'Design'), SHEETS, tab('looks', 'Looks'), tab('references', 'References')]),
  }),
  Object.freeze({
    id: 'environments', type: 'place', path: '/environments', label: 'Environments', singular: 'environment', empty: 'No environments yet.',
    detailTabs: Object.freeze([PROFILE, SHEETS, tab('plates', 'Plates'), tab('greybox', 'Greybox'), tab('references', 'References')]),
  }),
  Object.freeze({
    id: 'objects', type: 'object', path: '/objects', label: 'Objects', singular: 'object', empty: 'No objects yet.',
    detailTabs: Object.freeze([PROFILE, SHEETS, tab('images', 'Images')]),
  }),
]);

export const libraryById = (id) => CREATIVE_LIBRARIES.find((lib) => lib.id === id) || null;
export const libraryForType = (type) => CREATIVE_LIBRARIES.find((lib) => lib.type === type) || null;

// The library whose page a pathname sits under (`/casting/cat-chr-1` → Casting).
export const libraryForPathname = (pathname = '') =>
  CREATIVE_LIBRARIES.find((lib) => pathname === lib.path || pathname.startsWith(`${lib.path}/`)) || null;

// Detail route for an ingredient: its library page when it has one, otherwise
// the generic catalog editor.
export function ingredientPath(ingredient) {
  const id = encodeURIComponent(ingredient?.id || '');
  const lib = libraryForType(ingredient?.type);
  return lib ? `${lib.path}/${id}` : `/catalog/${encodeURIComponent(ingredient?.type || 'idea')}/${id}`;
}

// The detail tab a `:tab` route param names, falling back to the first
// (Profile) for an absent or unknown one.
export function resolveDetailTab(library, tabParam) {
  const tabs = library?.detailTabs || [];
  return (tabs.find((t) => t.id === tabParam) || tabs[0] || null)?.id ?? null;
}

// Route for one tab of a library record; the default tab is the bare record path.
export function detailTabPath(library, id, tabId) {
  const base = `${library.path}/${encodeURIComponent(id || '')}`;
  return tabId && tabId !== library.detailTabs?.[0]?.id ? `${base}/${encodeURIComponent(tabId)}` : base;
}

// Catalog media roles that belong to their own tab rather than References:
// rendered sheets (`sheet:<variant>`), wardrobe looks (`look:<id>`) and set
// plates (`plate`), Design takes (`design:<roundId>`). Greybox shot captures (`greybox-shot:<id>`) live on the
// Greybox tab beside the camera that made them.
export const SHEET_ROLE_PREFIX = 'sheet:';
export const LOOK_ROLE_PREFIX = 'look:';
export const PLATE_ROLE = 'plate';
const roleOf = (m) => (typeof m?.role === 'string' ? m.role : '');
export const isSheetMedia = (m) => roleOf(m).startsWith(SHEET_ROLE_PREFIX);
export const isPlateMedia = (m) => roleOf(m) === PLATE_ROLE;
// Casting > Design takes (`design:<roundId>:<n>`) live on the Design tab;
// an anchored one (a render guide) also shows on References.
export const isDesignMedia = (m) => isDesignRole(roleOf(m));
export const isGreyboxShotMedia = (m) => roleOf(m).startsWith(GREYBOX_SHOT_ROLE_PREFIX);
const greyboxShotIdOf = (m) => roleOf(m).slice(GREYBOX_SHOT_ROLE_PREFIX.length);
// The wardrobe id a `look:<id>` media row belongs to, or null.
export const lookIdOf = (m) => (roleOf(m).startsWith(LOOK_ROLE_PREFIX) ? roleOf(m).slice(LOOK_ROLE_PREFIX.length) : null);
// `liveLookIds` (a Set of the record's wardrobe ids) keeps a deleted look's
// images visible on References instead of stranding them under a dead role;
// `liveShotIds` (the greybox's shot ids) does the same for a capture whose shot
// was removed.
export const isReferenceTabMedia = (m, liveLookIds = null, liveShotIds = null) => {
  if (isSheetMedia(m) || isPlateMedia(m) || (isDesignMedia(m) && m.library?.guide !== true)) return false;
  if (isGreyboxShotMedia(m)) return !liveShotIds?.has(greyboxShotIdOf(m));
  const lookId = lookIdOf(m);
  return lookId === null || (liveLookIds ? !liveLookIds.has(lookId) : false);
};

export const isGoodReference = (m) => (m?.library?.review?.status === 'good' || m?.review?.status === 'good');

// Cover image for a card. Attached catalog media wins; canon-mirrored rows fall
// back to the universe's starred or first render. Both are gallery files under
// /data/images (only canon reference sheets live under /data/image-refs).
export function ingredientCoverUrl(ingredient) {
  const payload = ingredient?.payload && typeof ingredient.payload === 'object' ? ingredient.payload : {};
  const key = ingredient?.thumbnailKey
    || (typeof payload.primaryImageRef === 'string' && payload.primaryImageRef)
    || (Array.isArray(payload.imageRefs) ? payload.imageRefs.find((r) => typeof r === 'string' && r) : null);
  return key ? `/data/images/${key}` : null;
}

const USAGE_LABELS = [
  ['universe', 'universe', 'universes'],
  ['music-video', 'video', 'videos'],
  ['storyboard', 'storyboard', 'storyboards'],
  ['creative-director', 'production', 'productions'],
  ['series', 'series', 'series'],
  ['issue', 'issue', 'issues'],
  ['work', 'work', 'works'],
];

// "1 universe · 2 videos" from the list endpoint's per-kind link counts.
export function usageSummary(usage) {
  if (!usage || typeof usage !== 'object') return '';
  return USAGE_LABELS
    .map(([kind, one, many]) => {
      const n = Number(usage[kind]) || 0;
      return n > 0 ? `${n} ${n === 1 ? one : many}` : null;
    })
    .filter(Boolean)
    .join(' · ');
}
