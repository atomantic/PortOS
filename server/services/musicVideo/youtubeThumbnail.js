/**
 * Music Video — the YouTube thumbnail.
 *
 * `project.publishKit.youtubeThumbnail` holds one composed 16:9 image: a
 * source (a video frame the kit kept, or any gallery image: a shot's still,
 * a cover photo, a Cast & Sets render) cropped 16:9, with the song title set
 * over it by code in the song's cover lettering, laid out for a feed (large,
 * to one side, clear of the duration badge; lib/musicVideoCoverOverlay.js).
 * The YouTube post uploads it in place of a bare frame. No AI call: the
 * lettering is the cover's design, and a new design re-sets this too.
 *
 *   youtubeThumbnail: { filename, source: { kind, filename }, title,
 *                       focusX, focusY, lettering, composedAt }
 *                       generated: [galleryFilename…],
 *                       pending: { requestId, jobId, mode, requestedAt } | null,
 *                       lastError }
 *   youtubeThumbnailTests: [{ filename, source, title, … }] (at most 3)
 *
 * "Paint the title" asks the install's image generator to restyle a chosen
 * frame with the title drawn into it as display lettering (an image model
 * draws far livelier type than code can set). The job is tagged
 * `musicVideo: { projectId, youtubeThumbnail: { requestId } }`; its completion
 * hook (musicVideoCoverArtImageHook.js) makes the result the thumbnail, bare.
 * What PortOS adds to the director's words is one labeled addition, previewed
 * by the same builder before the send.
 *
 * The test set is the variants kept for YouTube's Test & Compare, which runs
 * up to three thumbnails on a published video. Adding one keeps the made
 * thumbnail as it is now; making the next one leaves it in place.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { basename } from 'path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { composeYoutubeThumbnail } from './coverArtCompose.js';
import { listCoverFonts, registerCoverFonts } from './coverFonts.js';
import { defaultImageRoute, projectCoverArt, sourcePath } from './coverArt.js';
import { promptAddition } from '../../lib/modelInput.js';
import { trimTo } from '../../lib/textUtils.js';
import { musicVideoEvents } from './events.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { projectPublishKit, releaseKitFiles } from './publishKit.js';

export const MAX_THUMBNAIL_TESTS = 3;
const MAX_GENERATED = 12;
const LIVE_JOB = new Set(['queued', 'running', 'canceling']);
// A reservation that never got its job id (the process died mid-enqueue) stops blocking after this.
const RESERVATION_TTL_MS = 2 * 60 * 1000;
// Asked for 16:9; the compose crops whatever size the backend returns to 1280x720.
const PAINT_SIZE = { width: 1536, height: 864 };
// The fields a thumbnail (or a test variant) is: what was made, from what.
const MADE_FIELDS = ['filename', 'source', 'title', 'focusX', 'focusY', 'lettering', 'composedAt'];
const madeOf = (thumb) => Object.fromEntries(MADE_FIELDS.filter((k) => thumb[k] !== undefined).map((k) => [k, thumb[k]]));

const defaults = {
  getSettings: async () => (await import('../settings.js')).getSettings(),
  defaultRoute: defaultImageRoute,
  imageParams: async (settings, route, common) => (await import('./castAndSetsService.js')).imageJobParams(settings, route, common),
  enqueue: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  jobStatus: async (jobId) => (await import('../mediaJobQueue/index.js')).getJob(jobId)?.status || null,
};
let deps = { ...defaults };
export function __setYoutubeThumbnailDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }

const thumbError = (status, code, message) => new ServerError(message, { status, code });

export const projectYoutubeThumbnail = (project) => {
  const thumb = projectPublishKit(project).youtubeThumbnail;
  return thumb && typeof thumb === 'object' ? thumb : {};
};

// A kit frame the made thumbnail was cut from stays usable after a rebuild drops it from the
// kit (releaseKitFiles keeps its file), so new lettering and re-crops still find it.
function thumbnailSourcePath(project, from, thumb) {
  const name = basename(String(from?.filename || ''));
  const kept = from?.kind === 'thumbnail' && thumb.source?.kind === 'thumbnail' && thumb.source.filename === name
    && !(projectPublishKit(project).thumbnails || []).includes(name) ? safeUnder(PATHS.videoThumbnails, name) : null;
  return kept && existsSync(kept) ? kept : sourcePath(project, from);
}

const unitOr = (value, fallback) => (Number.isFinite(value) ? value : (Number.isFinite(fallback) ? fallback : 0.5));

/**
 * Compose the thumbnail from `source` and make it the one the YouTube post
 * uploads. Unset fields keep the last thumbnail's (the title defaults to the
 * cover's title, else the song's name). `lettering: false` uses the image bare.
 */
