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
 *   youtubeThumbnailTests: [same shape…] (at most 3)
 *
 * The test set is the variants kept for YouTube's Test & Compare, which runs
 * up to three thumbnails on a published video. Adding one keeps the made
 * thumbnail as it is now; making the next one leaves it in place.
 */
import { randomUUID } from 'crypto';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { composeYoutubeThumbnail } from './coverArtCompose.js';
import { listCoverFonts, registerCoverFonts } from './coverFonts.js';
import { projectCoverArt, sourcePath } from './coverArt.js';
import { musicVideoEvents } from './events.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { projectPublishKit, releaseKitFiles } from './publishKit.js';

export const MAX_THUMBNAIL_TESTS = 3;

const thumbError = (status, code, message) => new ServerError(message, { status, code });

export const projectYoutubeThumbnail = (project) => {
  const thumb = projectPublishKit(project).youtubeThumbnail;
  return thumb && typeof thumb === 'object' ? thumb : {};
};

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
  const path = sourcePath(project, from);
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
    return { project: { ...current, publishKit: { ...kit, youtubeThumbnail: { ...next, filename, composedAt: new Date().toISOString() } } } };
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
    const { youtubeThumbnail, ...kit } = projectPublishKit(current); // eslint-disable-line no-unused-vars
    return { project: { ...current, publishKit: kit } };
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
    return { project: { ...current, publishKit: { ...kit, youtubeThumbnailTests: [...tests, { ...thumb }] } } };
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
