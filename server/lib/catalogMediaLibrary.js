/**
 * Cast reference library (Casting > References).
 *
 * Each catalog media row carries an optional `library` JSONB describing how the
 * asset is used as a reference for the cast member: which variant it depicts
 * (age, era, wardrobe/look, free label), searchable tags, and whether it is a
 * render GUIDE — one of at most MAX_CAST_GUIDES images that conditioning picks
 * from. The primary image stays the existing single `portrait` row.
 *
 * Pure helpers only (no DB) so the picker is shared by routes, music video
 * conditioning and tests.
 */

export const MAX_CAST_GUIDES = 4;
export const CAST_ERAS = Object.freeze(['child', 'teen', 'adult', 'elder']);
export const MAX_LIBRARY_TAGS = 20;
// Ratings a reference can be given. "Rejected" (wrong for this context) is a
// music video take state; outside shots a wrong reference is removed from the
// record instead. A legacy or older-peer 'rejected' still reads (and stays
// out of render guides) and is shown as bad.
export const REFERENCE_REVIEW_WRITE_STATUSES = Object.freeze(['unreviewed', 'good', 'bad']);
export const REFERENCE_REVIEW_STATUSES = Object.freeze([...REFERENCE_REVIEW_WRITE_STATUSES, 'rejected']);
export const referenceReviewStatus = (m) => {
  const status = m?.library?.review?.status || 'unreviewed';
  return status === 'rejected' ? 'bad' : status;
};
export const REFERENCE_FEEDBACK_MAX = 2000;
export const isUsableReference = (m) => !['bad', 'rejected'].includes(m?.library?.review?.status);
export const isGoodReference = (m) => (m?.library?.review?.status === 'good' || m?.review?.status === 'good');
export const rejectedReferenceKeys = (media) => new Set((Array.isArray(media) ? media : [])
  .filter(m => m && !m.deleted && ['portrait', 'reference'].includes(m.kind) && !isUsableReference(m)).map(m => m.mediaKey));

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const cleanStr = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

// Era a bare age falls into when the asset was not tagged with one.
function eraForAge(age) {
  if (!Number.isFinite(age)) return undefined;
  if (age < 13) return 'child';
  if (age < 20) return 'teen';
  if (age < 65) return 'adult';
  return 'elder';
}

/** Normalize a stored/peer `library` value into its canonical shape. */
export function normalizeLibrary(value) {
  if (!isObj(value)) return {};
  const out = {};
  const variant = isObj(value.variant) ? value.variant : {};
  const v = {};
  if (Number.isInteger(variant.age) && variant.age >= 0 && variant.age <= 150) v.age = variant.age;
  if (CAST_ERAS.includes(variant.era)) v.era = variant.era;
  const wardrobeId = cleanStr(variant.wardrobeId, 59);
  if (wardrobeId) v.wardrobeId = wardrobeId;
  // The record's `payload.forms[]` entry this asset shows; absent = the
  // canonical present-story form.
  const formId = cleanStr(variant.formId, 24);
  if (formId) v.formId = formId;
  const label = cleanStr(variant.label, 120);
  if (label) v.label = label;
  if (Object.keys(v).length) out.variant = v;
  if (Array.isArray(value.tags)) {
    const tags = [...new Set(value.tags.map((t) => cleanStr(t, 40)?.toLowerCase()).filter(Boolean))].slice(0, MAX_LIBRARY_TAGS);
    if (tags.length) out.tags = tags;
  }
  if (typeof value.guide === 'boolean') out.guide = value.guide;
  if (isObj(value.review) && REFERENCE_REVIEW_STATUSES.includes(value.review.status)) {
    out.review = { status: value.review.status };
    if (typeof value.review.feedback === 'string') out.review.feedback = value.review.feedback.slice(0, REFERENCE_FEEDBACK_MAX);
    if (!isUsableReference({ library: out })) out.guide = false;
  }
  if (isObj(value.derivedFrom) && ['portrait', 'reference'].includes(value.derivedFrom.kind)) {
    const mediaKey = cleanStr(value.derivedFrom.mediaKey, 512);
    if (mediaKey) out.derivedFrom = { mediaKey, kind: value.derivedFrom.kind };
  }
  return out;
}

const mediaEra = (m) => m?.library?.variant?.era || eraForAge(m?.library?.variant?.age);

