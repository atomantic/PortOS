import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from '../components/ui/Toast';
import { cleanGalleryImage, extractLastFrame, removeImageWatermark } from '../services/apiImageVideo';
import { VIDEO_TILING_ENUM_SET } from '../lib/videoTilingOptions';

// Common image render-setting params shared by the image branch of Remix and by
// Send-to-image-to-image — both open /media/image with these fields prefilled.
// The callers diverge after: Remix adds `remix`, while Send-to-i2i adds
// `initImageFile` AND drops `modelId` (i2i may auto-switch backends, so the
// source's model must not poison the target form). `(no prompt)` is the
// metadata-sidecar placeholder for items that lost their prompt — skip it so the
// next render doesn't start with that literal.
function buildImageGenParams(item) {
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
  return params;
}

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
 *   Fires AFTER a Clean (`handleClean`) or watermark-removal resolves. Use it to
 *   splice the resulting variant into the consumer's local state (collection
 *   items, gallery list, variation imageRefs, etc.). Errors thrown from the
 *   callback bubble.
 *
 * Returns the four handlers shaped for direct use as MediaPreview props.
 */
export default function useMediaPreviewActions({ onCleanComplete = null } = {}) {
  const navigate = useNavigate();

  // Remix: hand the prompt + render settings to the source-kind's gen page
  // so the user can iterate. `(no prompt)` is the metadata-sidecar placeholder
  // for items that lost their prompt — skip it so the next render doesn't
  // start with that literal as the user's prompt.
  //
  // Dispatches by item.kind: images go to /media/image (with image-shaped
  // params), videos go to /media/video (with video-shaped params — frames,
  // fps, tiling, etc.). Video remix lands the user in 'text' mode with all
  // params filled; they can switch to image/extend mode and pick a source.
  const handleRemix = useCallback((item) => {
    if (!item) return;
    if (item.kind === 'video') {
      const params = new URLSearchParams();
      if (item.prompt && item.prompt !== '(no prompt)') params.set('prompt', item.prompt);
      if (item.negativePrompt) params.set('negativePrompt', item.negativePrompt);
      if (item.modelId) params.set('modelId', item.modelId);
      if (item.width) params.set('w', String(item.width));
      if (item.height) params.set('h', String(item.height));
      if (item.numFrames) params.set('numFrames', String(item.numFrames));
      if (item.fps) params.set('fps', String(item.fps));
      const raw = item.raw || {};
      const seed = raw.seed;
      if (seed != null && seed !== '') params.set('seed', String(seed));
      if (raw.steps != null && raw.steps !== '') params.set('steps', String(raw.steps));
      const guidance = raw.guidanceScale ?? raw.guidance_scale ?? raw.guidance;
      if (guidance != null && guidance !== '') params.set('guidanceScale', String(guidance));
      // tiling must match the server's enum. Legacy sidecars sometimes store
      // a boolean here — pass through only known-good string values so the
      // remixed POST doesn't 400 on /api/video-gen validation.
      if (typeof raw.tiling === 'string' && VIDEO_TILING_ENUM_SET.has(raw.tiling)) {
        params.set('tiling', raw.tiling);
      }
      const disableAudio = raw.disableAudio ?? raw.disable_audio;
      if (disableAudio === true) params.set('disableAudio', '1');
      navigate(`/media/video?${params}`);
      return;
    }
    const params = buildImageGenParams(item);
    if (item.filename) params.set('remix', item.filename);
    navigate(`/media/image?${params}`);
  }, [navigate]);

  // Send to image-to-image: open the Image Gen page with this image queued as
  // the i2i init image AND the prompt + render settings pre-filled (like Remix),
  // so the user lands in a full "iterate on this image" state. Images only — the
  // ImageGen page resolves `?initImageFile=<basename>` against the gallery and
  // nudges to an i2i-capable backend. Deliberately omits the `remix` param so it
  // reads as a distinct intent from plain Remix.
  const handleSendToImage = useCallback((item) => {
    if (!item?.filename || item.kind === 'video') return;
    const params = buildImageGenParams(item);
    // Drop modelId: i2i is image-driven and the page may auto-switch the user to
    // a different (i2i-capable) backend, so the source's model — often a
    // provider-specific id like `gpt-image-2` or a checkpoint the target backend
    // lacks — would poison the form and fail on Generate. Let the target keep its
    // own current/default model. (The in-page handler routes through handleRemix,
    // which already guards modelId against the loaded model list.)
    params.delete('modelId');
    params.set('initImageFile', item.filename);
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

  // Send to 3D: open the image-to-3D workspace (/media/3d) with this image as the
  // source. Images only — the 3D page resolves `?image=<filename>` against the
  // gallery (URL is the source of truth for the staged source image).
  const handleSendTo3d = useCallback((item) => {
    if (!item?.filename || item.kind === 'video') return;
    navigate(`/media/3d?image=${encodeURIComponent(item.filename)}`);
  }, [navigate]);

  // Continue: extract the LAST frame of a video clip and seed Video Gen
  // with it as the i2v source — the canonical "extend this take" path.
  // `item.id` is the video job id; extractLastFrame returns the new image
  // filename. Toast handles the error path; the caller doesn't need to.
  const handleContinue = useCallback(async (item) => {
    if (!item?.id) return;
    const { filename } = await extractLastFrame(item.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return {};
    });
    if (!filename) return;
    const params = new URLSearchParams({ sourceImageFile: filename });
    if (item.width) params.set('w', String(item.width));
    if (item.height) params.set('h', String(item.height));
    navigate(`/media/video?${params}`);
  }, [navigate]);

  // Clean: run the gallery clean endpoint, which applies the CPU resize-squeeze
  // (a downscale→upscale resolution shift) — it re-encodes to PNG so it still
  // strips the C2PA provenance chunk AND perturbs SynthID's resolution-dependent
  // carriers (issue #1764: validated best-effort against OpenAI's SynthID
  // detector — it makes the detector fail to return a positive; best-effort/
  // detector-dependent, never a guaranteed removal). Runs on the /clean endpoint
  // (not the regen endpoint) so the result is tagged as a clean — its lineage
  // reads "Cleaned (resize-squeeze)", distinct from the Regenerate panel's own
  // light pass ("Regenerated (light)"). Returns the new gallery variant directly.
  // `onCleanComplete` is the consumer-specific post-step (add-to-collection /
  // prepend-to-history / etc.) — fired AFTER the success toast so a failing
  // post-step still shows the user it succeeded.
  const handleClean = useCallback(async (img) => {
    if (!img?.filename) throw new Error('Missing filename');
    const cleaned = await cleanGalleryImage(img.filename, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to clean image');
      throw err;
    });
    toast.success(`Cleaned → ${cleaned.filename}`);
    if (onCleanComplete) await onCleanComplete(cleaned);
    return cleaned;
  }, [onCleanComplete]);

  // Remove watermark: erase the visible Gemini/Nano-Banana ✦ from the
  // bottom-right corner via a localized inpaint. Like Clean, it returns a new
  // `_nowatermark.png` gallery variant — reuse the same `onCleanComplete`
  // splice callback so the variant lands in the consumer's local state.
  const handleRemoveWatermark = useCallback(async (img) => {
    if (!img?.filename) throw new Error('Missing filename');
    const variant = await removeImageWatermark(img.filename).catch((err) => {
      toast.error(err.message || 'Failed to remove watermark');
      throw err;
    });
    toast.success(`Watermark removed → ${variant.filename}`);
    if (onCleanComplete) await onCleanComplete(variant);
    return variant;
  }, [onCleanComplete]);

  return { handleRemix, handleSendToImage, handleSendToVideo, handleSendTo3d, handleContinue, handleClean, handleRemoveWatermark };
}
