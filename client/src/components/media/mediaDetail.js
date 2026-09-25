import { getGalleryImages, getVideoHistoryItem } from '../../services/apiImageVideo';
import { normalizeImage, normalizeVideo } from './normalize';

/**
 * Full-record reads for a normalized media item, shared by the lightbox's lazy
 * hydration (`useHydratedPreviewRoute`) and by actions that hand a record's
 * prompt/settings to a generator (`useMediaPreviewActions`).
 *
 * An item from a compact gallery list (`item.compact`, #8292) carries only a
 * prompt PREVIEW. Nothing may edit that preview or pass it on as the prompt —
 * `hydrateMediaItem` is the one way to turn such an item into the real record.
 */

// What the record is looked up BY: images by filename, videos by history id.
// An item with neither (a synthetic entry backed by no gallery record) has
// nothing to hydrate from.
export function mediaRecordRef(item) {
  if (item?.kind === 'image' && item.filename) return item.filename;
  if (item?.kind === 'video' && item.id) return item.id;
  return null;
}

/** Resolves the stored record, or null when the server holds none. */
export function fetchMediaRecord(kind, ref) {
  if (kind === 'video') return getVideoHistoryItem(ref, { silent: true });
  return getGalleryImages([ref], { silent: true })
    .then((list) => (Array.isArray(list) ? list : []).find((i) => i?.filename === ref) || null);
}

/**
 * Merge a fetched record over the host's item. The record wins on every field
 * it carries; the host's `key` is kept outright, since prev/next nav and the
 * annotation lookup match on it.
 */
export function mergeMediaRecord(item, record) {
  const normalize = item.kind === 'video' ? normalizeVideo : normalizeImage;
  // A host label may stand in for a record with no prompt — but never a
  // compact preview, which is a truncation of text the record itself lacks.
  const fallbackPrompt = item.compact ? undefined : item.prompt;
  const merged = normalize({ ...record, prompt: record.prompt || fallbackPrompt });
  return {
    ...merged,
    key: item.key,
    negativePrompt: merged.negativePrompt || (item.compact ? null : item.negativePrompt) || null,
    // A host may point at a file the normalizer can't address from the record
    // alone — a video-history entry with no thumbnail still has the host's
    // job-scoped poster.
    previewUrl: merged.previewUrl || item.previewUrl || null,
    downloadUrl: merged.downloadUrl || item.downloadUrl || null,
  };
}

/**
 * The complete item for an action that reads prompt/settings. A full item is
 * returned as-is; a compact one is hydrated, and a failed or empty lookup
 * throws rather than falling back to the preview.
 */
export async function hydrateMediaItem(item) {
  if (!item?.compact) return item;
  const ref = mediaRecordRef(item);
  const record = ref ? await fetchMediaRecord(item.kind, ref) : null;
  if (!record) throw new Error('Full media details are unavailable');
  return mergeMediaRecord(item, record);
}