/** Filter live media rows by `{ age, era, wardrobeId, formId, tag, kind, guide }`. */
export function filterLibraryMedia(media, filters = {}) {
  const list = Array.isArray(media) ? media : [];
  return list.filter((m) => {
    if (!m || m.deleted) return false;
    const lib = m.library || {};
    if (filters.kind && m.kind !== filters.kind) return false;
    if (Number.isInteger(filters.age) && lib.variant?.age !== filters.age) return false;
    if (filters.era && mediaEra(m) !== filters.era) return false;
    if (filters.wardrobeId && lib.variant?.wardrobeId !== filters.wardrobeId) return false;
    if (filters.formId && lib.variant?.formId !== filters.formId) return false;
    if (filters.tag && !(lib.tags || []).includes(String(filters.tag).toLowerCase())) return false;
    if (filters.guide === true && lib.guide !== true) return false;
    if (filters.review && referenceReviewStatus(m) !== referenceReviewStatus({ library: { review: { status: filters.review } } })) return false;
    return true;
  });
}

const IMAGE_KINDS = new Set(['portrait', 'reference']);

function score(m, want) {
  const v = m.library?.variant || {};
  let s = 0;
  if (Number.isInteger(want.age) && Number.isInteger(v.age)) s += Math.max(0, 60 - 2 * Math.abs(v.age - want.age));
  const wantEra = want.era || eraForAge(want.age);
  if (wantEra && mediaEra(m) === wantEra) s += 30;
  if (want.wardrobeId && v.wardrobeId === want.wardrobeId) s += 20;
  if (want.formId && v.formId === want.formId) s += 40;
  if (m.library?.guide) s += 10;
  if (m.kind === 'portrait') s += 5;
  if (m.library?.review?.status === 'good') s += 100;
  return s;
}

/**
 * Pick up to `cap` image references to condition a render of this cast member.
 * Guides are preferred; when none are flagged the portrait then newest
 * references stand in. Within a pool, the closest variant (age → era →
 * wardrobe) wins, then the portrait, then newest. Videos never condition.
 */
export function pickGuideMedia(media, want = {}, cap = MAX_CAST_GUIDES) {
  const rejected = rejectedReferenceKeys(media);
  const images = (Array.isArray(media) ? media : []).filter((m) => m && !m.deleted && IMAGE_KINDS.has(m.kind)
    && !rejected.has(m.mediaKey) && matchesReferenceVariant(m, want));
  const guides = images.filter((m) => m.library?.guide === true);
  const pool = guides.length ? guides : images;
  const time = (m) => Date.parse(m.createdAt || 0) || 0;
  const seen = new Set();
  return [...pool]
    .sort((a, b) => score(b, want) - score(a, want) || time(b) - time(a))
    .filter((m) => !seen.has(m.mediaKey) && seen.add(m.mediaKey))
    .slice(0, Math.max(0, Math.min(cap, MAX_CAST_GUIDES)));
}

// Known incompatible looks never fill spare conditioning slots. Untagged
// legacy references remain usable until the operator assigns their variant.
export function matchesReferenceVariant(m, want = {}) {
  const v = m.library?.variant || {};
  if (want.formId && v.formId && want.formId !== v.formId) return false;
  if (Number.isInteger(want.age) && Number.isInteger(v.age) && want.age !== v.age) return false;
  const era = want.era || eraForAge(want.age);
  if (era && mediaEra(m) && era !== mediaEra(m)) return false;
  return !want.wardrobeId || !v.wardrobeId || want.wardrobeId === v.wardrobeId;
}

/** Strip a mood-board/media-history `image:`/`video:` key to library kind + filename. */
export function parseLibraryMediaKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^(image|video):(.+)$/.exec(key.trim());
  if (!m || !m[2] || m[2].includes('..') || m[2].startsWith('/')) return null;
  return { kind: m[1] === 'video' ? 'video' : 'reference', mediaKey: m[2] };
}

/** Best-effort age read from a caption like "Nora at 17" / "age 7" / "(27)". */
export function inferAgeFromText(text) {
  if (typeof text !== 'string') return undefined;
  const m = /\b(?:age[sd]?\s*|at\s+)(\d{1,3})\b/i.exec(text);
  const age = m ? Number(m[1]) : NaN;
  return Number.isInteger(age) && age <= 150 ? age : undefined;
}
