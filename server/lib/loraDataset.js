/**
 * LoRA training dataset — pure helpers (no I/O, no service imports).
 *
 * A dataset is the curated set of captioned reference images for ONE
 * universe bible subject, stored machine-locally at
 * `data/lora-datasets/<id>/index.json` (+ `images/*.png`) via
 * collectionStore. These helpers cover the record sanitizer, trigger-word
 * derivation, caption prefixing, the generation variation matrix, and
 * training readiness. The dataset-image PROMPT builder lives in
 * `server/services/loraDatasetGenerate.js` (it needs canon/service
 * imports that don't belong in the lib barrel); all dataset I/O lives in
 * `server/services/loraDatasets.js`.
 */

export const LORA_DATASET_SCHEMA_VERSION = 1;

// Minimum ready+captioned images before a training run is allowed. Below
// ~10 images a character LoRA badly overfits the few poses it has seen.
export const MIN_TRAINING_IMAGES = 10;

// Quality target a character LoRA wants to hit for a reliable likeness across
// poses/framing. 10 is *trainable* but thin; ~20–30 varied shots is the sweet
// spot. Past ~50 you mostly add training time and overfitting risk (near-
// duplicate frames teach the net to memorize, not generalize), so the UI
// nudges toward the target rather than "more is always better".
export const RECOMMENDED_TRAINING_IMAGES = 20;
export const TRAINING_IMAGE_SWEET_SPOT_MAX = 30;

export const LORA_DATASET_ENTRY_KINDS = Object.freeze(['characters', 'objects', 'places']);
export const DATASET_IMAGE_SOURCES = Object.freeze(['generated', 'upload', 'refsheet-slice', 'gallery']);
export const DATASET_IMAGE_STATUSES = Object.freeze(['rendering', 'ready', 'failed']);
export const DATASET_STATUSES = Object.freeze(['draft', 'training', 'trained']);
export const CAPTION_SOURCES = Object.freeze(['vision', 'manual']);

const TRIGGER_WORD_RE = /^[a-z0-9_]{2,64}$/;
export const isValidTriggerWord = (word) => typeof word === 'string' && TRIGGER_WORD_RE.test(word);

const trim = (s) => (typeof s === 'string' ? s.trim() : '');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const isoOrNull = (v) => (typeof v === 'string' && v ? v : null);

// Default variation axes for the generation matrix. Views/poses are fixed
// vocabularies the service may override with canon-derived lists.
export const DEFAULT_VIEWS = Object.freeze([
  'front view', 'three-quarter view', 'side profile', 'back view',
]);
export const DEFAULT_POSES = Object.freeze([
  'standing relaxed', 'walking', 'sitting', 'action pose', 'arms crossed',
]);

/**
 * Sanitize one dataset image entry. Returns null for entries with no id or
 * file (unrecoverable). Captions clamp to 2000 chars to match the route's
 * Zod bound so a hand-edited record can't smuggle an oversized caption past
 * validation.
 */
export function sanitizeDatasetImage(raw) {
  if (!isPlainObject(raw)) return null;
  const id = trim(raw.id);
  const file = trim(raw.file);
  if (!id || !file) return null;
  const variation = isPlainObject(raw.variation)
    ? {
      view: trim(raw.variation.view) || null,
      pose: trim(raw.variation.pose) || null,
      expression: trim(raw.variation.expression) || null,
      outfit: trim(raw.variation.outfit) || null,
    }
    : null;
  return {
    id,
    file,
    caption: trim(raw.caption).slice(0, 2000),
    captionSource: oneOf(raw.captionSource, CAPTION_SOURCES, null),
    captionedAt: isoOrNull(raw.captionedAt),
    source: oneOf(raw.source, DATASET_IMAGE_SOURCES, 'upload'),
    sourceJobId: trim(raw.sourceJobId) || null,
    variation,
    status: oneOf(raw.status, DATASET_IMAGE_STATUSES, 'ready'),
    width: Number.isInteger(raw.width) && raw.width > 0 ? raw.width : null,
    height: Number.isInteger(raw.height) && raw.height > 0 ? raw.height : null,
    createdAt: isoOrNull(raw.createdAt),
  };
}

/**
 * Record-level sanitizer fed to collectionStore — runs on every loadOne.
 * Returns null when the record is missing its identity (id or character),
 * which collectionStore treats as "invalid record".
 */