export async function composeProjectYoutubeThumbnail(projectId, { source = null, title, focusX, focusY, lettering } = {}) {
  const project = await getProject(projectId);
  if (!project) throw thumbError(404, 'NOT_FOUND', 'Project not found');
  const thumb = projectYoutubeThumbnail(project);
  const art = projectCoverArt(project);
  const from = source || thumb.source;
  if (!from) throw thumbError(422, 'VALIDATION_ERROR', 'Pick an image for the thumbnail first');
  const path = thumbnailSourcePath(project, from, thumb);
  const next = {
    source: { kind: from.kind, filename: String(from.filename).split(/[\\/]/).pop() },
    title: typeof title === 'string' ? title.trim() : (thumb.title ?? art.title ?? project.name ?? ''),
    focusX: unitOr(focusX, thumb.focusX),
    focusY: unitOr(focusY, thumb.focusY),
    lettering: typeof lettering === 'boolean' ? lettering : thumb.lettering !== false,
  };
  if (next.lettering && !next.title) throw thumbError(422, 'VALIDATION_ERROR', 'Give the thumbnail a title');
  await ensureDir(PATHS.videoThumbnails);
  const fonts = await listCoverFonts();
  await registerCoverFonts(fonts);
  const filename = `youtube-thumb-${String(projectId).slice(3, 11)}-${randomUUID().slice(0, 8)}.jpg`;
  await composeYoutubeThumbnail({ ...next, design: art.design || null, fonts, source: path, out: safeUnder(PATHS.videoThumbnails, filename) });
  // The JPEG is written in place; the row that first names it commits under a backup lease (#9982).
  const out = await withBackupAssetPublication(() => mutateProjectRecord(projectId, (current) => {
    const kit = projectPublishKit(current);
    return { project: { ...current, publishKit: { ...kit, youtubeThumbnail: { ...projectYoutubeThumbnail(current), ...next, filename, composedAt: new Date().toISOString(), lastError: null } } } };
  }));
  if (thumb.filename && thumb.filename !== filename) await releaseKitFiles([thumb.filename], [filename]);
  console.log(`🖼️ Music Video YouTube thumbnail ${String(projectId).slice(3, 11)} ← ${next.source.filename}`);
  musicVideoEvents.emit('cover-art', { projectId, project: out.project });
  return { project: out.project };
}

/** Re-set a lettered thumbnail in the cover's current design. Null when there is none to re-set. */
export async function recomposeYoutubeThumbnail(projectId) {
  const project = await getProject(projectId);
  const thumb = projectYoutubeThumbnail(project);
  if (!thumb.source || thumb.lettering === false) return null;
  return (await composeProjectYoutubeThumbnail(projectId, {})).project;
}

/** Stop using the made thumbnail: the YouTube post goes back to the best video frame. */
export async function clearProjectYoutubeThumbnail(projectId) {
  const project = await getProject(projectId);
  if (!project) throw thumbError(404, 'NOT_FOUND', 'Project not found');
  const old = projectYoutubeThumbnail(project).filename;
  const out = await mutateProjectRecord(projectId, (current) => {
    const { youtubeThumbnail, ...kit } = projectPublishKit(current);
    // Painted images stay pickable; only the made thumbnail goes.
    const generated = Array.isArray(youtubeThumbnail?.generated) ? youtubeThumbnail.generated : [];
    return { project: { ...current, publishKit: generated.length ? { ...kit, youtubeThumbnail: { generated } } : kit } };
  });
  if (old) await releaseKitFiles([old]);
  musicVideoEvents.emit('cover-art', { projectId, project: out.project });
  return { project: out.project };
}

const testsOf = (project) => {
  const list = projectPublishKit(project).youtubeThumbnailTests;
  return Array.isArray(list) ? list.filter((t) => t?.filename) : [];
};

