/** Actual original-media sizes, enriched only after a page has been selected. */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './paths.js';
import { isTopLevelEntryName } from './pathSafety.js';
import { mapWithConcurrency } from './mapWithConcurrency.js';

export async function withMediaFileSize(kind, record) {
  if (!record) return record;
  // Stored metadata can outlive a replacement or a missing file. Never present
  // its old size as a current measurement, or an unavailable size as zero.
  const data = { ...record };
  delete data.fileSizeBytes;
  if (!['image', 'video'].includes(kind) || !isTopLevelEntryName(data.filename)) return data;
  const directory = kind === 'image' ? PATHS.images : PATHS.videos;
  const info = await stat(join(directory, data.filename)).catch(() => null);
  return info?.isFile() ? { ...data, fileSizeBytes: info.size } : data;
}

/** Accepts plain records of one kind or the mixed gallery's { kind, data } rows. */
export function withMediaFileSizes(items, kind) {
  return mapWithConcurrency(items, 4, async item => kind
    ? withMediaFileSize(kind, item)
    : { ...item, data: await withMediaFileSize(item.kind, item.data) });
}
