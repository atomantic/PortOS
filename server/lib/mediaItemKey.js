/**
 * Shared `<kind>:<ref>` key vocabulary for media items.
 *
 * Both mediaCollections.js and mediaAnnotations.js identify generated media
 * by `{ kind: 'image'|'video', ref: <filename|videoId> }` and serialize that
 * to the API surface as `"<kind>:<ref>"`. This module centralizes the rules
 * so the two services can't diverge on what counts as a valid kind, the
 * maximum ref length, or how `:` is rejected inside refs.
 */

export const ITEM_KINDS = ['image', 'video'];
export const ITEM_KIND = new Set(ITEM_KINDS);
export const REF_MAX_LENGTH = 256;

export const itemKey = (it) => `${it.kind}:${it.ref}`;

// Split `<kind>:<ref>` on the first `:` and validate both halves. Returns
// `{ kind, ref }` on success, `null` on any rejection. A ref containing `:`
// would be unambiguously persisted but ambiguously addressable via the REST
// surface (DELETE /:key, coverKey lookups), so we reject it here.
const parseKeyOf = (kinds) => (key) => {
  if (typeof key !== 'string') return null;
  const idx = key.indexOf(':');
  if (idx <= 0) return null;
  const kind = key.slice(0, idx);
  const ref = key.slice(idx + 1);
  if (!kinds.has(kind)) return null;
  if (!ref || ref.length > REF_MAX_LENGTH) return null;
  if (ref.includes(':')) return null;
  return { kind, ref };
};

export const parseKey = parseKeyOf(ITEM_KIND);
export const isValidKey = (key) => parseKey(key) !== null;

// Annotations (star/rating/note) also cover files under /data/image-refs —
// reference sheets and upload-only references with no gallery record — as
// `image-ref:<file>`. Collections and mood boards keep the narrower `isValidKey`.
export const ANNOTATION_KINDS = [...ITEM_KINDS, 'image-ref'];
const ANNOTATION_KIND = new Set(ANNOTATION_KINDS);

const parseAnnotationKey = parseKeyOf(ANNOTATION_KIND);
export const isValidAnnotationKey = (key) => parseAnnotationKey(key) !== null;