/** Keep the made thumbnail, as it is now, as one of the Test & Compare variants. */
export async function addYoutubeThumbnailTest(projectId) {
  const project = await getProject(projectId);
  if (!project) throw thumbError(404, 'NOT_FOUND', 'Project not found');
  const out = await mutateProjectRecord(projectId, (current) => {
    const kit = projectPublishKit(current);
    const thumb = projectYoutubeThumbnail(current);
    if (!thumb.filename) throw thumbError(422, 'VALIDATION_ERROR', 'Make a thumbnail first');
    const tests = testsOf(current);
    if (tests.some((t) => t.filename === thumb.filename)) return { project: current };
    if (tests.length >= MAX_THUMBNAIL_TESTS) throw thumbError(422, 'VALIDATION_ERROR', `YouTube tests up to ${MAX_THUMBNAIL_TESTS} thumbnails. Remove one first`);
    return { project: { ...current, publishKit: { ...kit, youtubeThumbnailTests: [...tests, madeOf(thumb)] } } };
  });
  musicVideoEvents.emit('cover-art', { projectId, project: out.project });
  return { project: out.project };
}

/** Drop a variant from the test set (its file goes once nothing names it). */
export async function removeYoutubeThumbnailTest(projectId, filename) {
  const project = await getProject(projectId);
  if (!project) throw thumbError(404, 'NOT_FOUND', 'Project not found');
  let held = false;
  const out = await mutateProjectRecord(projectId, (current) => {
    const kit = projectPublishKit(current);
    const tests = testsOf(current);
    held = tests.some((t) => t.filename === filename);
    return { project: { ...current, publishKit: { ...kit, youtubeThumbnailTests: tests.filter((t) => t.filename !== filename) } } };
  });
  // Only a file this set held: the name comes from the request, and the folder holds other renders' images too.
  if (held) await releaseKitFiles([filename]);
  musicVideoEvents.emit('cover-art', { projectId, project: out.project });
  return { project: out.project };
}

/**
 * What "Paint the title" sends the image model: PortOS's thumbnail brief (one
 * labeled addition), then the director's own words as written. The preview
 * and the queued job both come from here, so the chips match the send.
 */
export function buildThumbnailPaintPrompt({ title, notes = '' }) {
  const brief = [
    'Turn the attached frame into a YouTube thumbnail, 16:9.',
    'Keep its people, faces, wardrobe, set, light and film look exactly as they are.',
    `Paint the title "${trimTo(title, 60)}" into the picture as big, bold display lettering with real character (painted, chrome, neon or film-title type that belongs to this world), readable at a glance on a phone.`,
    'Spell it exactly. Put it on one side, never over a face, and keep the bottom-right corner clear.',
    'No other text, no logos.',
  ].join(' ');
  const direction = trimTo(String(notes || '').trim(), 1500);
  return {
    prompt: [brief, direction].filter(Boolean).join('\n\n'),
    promptAdditions: [promptAddition('youtube-thumbnail-brief', 'YouTube thumbnail brief', brief)],
  };
}

async function pendingIsLive(pending) {
  if (!pending) return false;
  if (pending.jobId) return LIVE_JOB.has(await deps.jobStatus(pending.jobId).catch(() => null));
  return Date.now() - Date.parse(pending.requestedAt || 0) < RESERVATION_TTL_MS;
}

const writeThumb = (projectId, update) => mutateProjectRecord(projectId, (current) => {
  const kit = projectPublishKit(current);
  const thumb = projectYoutubeThumbnail(current);
  return { project: { ...current, publishKit: { ...kit, youtubeThumbnail: { ...thumb, ...update(thumb) } } } };
});

/**
 * Ask the install's image generator to paint `title` into `source` (a kit
 * frame or a gallery image). The completion hook makes the result the
 * thumbnail when it lands.
 */