export function sanitizeLoraDataset(raw) {
  if (!isPlainObject(raw)) return null;
  const id = trim(raw.id);
  const character = isPlainObject(raw.character) ? raw.character : null;
  if (!id || !character) return null;
  const entryId = trim(character.entryId);
  const universeId = trim(character.universeId);
  if (!entryId || !universeId) return null;
  const training = isPlainObject(raw.training) ? raw.training : {};
  return {
    schemaVersion: LORA_DATASET_SCHEMA_VERSION,
    id,
    character: {
      entryId,
      entryKind: oneOf(character.entryKind, LORA_DATASET_ENTRY_KINDS, 'characters'),
      ingredientId: trim(character.ingredientId) || null,
      universeId,
      name: trim(character.name) || 'Unnamed',
    },
    triggerWord: isValidTriggerWord(raw.triggerWord) ? raw.triggerWord : '',
    status: oneOf(raw.status, DATASET_STATUSES, 'draft'),
    images: Array.isArray(raw.images) ? raw.images.map(sanitizeDatasetImage).filter(Boolean) : [],
    training: {
      lastJobId: trim(training.lastJobId) || null,
      lastRunId: trim(training.lastRunId) || null,
      loraFilename: trim(training.loraFilename) || null,
      completedAt: isoOrNull(training.completedAt),
    },
    createdAt: isoOrNull(raw.createdAt),
    updatedAt: isoOrNull(raw.updatedAt),
  };
}

/**
 * Derive a trigger word from a character name: lowercase, [a-z0-9_],
 * underscore-joined, numeric suffix on collision with `taken`. Trigger
 * words are single rare-ish tokens the trainer binds the character to —
 * the underscore join keeps multi-word names a single token.
 */
