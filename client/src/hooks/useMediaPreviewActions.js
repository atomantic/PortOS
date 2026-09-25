import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import toast from '../components/ui/Toast';
import { cleanGalleryImage, extractLastFrame, removeImageWatermark } from '../services/apiImageVideo';
import { normalizeVideoTiling } from '../lib/videoTilingOptions';
import { hydrateMediaItem } from '../components/media/mediaDetail';

// Handoffs that copy a record's prompt/settings into a generator form read the
// FULL record: a compact gallery item (#8292) only holds a prompt preview, so
// it is hydrated first, and a failed lookup stops the action with a toast
// instead of silently sending the truncated text. Resolves null on failure.
async function withFullDetail(item) {
  return hydrateMediaItem(item).catch((err) => {
    toast.error(err.message || 'Could not load full media details');
    return null;
  });
}

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

// Common params for every /media/video handoff — Send-to-Video (an image
// becomes the i2v source) and Continue (a clip's last frame does). Both open
// the form on the direction that produced the source, so the user isn't
// retyping a prompt the record already carries. `(no prompt)` is the sidecar
// placeholder for items that lost theirs — skip it so the next render doesn't
// start with that literal, and an item we never generated lands on a blank
// prompt rather than a bogus one. The caller adds `sourceImageFile`, which is
// the only thing that differs between the two.
function buildVideoGenParams(item) {
  const params = new URLSearchParams();
  if (item.prompt && item.prompt !== '(no prompt)') params.set('prompt', item.prompt);
  const neg = item.negativePrompt || item.raw?.negativePrompt || item.raw?.negative_prompt;
  if (neg) params.set('negativePrompt', neg);
  if (item.width) params.set('w', String(item.width));
  if (item.height) params.set('h', String(item.height));
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
  //
  // Saved videos hand over the record id, and saved images hand over the
  // filename, rather than maintaining a second field-by-field restore path.
  // The destination resolves the record and reuses its in-page restore logic.
  // Filename-less images and id-less videos keep their legacy bundles for
  // compatibility; those bundles are not extended. A compact gallery item
  // always carries its filename/id, so it takes the reference path and never
  // needs hydrating here.
  const handleRemix = useCallback((item) => {
    if (!item) return;
    if (item.kind === 'video') {
      if (item.id != null && item.id !== '') {
        navigate(`/media/video?remix=${encodeURIComponent(item.id)}`);
        return;
      }
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
      const tiling = normalizeVideoTiling(raw.tiling);
      if (tiling) params.set('tiling', tiling);
      const disableAudio = raw.disableAudio ?? raw.disable_audio;
      if (disableAudio === true) params.set('disableAudio', '1');
      navigate(`/media/video?${params}`);
      return;
    }
    if (item.filename) {
      navigate('/media/image?remix=' + encodeURIComponent(item.filename));
      return;
    }
    const params = buildImageGenParams(item);
    navigate(`/media/image?${params}`);
  }, [navigate]);

  // Send to image-to-image: open the Image Gen page with this image queued as
  // the i2i init image AND the prompt + render settings pre-filled (like Remix),
  // so the user lands in a full "iterate on this image" state. Images only — the
  // ImageGen page resolves `?initImageFile=<basename>` against the gallery and
  // nudges to an i2i-capable backend. Deliberately omits the `remix` param so it
  // reads as a distinct intent from plain Remix.
  const handleSendToImage = useCallback(async (source) => {
    if (!source?.filename || source.kind === 'video') return;
    const item = await withFullDetail(source);
    if (!item) return;
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
  // i2v source.
  const handleSendToVideo = useCallback(async (source) => {
    if (!source?.filename) return;
    const item = await withFullDetail(source);
    if (!item) return;
    const params = buildVideoGenParams(item);
    params.set('sourceImageFile', item.filename);
    navigate(`/media/video?${params}`);
  }, [navigate]);

  // Send to 3D: open the image-to-3D workspace (/3d) with this image as the
  // source. Images only — the 3D page resolves `?image=<filename>` against the
  // gallery (URL is the source of truth for the staged source image).
  const handleSendTo3d = useCallback((item) => {
    if (!item?.filename || item.kind === 'video') return;
    navigate(`/3d?image=${encodeURIComponent(item.filename)}`);
  }, [navigate]);

  // Continue: extract the LAST frame of a video clip and seed Video Gen
  // with it as the i2v source — the canonical "extend this take" path.
  // `item.id` is the video job id; extractLastFrame returns the new image
  // filename. Toast handles the error path; the caller doesn't need to.
  // Takes the NORMALIZED item (normalizeVideo) — buildVideoGenParams reads the
  // prompt/negative off that shape, so a raw history record must be normalized
  // by the caller rather than passed through.
  const handleContinue = useCallback(async (source) => {
    if (!source?.id) return;
    // Before extracting, so a failed lookup leaves no orphaned frame behind.
    const item = await withFullDetail(source);
    if (!item) return;
    const { filename } = await extractLastFrame(item.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return {};
    });
    if (!filename) return;
    const params = buildVideoGenParams(item);
    params.set('sourceImageFile', filename);
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
