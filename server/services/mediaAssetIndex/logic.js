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
