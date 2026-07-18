/**
 * Pick the representative produced asset for a Creative Director project (#2702)
 * so the list cards and the Overview tab can show *what the director made*
 * rather than a wall of text.
 *
 * Pure + side-effect-free: everything it needs is already on the project payload
 * returned by `GET /api/creative-director` (the list route does not slim), so a
 * card renders a preview with no extra fetch.
 *
 * Selection priority (first match wins):
 *   1. `finalVideoId`                      — the stitched final cut, or a directive
 *                                            plan's promoted last render.
 *   2. last `treatment.scenes[]` render    — a mid-production scene (last-wins, so a
 *                                            part-rendered treatment shows its latest).
 *   3. last done video-render plan step    — a directive plan's video BEFORE the
 *                                            advance loop promotes it to finalVideoId
 *                                            on completion (mid-flight commissions).
 *   4. last done image-render plan step    — a plan that emits images (e.g. a comic)
 *                                            rather than video.
 *   5. `musicBed`                          — a `music` commission's produced audio
 *                                            (or a first-pass bed), filed onto the
 *                                            project by the durable music-bed hook.
 *   6. `startingImageFile`                 — no render yet, but the project has a
 *                                            reference image. Labeled distinctly so
 *                                            the UI never passes an INPUT off as output.
 *   7. `{ kind: 'none' }`                  — nothing to show.
 *
 * NOTE ON CAST PORTRAITS: #2702 also floated "first cast portrait" as a fallback.
 * A project's `cast[]` member is `{ ingredientId, name, type, role, summary }` —
 * it carries no image ref (portraits live on the catalog ingredient, attached via
 * `catalogAttach`). Resolving one would need a per-card catalog fetch, which the
 * issue puts out of scope ("compute previews from the already-returned project
 * payload"), so that branch is intentionally absent.
 */

// A media history entry's id IS its jobId, and both workers name their output
// after it — `data/videos/<jobId>.mp4` (videoGen/local.js) and
// `data/images/<jobId>.png` (imageGen/local.js). These builders are the ONE
// definition of that convention on the client; ScenePreview imports them too.
export const videoSrcForJob = (jobId) => `/data/videos/${jobId}.mp4`;
export const videoPosterForJob = (jobId) => `/data/video-thumbnails/${jobId}.jpg`;
export const imageSrcForJob = (jobId) => `/data/images/${jobId}.png`;

// A project's music bed (a `music` commission's produced audio, or a first-pass
// bed) is stored as `project.musicBed.filename` and served from `/data/music/`
// (PATHS.music, mounted in server/index.js). generateMusic names the file
// `music-gen-<uuid>.wav`; the hook stores just that basename, so encode it and
// prefix the mount.
export const musicBedSrc = (musicBed) => {
  const filename = nonEmptyString(musicBed?.filename);
  return filename ? `/data/music/${encodeURIComponent(filename)}` : null;
};

// The registry tools a plan step uses to render media. Mirrors
// `VIDEO_RENDER_TOOL_NAME` in server/services/creativeDirector/planAdvance.js;
// both settle with a `{ jobId }` result digest.
const VIDEO_RENDER_TOOL = 'media_enqueueVideoJob';
const IMAGE_RENDER_TOOL = 'media_enqueueImageJob';

// Tailwind needs to SEE each class as a literal to emit it — a computed
// `aspect-[${w}/${h}]` silently never lands in the build. Hence a static map.
const ASPECT_CLASSES = Object.freeze({
  '16:9': 'aspect-video',
  '9:16': 'aspect-[9/16]',
  '1:1': 'aspect-square',
});

// Height cap for an inline hero preview, expressed as a MAX-WIDTH per ratio.
// Capping height directly does not work: a block box is fill-available wide, so
// `max-h` clamps the box while the aspect-ratio'd player inside still derives
// its height from the UNCLAMPED width and overflows (a 9:16 preview in a 736px
// column wants 1308px tall — `overflow-hidden` then crops half the video away).
// Constraining width instead lets aspect-ratio derive a height that already
// fits, and makes `mx-auto` actually center. Literals, per the note above.
const MAX_WIDTH_CLASSES = Object.freeze({
  '16:9': 'max-w-[calc(60vh*16/9)]',
  '9:16': 'max-w-[calc(60vh*9/16)]',
  '1:1': 'max-w-[60vh]',
});

/**
 * Tailwind aspect class for a project's locked aspect ratio, falling back to
 * `aspect-video` for an unset/legacy/hand-edited value.
 */
export function previewAspectClass(aspectRatio) {
  return ASPECT_CLASSES[aspectRatio] || 'aspect-video';
}

/**
 * Max-width class that keeps an inline preview of `aspectRatio` within ~60vh
 * tall without distorting or cropping it. Pair with `previewAspectClass` +
 * `w-full mx-auto`; do NOT also apply a `max-h` (see the note above).
 */
