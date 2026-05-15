/**
 * Origin metadata for records imported from share buckets.
 *
 * When a pipeline series / issue / universe / media collection item is imported
 * from another PortOS instance via a share bucket, the importer stamps the
 * record with `origin: { ... }`. Locally-authored records have no `origin`.
 *
 * Single level of provenance only — re-sharing authors a fresh origin on the
 * recipient; we do not maintain a chain[]. Keep it simple; if attribution
 * chains become important, the manifest archive in the bucket still has the
 * full history.
 */

import { isStr, trimTo } from './storyBible.js';

export const ORIGIN_BUCKET_ID_MAX = 64;
export const ORIGIN_BUCKET_NAME_MAX = 120;
export const ORIGIN_SOURCE_MAX = 120;
export const ORIGIN_SOURCE_BIO_MAX = 2000;
export const ORIGIN_MANIFEST_ID_MAX = 64;

export function sanitizeOrigin(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bucketId = trimTo(raw.bucketId, ORIGIN_BUCKET_ID_MAX);
  const bucketName = trimTo(raw.bucketName, ORIGIN_BUCKET_NAME_MAX);
  const source = trimTo(raw.source, ORIGIN_SOURCE_MAX);
  const manifestId = trimTo(raw.manifestId, ORIGIN_MANIFEST_ID_MAX);
  // bucketId + source + manifestId are the load-bearing identifiers. If any
  // is missing the origin metadata is degenerate — drop the whole field
  // rather than persist a half-record that the UI can't render.
  if (!bucketId || !source || !manifestId) return null;
  const sourceBio = trimTo(raw.sourceBio, ORIGIN_SOURCE_BIO_MAX) || null;
  const importedAt = isStr(raw.importedAt) ? raw.importedAt : new Date().toISOString();
  return { bucketId, bucketName: bucketName || bucketId, source, sourceBio, manifestId, importedAt };
}
