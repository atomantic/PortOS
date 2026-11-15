import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { getHistoryItem } from '../videoGen/history.js';

// --- Scene takes (#8965) ---
// Every render or import for a scene slot is kept as an immutable take; the
// slot field is the director's explicit selection among them. A take's asset
// must already exist in this install's media stores — an image in the gallery,
// a clip in the video history (both reached through the existing upload
// routes) — so a take can never point at an arbitrary file.
export async function takeAssetExists(kind, assetId) {
  if (kind !== 'video') return Boolean(resolveGalleryImage(assetId));
  return Boolean(await getHistoryItem(assetId));
}
