/**
 * Resolve collection video IDs against the locally stored video history.
 * Older collections can also contain a literal filename or a bare render ID.
 */
import { extname } from 'node:path';
import { sanitizeAssetFilename } from './sharing/buckets.js';

export const VIDEO_FILE_EXTENSIONS = Object.freeze(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);

export function collectionVideoRefToFilename(ref) {
  return /\.[a-z0-9]+$/i.test(ref) ? ref : `${ref}.mp4`;
}

const noHistory = new Map();
let indexedHistory;
let filenamesById = noHistory;

export async function loadCollectionVideoFilenames(items) {
  if (!Array.isArray(items) || !items.some((item) => item?.kind === 'video')) return noHistory;
  const rows = await import('./videoGen/history.js').then((m) => m.loadCompactHistory()).catch(() => null);
  if (!rows) return null;
  if (rows === indexedHistory) return filenamesById;
  const next = new Map();
  for (const row of rows) {
    if (typeof row?.id !== 'string' || next.has(row.id)) continue;
    const filename = sanitizeAssetFilename(row.filename);
    const valid = filename && !filename.startsWith('.') && !/[\u0000-\u001f\u007f]/.test(filename)
      && VIDEO_FILE_EXTENSIONS.includes(extname(filename).toLowerCase());
    next.set(row.id, valid ? filename : null);
  }
  indexedHistory = rows;
  filenamesById = next;
  return next;
}

export function resolveCollectionVideoFilename(ref, history = noHistory) {
  if (!history || !sanitizeAssetFilename(ref)) return null;
  return history.has(ref) ? history.get(ref) : collectionVideoRefToFilename(ref);
}
