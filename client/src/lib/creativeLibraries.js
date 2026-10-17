// Casting, Environments and Objects: focused library pages over the catalog's
// character, place and object ingredients. The catalog row stays the single
// record; these entries only say which page owns a type and how to name it.

export const CREATIVE_LIBRARIES = Object.freeze([
  Object.freeze({ id: 'casting', type: 'character', path: '/casting', label: 'Casting', singular: 'cast member', empty: 'No cast yet.' }),
  Object.freeze({ id: 'environments', type: 'place', path: '/environments', label: 'Environments', singular: 'environment', empty: 'No environments yet.' }),
  Object.freeze({ id: 'objects', type: 'object', path: '/objects', label: 'Objects', singular: 'object', empty: 'No objects yet.' }),
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
