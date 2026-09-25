import { getGalleryImages, getVideoHistoryItem, listImageVariants } from '../../services/apiImageVideo';
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

// GET /image-gen/:filename/variants read in flight, keyed by filename. This
// hydration module (`fetchMediaRecord`, below) and `useImageVariants` (the
// lightbox's original-vs-cleaned toggle) both want this SAME group the
// instant a preview opens — the group always carries the opened filename's
// own full record — and their effects commit in the same React flush, so a
// plain fetch from each site would transfer the same ~group twice (#8341).
// De-duped only while in flight, not cached past resolution: a later reopen
// asks the server fresh.
const variantGroupRequests = new Map();

/**
 * Raw (unnormalized) variant-group read for one image filename, shared across
 * every caller that wants it for the same open. Rejects like the underlying
 * `listImageVariants` call; callers decide their own fallback.
 */
export function fetchImageVariantGroup(filename) {
  if (!filename) return Promise.resolve(null);
  let request = variantGroupRequests.get(filename);
  if (!request) {
    request = listImageVariants(filename)
      .then((result) => (Array.isArray(result?.items) ? result.items : null))
      .finally(() => {
        if (variantGroupRequests.get(filename) === request) variantGroupRequests.delete(filename);
      });
    variantGroupRequests.set(filename, request);
  }
  return request;
}

function fetchGalleryLookup(ref) {
  return getGalleryImages([ref], { silent: true })
    .then((list) => (Array.isArray(list) ? list : []).find((i) => i?.filename === ref) || null);
}

/**
 * Resolves the stored record, or null when the server holds none. An image
 * routes through the shared variant-group read first — that group always
 * carries the opened filename's own record — so the lightbox costs exactly
 * one full-record transfer instead of a separate `gallery/lookup` PLUS the
 * `variants` read `MediaPreview` makes for the original-vs-cleaned toggle.
 * Falls back to `gallery/lookup` when the variants read fails, or when the
 * group resolves without the filename (not indexed). Videos have no variants
 * endpoint and always use the history read.
 */
export function fetchMediaRecord(kind, ref) {
  if (kind === 'video') return getVideoHistoryItem(ref, { silent: true });
  return fetchImageVariantGroup(ref)
    .then((items) => (items || []).find((item) => item?.filename === ref) || fetchGalleryLookup(ref))
    .catch(() => fetchGalleryLookup(ref));
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
