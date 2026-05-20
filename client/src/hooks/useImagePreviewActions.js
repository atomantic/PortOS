import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from '../components/ui/Toast';
import { cleanGalleryImage, extractLastFrame } from '../services/apiImageVideo';

/**
 * Shared MediaPreview / MediaLightbox action handlers. The same four
 * callbacks (`onRemix`, `onSendToVideo`, `onContinue`, `onClean`) used to
 * live as identical copies in `pages/MediaHistory.jsx`,
 * `pages/MediaCollectionDetail.jsx`, `pages/ImageGen.jsx`, and the new
 * Universe Builder lightbox — drift between them produced subtle differences
 * (one consumer set `width` as a URL param, another didn't; one passed
 * `negativePrompt`, another aliased it from `raw.negative_prompt`). This
 * hook is the single source of truth so consumers all open the same
 * downstream pages with the same param set, and post-clean behavior is
 * the only piece that differs per surface (collection-add vs. local-list
 * prepend vs. ignore) — supplied via `onCleanComplete`.
 *
 * @param {object} [options]
 * @param {(cleaned: object) => any | Promise<any>} [options.onCleanComplete]
 *   Fires AFTER `cleanGalleryImage` resolves. Use it to splice the cleaned
 *   image into the consumer's local state (collection items, gallery list,
 *   variation imageRefs, etc.). Errors thrown from the callback bubble.
 *
 * Returns the four handlers shaped for direct use as MediaPreview props.
 */
export default function useImagePreviewActions({ onCleanComplete = null } = {}) {
  const navigate = useNavigate();

  // Remix: hand the prompt + render settings to the Image Gen page so the
  // user can iterate. `(no prompt)` is the metadata-sidecar placeholder for
  // images that lost their prompt — skip it so the next render doesn't
  // start with that literal as the user's prompt.
  const handleRemix = useCallback((item) => {
    if (!item) return;
    const params = new URLSearchParams();
    if (item.prompt && item.prompt !== '(no prompt)') params.set('prompt', item.prompt);
    if (item.negativePrompt) params.set('negativePrompt', item.negativePrompt);
    if (item.modelId) params.set('modelId', item.modelId);
    if (item.width) params.set('width', String(item.width));
    if (item.height) params.set('height', String(item.height));
    if (item.seed != null) params.set('seed', String(item.seed));
    if (item.steps) params.set('steps', String(item.steps));
    if (item.guidance != null) params.set('guidance', String(item.guidance));
    if (item.quantize) params.set('quantize', String(item.quantize));
    if (item.filename) params.set('remix', item.filename);
    navigate(`/media/image?${params}`);
  }, [navigate]);

  // Send to Video: open the Video Gen page with the image queued as the
  // i2v source. `negativePrompt` is resolved from any of the legacy aliases
  // (`raw.negativePrompt` / `raw.negative_prompt`) so older metadata still
  // populates the field.
  const handleSendToVideo = useCallback((item) => {
    if (!item?.filename) return;
    const params = new URLSearchParams({ sourceImageFile: item.filename });
    if (item.prompt && item.prompt !== '(no prompt)') params.set('prompt', item.prompt);
    const neg = item.negativePrompt || item.raw?.negativePrompt || item.raw?.negative_prompt;
    if (neg) params.set('negativePrompt', neg);
    if (item.width) params.set('w', String(item.width));
    if (item.height) params.set('h', String(item.height));
    navigate(`/media/video?${params}`);
  }, [navigate]);

  // Continue: extract the LAST frame of a video clip and seed Video Gen
  // with it as the i2v source — the canonical "extend this take" path.
  // `item.id` is the video job id; extractLastFrame returns the new image
  // filename. Toast handles the error path; the caller doesn't need to.
  const handleContinue = useCallback(async (item) => {
    if (!item?.id) return;
    const { filename } = await extractLastFrame(item.id).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return {};
    });
    if (!filename) return;
    const params = new URLSearchParams({ sourceImageFile: filename });
    if (item.width) params.set('w', String(item.width));
    if (item.height) params.set('h', String(item.height));
    navigate(`/media/video?${params}`);
  }, [navigate]);

  // Clean: re-encode + denoise via the gallery clean endpoint to strip C2PA
  // provenance and reduce AI artifacts. Returns the resulting gallery item so
  // consumers can splice it into local state. `onCleanComplete` is the
  // consumer-specific post-step (add-to-collection / prepend-to-history /
  // etc.) — fired AFTER the success toast so a failing post-step still shows
  // the user the clean succeeded server-side.
  const handleClean = useCallback(async (img) => {
    if (!img?.filename) throw new Error('Missing filename');
    const cleaned = await cleanGalleryImage(img.filename).catch((err) => {
      toast.error(err.message || 'Failed to clean image');
      throw err;
    });
    toast.success(`Cleaned → ${cleaned.filename}`);
    if (onCleanComplete) await onCleanComplete(cleaned);
    return cleaned;
  }, [onCleanComplete]);

  return { handleRemix, handleSendToVideo, handleContinue, handleClean };
}
