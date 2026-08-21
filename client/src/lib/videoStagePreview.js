/**
 * VideoGen main-stage preview resolver (#4588).
 *
 * VideoGen used to show nothing but a percentage next to the Generate button
 * until the MP4 landed. This picks what the page's main stage should display at
 * any moment of a render — a live runner frame when one exists, otherwise the
 * conditioning the render is forming FROM (the clip an extend continues, the
 * start/keyframe/end still an i2v or FFLF render is growing out of), and the
 * finished clip once it arrives.
 *
 * Pure: every input is already in the page's hands, nothing fetches. The
 * component owns the hold/return behaviour; this module owns "what would be
 * correct to show right now".
 */

export const VIDEO_STAGE_KIND = Object.freeze({
  LIVE: 'live',     // a decoded frame from the in-flight render
  LOOP: 'loop',     // an animated clip (the source an extend continues)
  STILL: 'still',   // a conditioning image (start frame / keyframe / end frame)
  RESULT: 'result', // a finished render
  EMPTY: 'empty',   // nothing to show yet
});

const isPositive = (value) => Number.isFinite(value) && value > 0;
const nonEmpty = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The render's aspect ratio as a plain number for an inline `aspect-ratio`
 * style. Deliberately NOT a Tailwind `aspect-[w/h]` class — a computed class
 * name never reaches the JIT build (see `previewAspectClass` in
 * creativeDirectorPreview.js for the same trap).
 *
 * Returns `null` — not a 16:9 guess — when either edge is missing or bogus, so
 * a caller can tell "unknown geometry" from "known and square" and let the
 * media size itself instead of being letterboxed into a wrong box.
 */
export function videoStageAspectRatio(width, height) {
  const w = Number(width);
  const h = Number(height);
  return isPositive(w) && isPositive(h) ? w / h : null;
}

/**
 * Build an <img> src from a runner's `currentImage` frame.
 *
 * That key is polymorphic across runners: imageGen/local.js emits a raw base64
 * PNG body, loraTraining emits an already-served URL. Both ride the same field,
 * so classify before prefixing — assuming base64 would corrupt the URL form.
 * Returns `null` for absent/empty, which callers must treat as "no live frame"
 * rather than as an empty image.
 */
export function videoPreviewFrameSrc(currentImage) {
  const raw = nonEmpty(currentImage);
  if (!raw) return null;
  return /^(data:|https?:|\/)/.test(raw) ? raw : `data:image/png;base64,${raw}`;
}

const videoSrc = (filename) => {
  const name = nonEmpty(filename);
  return name ? `/data/videos/${name}` : null;
};
const thumbnailSrc = (thumbnail) => {
  const name = nonEmpty(thumbnail);
  return name ? `/data/video-thumbnails/${name}` : null;
};
const imageSrc = (uploadUrl, galleryFile) =>
  nonEmpty(uploadUrl) || (nonEmpty(galleryFile) ? `/data/images/${galleryFile}` : null);

const liveCandidate = (currentImage) => {
  const src = videoPreviewFrameSrc(currentImage);
  return src ? { kind: VIDEO_STAGE_KIND.LIVE, src, poster: null, label: 'Live frame' } : null;
};

const resultCandidate = (result) => {
  // `path` is what the completion payload carries; `filename` is the shape the
  // history records use. Accept either so the stage works whether the page
  // hands it the SSE result or a gallery record.
  const src = nonEmpty(result?.path) || videoSrc(result?.filename);
  return src
    ? { kind: VIDEO_STAGE_KIND.RESULT, src, poster: thumbnailSrc(result?.thumbnail), label: 'Latest render' }
    : null;
};

const loopCandidate = (extendSource) => {
  const src = videoSrc(extendSource?.filename);
  return src
    ? {
      kind: VIDEO_STAGE_KIND.LOOP,
      src,
      poster: thumbnailSrc(extendSource?.thumbnail),
      label: 'Continuing from this clip',
    }
    : null;
};

const stillCandidate = ({ sourceImageFile, sourceUploadUrl, lastImageFile, lastUploadUrl, keyframes }) => {
  const firstKeyframe = Array.isArray(keyframes)
    ? keyframes.filter((kf) => nonEmpty(kf?.file)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0]
    : null;
  const options = [
    [imageSrc(sourceUploadUrl, sourceImageFile), 'Start frame'],
    [imageSrc(null, firstKeyframe?.file), 'First keyframe'],
    [imageSrc(lastUploadUrl, lastImageFile), 'End frame'],
  ];
  const hit = options.find(([src]) => !!src);
  return hit ? { kind: VIDEO_STAGE_KIND.STILL, src: hit[0], poster: null, label: hit[1] } : null;
};

/**
 * Resolve the stage descriptor: `{ kind, src, poster, label, aspectRatio }`.
 *
 * Precedence differs by phase on purpose. Mid-render the forming clip is the
 * subject, so a live frame wins and the finished clip from the PREVIOUS render
 * is only a last resort; idle, the finished clip is the subject and the
 * conditioning stills are the fallback.
 */
export function resolveVideoStagePreview({
  generating = false,
  currentImage = null,
  width = null,
  height = null,
  result = null,
  extendSource = null,
  sourceImageFile = null,
  sourceUploadUrl = null,
  lastImageFile = null,
  lastUploadUrl = null,
  keyframes = null,
} = {}) {
  const aspectRatio = videoStageAspectRatio(width, height);
  const live = liveCandidate(currentImage);
  const finished = resultCandidate(result);
  const loop = loopCandidate(extendSource);
  const still = stillCandidate({ sourceImageFile, sourceUploadUrl, lastImageFile, lastUploadUrl, keyframes });
  const ordered = generating ? [live, loop, still, finished] : [live, finished, loop, still];
  const picked = ordered.find(Boolean)
    || { kind: VIDEO_STAGE_KIND.EMPTY, src: null, poster: null, label: 'Your render will appear here' };
  return { ...picked, aspectRatio };
}

/**
 * Stable identity for a descriptor, so the stage can tell "the same thing, new
 * object" from "a genuinely different thing" without deep-comparing. Used by
 * the hold/return guard — a re-render that produced an identical descriptor
 * must not count as a pending swap.
 */
export function videoStageSignature(descriptor) {
  return `${descriptor?.kind || VIDEO_STAGE_KIND.EMPTY}|${descriptor?.src || ''}|${descriptor?.aspectRatio ?? ''}`;
}
