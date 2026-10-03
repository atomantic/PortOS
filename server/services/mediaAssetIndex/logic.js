/**
 * Media asset index — pure row transforms.
 *
 * The index (#1000) is a DERIVED, queryable mirror of media that physically
 * lives on disk: generated images (data/images/*.png + .metadata.json sidecars)
 * and generated videos (data/videos/*.mp4, tracked in data/video-history.json).
 * Those files stay authoritative; this module just turns a disk record into the
 * `media_assets` row shape so the reconcile pass + the live completed-hook can
 * never drift on what a row looks like. No I/O here.
 *
 * A row is `{ mediaKey, kind, ref, data, createdAt }`:
 *   - kind/ref          → the shared `<kind>:<ref>` vocabulary (mediaItemKey.js)
 *   - mediaKey          → `<kind>:<ref>` (the PK)
 *   - data              → the full metadata record, stored verbatim in JSONB
 *   - createdAt         → bind-safe TIMESTAMPTZ for the queryable column
 */

import { itemKey } from '../../lib/mediaItemKey.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';

// The one place each kind's ref is turned into a media_key. Both the row
// builders (which WRITE rows) and the delete hooks (which REMOVE them) derive
// their key here, so an unindex can never miss the row its upsert wrote.
// Returns null for an unusable ref, so callers can filter/no-op on it.
const mediaKeyFor = (kind, ref) => (typeof ref === 'string' && ref ? itemKey({ kind, ref }) : null);

/** media_key for a generated image. Its ref is the gallery FILENAME. */
export const imageMediaKey = (filename) => mediaKeyFor('image', filename);

/** media_key for a generated video. Its ref is the job ID, not the filename. */
export const videoMediaKey = (id) => mediaKeyFor('video', id);

/**
 * Build an index row for a generated image. `item` is a gallery entry as
 * produced by imageGen listGallery() — `{ filename, createdAt, ...sidecar }` —
 * or any object carrying at least a `filename`. Returns null when there's no
 * usable ref (so callers can filter).
 */
export function imageToRow(item, { now } = {}) {
  const ref = item?.filename;
  const mediaKey = imageMediaKey(ref);
  if (!mediaKey) return null;
  const fallback = now || new Date().toISOString();
  return {
    mediaKey,
    kind: 'image',
    ref,
    data: item,
    createdAt: mirrorTimestamp(item.createdAt, fallback),
  };
}

/**
 * Build an index row for a generated video. `entry` is a video-history record —
 * `{ id, filename, createdAt, ... }`. The video's ref in the `<kind>:<ref>`
 * vocabulary is its job id (matches how mediaCollections stores video items),
 * NOT the filename. Returns null when there's no usable id.
 */
export function videoToRow(entry, { now } = {}) {
  const ref = entry?.id;
  const mediaKey = videoMediaKey(ref);
  if (!mediaKey) return null;
  const fallback = now || new Date().toISOString();
  return {
    mediaKey,
    kind: 'video',
    ref,
    data: entry,
    createdAt: mirrorTimestamp(entry.createdAt, fallback),
  };
}

// Card fields a compact list row keeps: identity, file addressing, lineage
// badges and the chips MediaCard renders. Everything else — full prompts,
// negative prompts, provider payloads — stays on the record and is read on
// demand (`/gallery/lookup`, `/video-gen/history/:id`).
const COMPACT_FIELDS = ['id', 'filename', 'path', 'thumbnail', 'createdAt', 'hidden', 'width', 'height',
  'appId', 'model', 'modelId', 'mode', 'seed', 'steps', 'numFrames', 'fps', 'renderMs', 'loraFilenames',
  'lora_filenames', 'loraPaths', 'lora_paths', 'stitchedFrom', 'upscaledFrom', 'extractedFromVideoId',
  'cleanedFrom', 'autoCleaned', 'regenerated', 'watermarkRemoved'];
export const COMPACT_PROMPT_CHARS = 240;
// Scalars the list predicates read (db.js assetFilter) that are not card
// fields. A compact source keeps them so scope filters match exactly as they
// do over the full record; compactSourceToRow drops them.
const COMPACT_FILTER_FIELDS = ['universeId', 'entryCategory', 'entryKind'];
export const COMPACT_SOURCE_FIELDS = [...COMPACT_FIELDS, ...COMPACT_FILTER_FIELDS];
// Internal key carrying the chosen prompt, bounded to one character past the
// preview so the preview (and its ellipsis) is identical to one cut from the
// full prompt. Never returned to a client.
export const COMPACT_PREVIEW_KEY = '_promptPreviewSource';

const nonBlank = value => typeof value === 'string' && value.trim() ? value : null;

/**
 * Bounded projection of a full record: card fields, filter-only scalars and
 * the bounded preview source. This is what a compact no-search list sends to
 * SQL in place of the full video-history record (#9676); db.js builds the
 * same shape for indexed images in SQL.
 */
export function compactSource(data) {
  if (!data || typeof data !== 'object') return data;
  const source = {};
  for (const field of COMPACT_SOURCE_FIELDS) if (data[field] !== undefined) source[field] = data[field];
  const prompt = nonBlank(data.prompt) || nonBlank(data.metadata?.prompt);
  if (prompt) source[COMPACT_PREVIEW_KEY] = prompt.slice(0, COMPACT_PROMPT_CHARS + 1);
  return source;
}

/** The client-facing compact row for a compact source; internal fields are dropped. */
export function compactSourceToRow(source) {
  if (!source || typeof source !== 'object') return source;
  const row = { compact: true };
  for (const field of COMPACT_FIELDS) if (source[field] !== undefined) row[field] = source[field];
  const prompt = source[COMPACT_PREVIEW_KEY];
  if (typeof prompt === 'string' && prompt) {
    row.prompt = prompt.length > COMPACT_PROMPT_CHARS ? `${prompt.slice(0, COMPACT_PROMPT_CHARS).trimEnd()}…` : prompt;
  }
  return row;
}

/**
 * Opt-in list projection (#8292). `compact: true` marks the row as a PREVIEW:
 * its prompt is cut to a display label, so a consumer must hydrate the full
 * record before editing it or handing its prompt/settings to a generation
 * action. Search and counts still run over the full stored metadata.
 */
export const compactGalleryRecord = data => compactSourceToRow(compactSource(data));