export async function paintYoutubeThumbnail(projectId, { source, title, notes = '' } = {}) {
  const project = await getProject(projectId);
  if (!project) throw thumbError(404, 'NOT_FOUND', 'Project not found');
  const previous = projectYoutubeThumbnail(project).pending;
  if (await pendingIsLive(previous)) throw thumbError(409, 'THUMBNAIL_IN_PROGRESS', 'A thumbnail is already being painted');
  const name = String(title || '').trim();
  if (!name) throw thumbError(422, 'VALIDATION_ERROR', 'Give the thumbnail a title');
  const path = thumbnailSourcePath(project, source, projectYoutubeThumbnail(project));
  const settings = await deps.getSettings();
  const route = await deps.defaultRoute(settings);
  if (!route) throw thumbError(409, 'THUMBNAIL_ROUTE_UNAVAILABLE', 'Image generation is not set up. Choose an image generator in Settings and try again');
  const requestId = randomUUID();
  await writeThumb(projectId, (thumb) => {
    if ((thumb.pending?.requestId || null) !== (previous?.requestId || null)) throw thumbError(409, 'THUMBNAIL_IN_PROGRESS', 'A thumbnail is already being painted');
    return { pending: { requestId, jobId: null, mode: route.mode, requestedAt: new Date().toISOString() }, title: name, lastError: null };
  });
  const common = {
    ...buildThumbnailPaintPrompt({ title: name, notes }),
    ...PAINT_SIZE,
    referenceImagePaths: [path],
    referenceImageStrengths: [1],
    // The completion hook files the result by this tag; no `sceneId`, `castAndSets` or `coverArt`, so other hooks ignore it.
    musicVideo: { projectId: project.id, youtubeThumbnail: { requestId } },
  };
  const sent = await deps.imageParams(settings, route, common)
    .then((params) => deps.enqueue({ kind: 'image', params, owner: `music-video-youtube-thumbnail:${project.id}` }))
    .catch(async (err) => {
      const failed = await writeThumb(projectId, (thumb) => (thumb.pending?.requestId === requestId
        ? { pending: null, lastError: trimTo(`The thumbnail could not be queued: ${err.message}`, 300) } : {}));
      musicVideoEvents.emit('cover-art', { projectId, project: failed.project });
      throw err;
    });
  const jobId = typeof sent?.jobId === 'string' ? sent.jobId : null;
  const out = await writeThumb(projectId, (thumb) => (thumb.pending?.requestId === requestId && jobId ? { pending: { ...thumb.pending, jobId } } : {}));
  console.log(`🖼️ Music Video YouTube thumbnail ${String(projectId).slice(3, 11)}: painting queued on ${route.mode}`);
  musicVideoEvents.emit('cover-art', { projectId, project: out.project });
  return { project: out.project };
}

/**
 * The completion hook's entry: keep a painted image as a pickable source and,
 * for the current request, make it the thumbnail (bare: its title is painted
 * in). A failure records why. Returns true when the record changed.
 */
export async function onThumbnailImageSettled({ projectId, requestId, filename = null, status = null, error = null }) {
  const project = await getProject(projectId);
  if (!project) return false;
  const current = projectYoutubeThumbnail(project).pending?.requestId === requestId;
  if (!filename) {
    if (!current) return false;
    const out = await writeThumb(projectId, () => ({ pending: null, lastError: trimTo(error || `The thumbnail render was ${status || 'not finished'}`, 300) }));
    console.warn(`⚠️ Music Video YouTube thumbnail ${String(projectId).slice(3, 11)}: painting ${status || 'failed'}`);
    musicVideoEvents.emit('cover-art', { projectId, project: out.project });
    return true;
  }
  const name = basename(filename);
  const out = await writeThumb(projectId, (thumb) => ({
    generated: [name, ...(thumb.generated || []).filter((f) => f !== name)].slice(0, MAX_GENERATED),
    ...(current ? { pending: null } : {}),
  }));
  if (!current) { musicVideoEvents.emit('cover-art', { projectId, project: out.project }); return true; }
  await composeProjectYoutubeThumbnail(projectId, { source: { kind: 'image', filename: name }, lettering: false, focusX: 0.5, focusY: 0.5 }).catch(async (err) => {
    console.error(`❌ Music Video YouTube thumbnail ${String(projectId).slice(3, 11)} compose failed: ${err.message}`);
    const failed = await writeThumb(projectId, () => ({ lastError: trimTo(`The thumbnail could not be made: ${err.message}`, 300) }));
    musicVideoEvents.emit('cover-art', { projectId, project: failed.project });
  });
  return true;
}
