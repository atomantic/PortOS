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

/**
 * Build an index row for a generated image. `item` is a gallery entry as
 * produced by imageGen listGallery() — `{ filename, createdAt, ...sidecar }` —
 * or any object carrying at least a `filename`. Returns null when there's no
 * usable ref (so callers can filter).
 */
export function imageToRow(item, { now } = {}) {
  const ref = item?.filename;
  if (typeof ref !== 'string' || !ref) return null;
  const fallback = now || new Date().toISOString();
  return {
    mediaKey: itemKey({ kind: 'image', ref }),
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
  if (typeof ref !== 'string' || !ref) return null;
  const fallback = now || new Date().toISOString();
  return {
    mediaKey: itemKey({ kind: 'video', ref }),
    kind: 'video',
    ref,
    data: entry,
    createdAt: mirrorTimestamp(entry.createdAt, fallback),
  };
}
