/**
 * Music Video frame aspect (shared by the server and the client board).
 *
 * A project's aspect is its treatment brief's `aspectRatio`, defaulting to
 * 16:9. Every generated reference frame is requested at that aspect: an image
 * backend left to choose on its own picks per prompt (a close-up of hands
 * came back portrait), and the render then pillarboxes that shot.
 */
export const MUSIC_VIDEO_ASPECTS = Object.freeze(['16:9', '9:16', '1:1']);

/**
 * Where lyrics and titles sit on a portrait frame (brief `lyricLayout`): `social`, the default, keeps
 * the type clear of the Shorts/Reels/TikTok control bands; `cinematic` is a vertical film, not a phone post.
 */
export function musicVideoLyricLayout(project) {
  return project?.treatment?.brief?.lyricLayout === 'cinematic' ? 'cinematic' : 'social';
}

/** The project's aspect ratio (brief), defaulting to 16:9. */
export function musicVideoAspect(project) {
  const aspect = project?.treatment?.brief?.aspectRatio;
  return MUSIC_VIDEO_ASPECTS.includes(aspect) ? aspect : '16:9';
}

// Reference-frame sizes for image backends: long edge 1536, both sides
// multiples of 32, so local diffusion models and cloud hints accept them.
export const MUSIC_VIDEO_FRAME_GEN_SIZES = Object.freeze({
  '16:9': Object.freeze({ width: 1536, height: 864 }),
  '9:16': Object.freeze({ width: 864, height: 1536 }),
  '1:1': Object.freeze({ width: 1024, height: 1024 }),
});

/**
 * The project framed at another aspect for ONE render (a 9:16 social cut of a
 * 16:9 video), leaving the stored record untouched. Every renderer reads the
 * aspect through `musicVideoAspect`, so re-framing the brief is enough.
 */
export function musicVideoAtAspect(project, aspect) {
  if (!MUSIC_VIDEO_ASPECTS.includes(aspect) || aspect === musicVideoAspect(project)) return project;
  const treatment = project?.treatment || {};
  return { ...project, treatment: { ...treatment, brief: { ...(treatment.brief || {}), aspectRatio: aspect } } };
}

/** `{ width, height }` to request a project's reference frames at. */
export const musicVideoFrameGenSize = (project, model = null) => {
  const size = MUSIC_VIDEO_FRAME_GEN_SIZES[musicVideoAspect(project)];
  // FLUX.3 accepts dimensions up to 1024, on a 16-pixel grid.
  if (model?.runner === 'flux3' && Math.max(size.width, size.height) > 1024) {
    return { width: size.width * 2 / 3, height: size.height * 2 / 3 };
  }
  return { ...size };
};

/** Width over height for each aspect. */
const ASPECT_RATIO_VALUES = Object.freeze({ '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 });

// A frame within this of the aspect counts as matching it: an H3 1344x768
// canvas (1.75) is its 16:9, and ffmpeg's fit loses under a percent of it.
const ASPECT_TOLERANCE = 0.02;

/** Whether `width` x `height` is the aspect's shape (within a couple of percent). */
export function matchesMusicVideoAspect(width, height, aspect) {
  const target = ASPECT_RATIO_VALUES[aspect];
  const w = Number(width);
  const h = Number(height);
  if (!target || !(w > 0) || !(h > 0)) return false;
  return Math.abs(w / h / target - 1) <= ASPECT_TOLERANCE;
}

// Local clip sizes on the shared 64px render grid, exactly the aspect. A model
// left to its own default renders 768x512 (3:2), which the conditioning crop
// and the final render then have to cut or pad to a 16:9 video.
const LOCAL_CLIP_SIZES = Object.freeze({
  '16:9': Object.freeze({ width: 1024, height: 576 }),
  '9:16': Object.freeze({ width: 576, height: 1024 }),
  '1:1': Object.freeze({ width: 768, height: 768 }),
});
// First+last frame renders spend their pixel budget per frame (renderArgs
// FFLF clamp), so an end-frame clip stays near the 768x512 area it was sized
// for: within 2% of the aspect, and the clip keeps its length.
const LOCAL_END_FRAME_CLIP_SIZES = Object.freeze({
  '16:9': Object.freeze({ width: 896, height: 512 }),
  '9:16': Object.freeze({ width: 512, height: 896 }),
  '1:1': Object.freeze({ width: 640, height: 640 }),
});

/**
 * `{ width, height }` for a local Music Video clip on `model`: the model's own
 * preset in the project's aspect when it has one (MiniMax H3's native canvas),
 * else its default when that already matches, else the aspect on the 64px grid.
 */
export function musicVideoLocalClipSize(project, model = null, { endFrame = false } = {}) {
  const aspect = musicVideoAspect(project);
  if (!endFrame) {
    const preset = (Array.isArray(model?.resolutionOptions) ? model.resolutionOptions : [])
      .find((option) => matchesMusicVideoAspect(option?.w, option?.h, aspect));
    if (preset) return { width: preset.w, height: preset.h };
    if (matchesMusicVideoAspect(model?.defaultWidth, model?.defaultHeight, aspect)) {
      return { width: model.defaultWidth, height: model.defaultHeight };
    }
  }
  return { ...(endFrame ? LOCAL_END_FRAME_CLIP_SIZES : LOCAL_CLIP_SIZES)[aspect] };
}

/**
 * The final render's frame: the lead clip's size when it is already the
 * project's aspect, else that aspect at the lead clip's height (its width for
 * a portrait video), on even pixels, so a 3:2 lead clip no longer makes the
 * whole video 3:2.
 */
export function musicVideoRenderCanvas(aspect, lead) {
  const ratio = ASPECT_RATIO_VALUES[aspect];
  if (!ratio || matchesMusicVideoAspect(lead.width, lead.height, aspect)) return { width: lead.width, height: lead.height };
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return ratio >= 1
    ? { width: even(lead.height * ratio), height: even(lead.height) }
    : { width: even(lead.width), height: even(lead.width / ratio) };
}