export function deriveTriggerWord(name, { taken = [] } = {}) {
  const base = trim(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics post-decompose
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    || 'character';
  const candidate = base.length >= 2 ? base : `${base}_x`;
  const takenSet = new Set(taken);
  if (!takenSet.has(candidate)) return candidate;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${candidate}${i}`;
    if (!takenSet.has(next)) return next;
  }
  // 999 collisions on one name never happens in practice; timestamp suffix
  // keeps the function total rather than throwing.
  return `${candidate}_${Date.now().toString(36)}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ensure a caption starts with exactly one `"<triggerWord>, "` prefix.
 * Idempotent; also strips a stale prefix when the trigger word changed
 * (`previousTriggerWord`). Empty caption text → just the trigger word, so
 * a not-yet-captioned image still carries the binding token.
 */
export function prefixCaption(triggerWord, text, { previousTriggerWord = null } = {}) {
  const word = trim(triggerWord);
  let body = trim(text);
  const stripPrefix = (value, token) => {
    if (!token) return value;
    // The `(?=[\s,]|$)` boundary is load-bearing: trigger words are short
    // [a-z0-9_] tokens that often prefix a real word (e.g. `her` in `heroic`),
    // and the trailing comma is optional — without the boundary, stripping
    // `her` from `heroic stance` would amputate it to `oic stance`.
    return value.replace(new RegExp(`^${escapeRe(token)}(?=[\\s,]|$)\\s*,?\\s*`, 'i'), '');
  };
  body = stripPrefix(body, word);
  const prev = trim(previousTriggerWord);
  if (prev && prev !== word) body = stripPrefix(body, prev);
  if (!word) return body;
  return body ? `${word}, ${body}` : word;
}

/**
 * Build `count` deterministic variation tuples for dataset generation.
 * Round-robin over each axis independently (not a full cartesian product)
 * so a small count still spans every view before repeating poses, and the
 * same inputs always produce the same tuples (testable, resumable). Pose
 * and expression cycles are phase-shifted by the wrap count so the axes
 * don't lock into repeating pairs.
 *
 * Axes are plain string arrays; the SERVICE derives expression/outfit axes
 * from character canon before calling (this module stays canon-agnostic).
 */
export function buildVariationMatrix({
  count = 12,
  views = null,
  poses = null,
  expressions = null,
  outfits = null,
} = {}) {
  const pickAxis = (axis, fallback) => (Array.isArray(axis) && axis.length
    ? axis.map((v) => trim(v)).filter(Boolean)
    : [...fallback]);
  const axisViews = pickAxis(views, DEFAULT_VIEWS);
  const axisPoses = pickAxis(poses, DEFAULT_POSES);
  const axisExpressions = pickAxis(expressions, ['neutral']);
  const axisOutfits = pickAxis(outfits, ['signature outfit']);
  const n = Math.max(1, Math.min(40, Number.isInteger(count) ? count : 12));
  const tuples = [];
  for (let i = 0; i < n; i += 1) {
    tuples.push({
      view: axisViews[i % axisViews.length],
      pose: axisPoses[(i + Math.floor(i / axisViews.length)) % axisPoses.length],
      expression: axisExpressions[(i + Math.floor(i / axisPoses.length)) % axisExpressions.length],
      // Block-assign outfits (first chunk of renders in outfit 1, next in
      // outfit 2, …) so each outfit gets contiguous view coverage instead
      // of a different outfit every frame.
      outfit: axisOutfits[Math.floor(i / Math.max(1, Math.ceil(n / axisOutfits.length))) % axisOutfits.length],
    });
  }
  return tuples;
}

/**
 * True when `caption` contains `triggerWord` as a whole token (bounded by a
 * non-[a-z0-9_] char or a string edge), not merely as a substring. A bare
 * `.includes()` would count a short trigger like `ai`/`jo` inside unrelated
 * words (`captain`, `train`), so readiness + the training manifest could
 * accept captions that don't actually carry the LoRA binding token. The
 * single source of truth for "does this caption bind the trigger" — used by
 * both computeDatasetReadiness and the server-side validateDatasetReady so
 * the gate and the manifest can't drift.
 */
export function captionHasTriggerWord(caption, triggerWord) {
  const word = trim(triggerWord);
  const text = trim(caption);
  if (!text) return false;
  if (!word) return true; // no trigger configured yet — any caption counts
  return new RegExp(`(?:^|[^a-z0-9_])${escapeRe(word)}(?:[^a-z0-9_]|$)`, 'i').test(text);
}

/**
 * Bucket a captioned-image count into a quality tier. Pure — shared by the
 * server readiness helper and mirrored client-side so the UI advisory and the
 * authoritative gate agree on wording:
 *   'insufficient' — below the hard minimum, not trainable
 *   'minimum'      — trainable but thin; more variety recommended
 *   'good'         — at/above the recommended quality target
 */
export function datasetQualityTier(captioned) {
  if (captioned < MIN_TRAINING_IMAGES) return 'insufficient';
  if (captioned < RECOMMENDED_TRAINING_IMAGES) return 'minimum';
  return 'good';
}

/**
 * Compute dataset readiness for training. Pure — callers pass the sanitized
 * record. `trainable` requires a trigger word plus MIN_TRAINING_IMAGES
 * images that are status 'ready' AND carry a caption with the trigger token.
 * `recommended`/`quality` are advisory only — they nudge toward a stronger
 * dataset without blocking a thin-but-valid run.
 */
export function computeDatasetReadiness(dataset) {
  const images = Array.isArray(dataset?.images) ? dataset.images : [];
  const triggerWord = trim(dataset?.triggerWord);
  const readyImages = images.filter((img) => img.status === 'ready');
  const captioned = readyImages.filter((img) => captionHasTriggerWord(img.caption, triggerWord));
  const trainable = !!triggerWord && captioned.length >= MIN_TRAINING_IMAGES;
  return {
    total: images.length,
    ready: readyImages.length,
    captioned: captioned.length,
    rendering: images.filter((img) => img.status === 'rendering').length,
    required: MIN_TRAINING_IMAGES,
    recommended: RECOMMENDED_TRAINING_IMAGES,
    trainable,
    // Gate the tier on trainability, not the raw captioned count: with no
    // trigger word captionHasTriggerWord counts every caption, so a record
    // with enough images but a missing/empty trigger would otherwise report
    // 'good' while trainable is false — and the UI would turn green "Ready to
    // train" while the train gate rejects the run. 'minimum'/'good' therefore
    // imply trainable by construction.
    quality: trainable ? datasetQualityTier(captioned.length) : 'insufficient',
  };
}

// A fragment shared by at least this fraction of the captioned images counts
// as "invariant identity" the trigger token should absorb instead. Set high
// (80%) on purpose: a *varying* attribute (pose, framing, a single view) shows
// up in only a slice of the set, while baked-in identity (white hair, circlet,
// tooth necklace) repeats in nearly every caption — so the threshold separates
// "describe who she is" from "describe what changes shot-to-shot" without
// flagging legitimate per-shot variation.
export const INVARIANT_SHARE_THRESHOLD = 0.8;
// Below this many captioned images "shared across most captions" is noise — a
// 3-image dataset where 3/3 repeat a fragment proves nothing. Gate the analysis
// so the warning only fires once there's enough signal to trust.
export const MIN_CAPTIONS_FOR_INVARIANT_ANALYSIS = 4;

// Strip a single leading `"<triggerWord>"` token from a caption, returning the
// descriptive body. Mirrors prefixCaption's own strip (same `(?=[\s,]|$)`
// boundary so a trigger that prefixes a real word isn't amputated).
const captionBody = (caption, triggerWord) => {
  const word = trim(triggerWord);
  let body = trim(caption);
  if (word) {
    body = body.replace(new RegExp(`^${escapeRe(word)}(?=[\\s,]|$)\\s*,?\\s*`, 'i'), '');
  }
  return body;
};

// Split a caption's descriptive body into comma-separated fragments. The
// captioner (and the manual-caption convention) emit ONE comma-separated list,
// so commas are the fragment boundary. Empty fragments are dropped.
const splitCaptionFragments = (caption, triggerWord) => captionBody(caption, triggerWord)
  .split(',')
  .map((f) => f.trim())
  .filter(Boolean);

// Normalize a fragment for cross-caption comparison: lowercase, collapse
// internal whitespace. "White Hair" and "white  hair" are the same invariant.
const normalizeFragment = (f) => trim(f).toLowerCase().replace(/\s+/g, ' ');

/**
 * Analyze the captioned images for invariant identity fragments — descriptive
 * phrases (hair/eyes/skin/signature items) that repeat across most captions and
 * therefore bind the character's identity to the caption PHRASES instead of the
 * trigger token (the failure mode in issue #1320). Pure — callers pass the
 * sanitized record's images.
 *
 * Counts each fragment once per caption (a caption repeating "white hair" twice
 * still counts once) and flags fragments present in ≥`threshold` of the
 * captioned images. Returns `{ analyzable, total, sharedFragments }` where each
 * shared fragment is `{ fragment, normalized, count, ratio }`, ordered most-
 * common first. `analyzable` is false (and `sharedFragments` empty) below
 * `minCaptions` — not enough signal to trust.
 */
export function analyzeCaptionInvariants(images, triggerWord, {
  threshold = INVARIANT_SHARE_THRESHOLD,
  minCaptions = MIN_CAPTIONS_FOR_INVARIANT_ANALYSIS,
} = {}) {
  const list = Array.isArray(images) ? images : [];
  const word = trim(triggerWord);
  const captioned = list.filter((img) => img?.status === 'ready' && captionHasTriggerWord(img.caption, word));
  const total = captioned.length;
  if (total < minCaptions) return { analyzable: false, total, sharedFragments: [] };
  const counts = new Map(); // normalized → { fragment (first-seen display), count }
  for (const img of captioned) {
    const seen = new Set(); // de-dupe within one caption
    for (const frag of splitCaptionFragments(img.caption, word)) {
      const norm = normalizeFragment(frag);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const cur = counts.get(norm) || { fragment: frag, count: 0 };
      cur.count += 1;
      counts.set(norm, cur);
    }
  }
  const sharedFragments = [...counts.entries()]
    .filter(([, v]) => v.count >= 2 && v.count / total >= threshold)
    .map(([normalized, v]) => ({ fragment: v.fragment, normalized, count: v.count, ratio: v.count / total }))
    .sort((a, b) => b.count - a.count || a.fragment.localeCompare(b.fragment));
  return { analyzable: true, total, sharedFragments };
}

/**
 * Remove the given shared fragments from one caption, preserving the trigger
 * prefix and the fragment order of everything kept. `fragmentsToStrip` is
 * matched by normalized form, so case/whitespace differences still strip. A
 * caption left with no descriptive body collapses to just the trigger word
 * (still a valid binding-only caption). Idempotent — re-running strips nothing.
 *
 * Works at the comma-fragment level. A bare-trigger fragment that sits MID-
 * caption (the trigger appears as its own fragment but not as the leading
 * prefix) is also dropped: prefixCaption re-adds the trigger once at the front,
 * so keeping the stray one would duplicate the token in the rewritten caption.
 */
export function stripSharedFragments(caption, fragmentsToStrip, triggerWord) {
  const stripSet = new Set((Array.isArray(fragmentsToStrip) ? fragmentsToStrip : [])
    .map(normalizeFragment)
    .filter(Boolean));
  if (!stripSet.size) return trim(caption);
  const word = trim(triggerWord);
  const wordNorm = word.toLowerCase();
  const kept = splitCaptionFragments(caption, word).filter((frag) => {
    const norm = normalizeFragment(frag);
    return !stripSet.has(norm) && (!wordNorm || norm !== wordNorm);
  });
  return prefixCaption(word, kept.join(', '));
}