export function previewMaxWidthClass(aspectRatio) {
  return MAX_WIDTH_CLASSES[aspectRatio] || MAX_WIDTH_CLASSES['16:9'];
}

const nonEmptyString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The jobId of the last `done` step for `toolName` (or null). Last-wins so a
 * multi-render plan resolves to its most recent output — mirrors
 * `lastRenderedVideoJobId` in planAdvance.js.
 */
function lastDoneStepJobId(plan, toolName) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step?.toolName === toolName && step.status === 'done') {
      const jobId = nonEmptyString(step.result?.jobId);
      if (jobId) return jobId;
    }
  }
  return null;
}

/**
 * The last treatment scene carrying a render (or null) as `{ jobId, label }`.
 * Scene numbering follows `order` (SegmentsTab renders `order + 1`), falling
 * back to the array index for a scene missing it.
 */
function lastRenderedScene(project) {
  const scenes = Array.isArray(project?.treatment?.scenes) ? project.treatment.scenes : [];
  for (let i = scenes.length - 1; i >= 0; i -= 1) {
    const jobId = nonEmptyString(scenes[i]?.renderedJobId);
    if (jobId) {
      const order = Number.isInteger(scenes[i]?.order) ? scenes[i].order : i;
      return { jobId, label: `Scene ${order + 1}` };
    }
  }
  return null;
}

/**
 * Resolve a project's `startingImageFile` to a servable `/data/images/` src, or
 * null when it isn't a local gallery image. Client mirror of
 * `localImageFilename` (server/lib/localImageFilename.js): remote/inline schemes
 * and non-gallery absolute paths are rejected rather than rendered, and the
 * value is reduced to its basename so a traversal-ish value can't escape the
 * mount.
 */
export function startingImageSrc(startingImageFile) {
  const raw = nonEmptyString(startingImageFile);
  if (!raw) return null;
  if (/^(https?:|data:|blob:)/i.test(raw)) return null;
  const IMAGES_PREFIX = '/data/images/';
  let name;
  if (raw.startsWith(IMAGES_PREFIX)) name = raw.slice(IMAGES_PREFIX.length);
  else if (raw.startsWith('/')) return null; // some other absolute path → not a gallery image
  else name = raw;
  // Strip the query/hash BEFORE taking the basename — exactly as the server's
  // `assetBasename` does. Reversing the order resolves the wrong asset when a
  // suffix itself contains a slash (`photo.png?source=/other.png` → `other.png`).
  const base = nonEmptyString(name.split(/[?#]/)[0].split('/').pop());
  if (!base || base === '.' || base === '..') return null;
  return `${IMAGES_PREFIX}${base}`;
}

/**
 * Normalized preview descriptor for a project:
 *   `{ kind: 'video', jobId, src, poster, label }`
 *   `{ kind: 'image', src, jobId?, label }`
 *   `{ kind: 'none', label }`
 */
export function selectProjectPreview(project) {
  const none = { kind: 'none', label: 'No render yet' };
  if (!project || typeof project !== 'object') return none;

  const video = (jobId, label) => ({
    kind: 'video',
    jobId,
    src: videoSrcForJob(jobId),
    poster: videoPosterForJob(jobId),
    label,
  });

  const finalVideoId = nonEmptyString(project.finalVideoId);
  if (finalVideoId) return video(finalVideoId, 'Final video');

  const scene = lastRenderedScene(project);
  if (scene) return video(scene.jobId, scene.label);

  // A directive plan's video before completion promotes it to finalVideoId.
  const planVideoId = lastDoneStepJobId(project.plan, VIDEO_RENDER_TOOL);
  if (planVideoId) return video(planVideoId, 'Latest render');

  const planImageId = lastDoneStepJobId(project.plan, IMAGE_RENDER_TOOL);
  if (planImageId) {
    return { kind: 'image', jobId: planImageId, src: imageSrcForJob(planImageId), label: 'Produced image' };
  }

  // A `music` commission produces no video/image — its output is the rendered
  // music bed filed onto `project.musicBed` by the durable music-bed hook
  // (#2772). Surface it as a playable audio result so the run is rateable.
  const audio = musicBedSrc(project.musicBed);
  if (audio) {
    const durationSec = Number.isFinite(project.musicBed?.durationSec) ? project.musicBed.durationSec : null;
    return { kind: 'audio', src: audio, label: 'Music bed', durationSec };
  }

  // Last resort: the project's own reference image. Distinct label — this is an
  // INPUT the user supplied, not something the director produced.
  const starting = startingImageSrc(project.startingImageFile);
  if (starting) return { kind: 'image', src: starting, label: 'Starting image' };

  return none;
}
