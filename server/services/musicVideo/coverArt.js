/**
 * Music Video — cover art for the song's release (Spotify via DistroKid, Suno).
 *
 * `project.publishKit.coverArt` holds one composed square cover: a source
 * image (a kit thumbnail or any gallery image, Cast & Sets renders included)
 * cropped square with the title set on a split-flap row by code
 * (coverArtCompose.js). The director can also ask an image backend (Codex
 * first) for a fresh source; that job is tagged `musicVideo: { projectId,
 * coverArt: { requestId } }` and musicVideoCoverArtImageHook.js composes the
 * cover from it when it lands. Nothing here runs without a director action
 * (AI Provider Usage Policy).
 *
 *   coverArt: { filename, source: { kind, filename }, title, tag, focusX,
 *               composedAt, generated: [galleryFilename…],
 *               pending: { requestId, jobId, mode, requestedAt } | null,
 *               lastError: string | null }
 */
import { randomUUID } from 'crypto';
import { basename } from 'path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { trimTo } from '../../lib/textUtils.js';
import { composeCoverArt } from './coverArtCompose.js';
import { musicVideoEvents } from './events.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { projectPublishKit, releaseKitFiles } from './publishKit.js';

const MAX_GENERATED = 12;
// Codex renders square at 1024; the compose scales it to the store size.
const SOURCE_PX = 1024;

const defaults = {
  compose: composeCoverArt,
  getSettings: async () => (await import('../settings.js')).getSettings(),
  getPlatforms: async () => (await import('./publish/platforms.js')).getPublishPlatforms(),
  enqueue: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  chooseRoute: async (project, opts) => (await import('./castAndSetsService.js')).chooseCastAndSetsRoute(project, opts),
  imageParams: async (settings, route, common) => (await import('./castAndSetsService.js')).imageJobParams(settings, route, common),
  withStyle: async (...args) => (await import('./styleReferences.js')).withMusicVideoStyle(...args),
};
let deps = { ...defaults };
export function __setCoverArtDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }

const coverError = (status, code, message) => new ServerError(message, { status, code });
export const projectCoverArt = (project) => {
  const art = projectPublishKit(project).coverArt;
  return art && typeof art === 'object' ? art : {};
};

async function requireProject(projectId) {
  const project = await getProject(projectId);
  if (!project) throw coverError(404, 'NOT_FOUND', 'Project not found');
  return project;
}

function publish(projectId, project) {
  musicVideoEvents.emit('cover-art', { projectId, project });
}

const writeCoverArt = (projectId, update) => mutateProjectRecord(projectId, (current) => {
  const kit = projectPublishKit(current);
  const art = projectCoverArt(current);
  return { project: { ...current, publishKit: { ...kit, coverArt: { ...art, ...update(art) } } } };
});

/** A source's file on disk: a thumbnail this kit cut, or a gallery image. */
function sourcePath(project, source) {
  const name = basename(String(source?.filename || ''));
  if (source?.kind === 'thumbnail') {
    if (!(projectPublishKit(project).thumbnails || []).includes(name)) throw coverError(422, 'VALIDATION_ERROR', 'That thumbnail is not one this kit built');
    const path = safeUnder(PATHS.videoThumbnails, name);
    if (path) return path;
  } else if (source?.kind === 'image') {
    const path = resolveGalleryImage(name);
    if (path) return path;
  }
  throw coverError(422, 'PUBLISH_ASSET_MISSING', `The cover source image is missing (${name || 'none'})`);
}

/** The artist tag: what the director set, else the DistroKid account under Where you post. */
async function defaultTag() {
  const platforms = await deps.getPlatforms().catch(() => null);
  return trimTo(platforms?.distrokid?.account, 24) || '';
}

/**
 * Compose the cover from `source` with the title and tag, and make it the
 * release's cover. Unset fields keep the last cover's (title defaults to the
 * project name, tag to the DistroKid artist).
 */
export async function composeProjectCoverArt(projectId, { source = null, title, tag, focusX } = {}) {
  const project = await requireProject(projectId);
  const art = projectCoverArt(project);
  const from = source || art.source;
  if (!from) throw coverError(422, 'VALIDATION_ERROR', 'Pick an image for the cover first');
  const path = sourcePath(project, from);
  const next = {
    source: { kind: from.kind, filename: basename(from.filename) },
    title: typeof title === 'string' ? title.trim() : (art.title ?? project.name ?? ''),
    tag: typeof tag === 'string' ? tag.trim() : (art.tag ?? await defaultTag()),
    focusX: Number.isFinite(focusX) ? focusX : (Number.isFinite(art.focusX) ? art.focusX : 0.5),
  };
  if (!next.title) throw coverError(422, 'VALIDATION_ERROR', 'Give the cover a title');
  await ensureDir(PATHS.videoThumbnails);
  const filename = `cover-${String(projectId).slice(3, 11)}-${randomUUID().slice(0, 8)}.jpg`;
  await deps.compose({ ...next, source: path, out: safeUnder(PATHS.videoThumbnails, filename) });
  // The JPEG is written in place; the row that first names it commits under a backup lease (#9982).
  const out = await withBackupAssetPublication(() => writeCoverArt(projectId, () => ({
    ...next, filename, composedAt: new Date().toISOString(), lastError: null,
  })));
  if (art.filename && art.filename !== filename) await releaseKitFiles([art.filename], [filename]);
  console.log(`🖼️ Music Video cover art ${String(projectId).slice(3, 11)} ← ${next.source.filename}`);
  publish(projectId, out.project);
  return { project: out.project };
}

/** The image prompt for a fresh cover source: the singer, the look, and room for the title. */
function buildCoverArtPrompt(project, { notes = '' } = {}) {
  const direction = project?.castAndSets?.direction || {};
  const p = direction.protagonist || {};
  const subject = trimTo([p.face, p.hair, p.signature].filter(Boolean).join('; '), 600);
  const look = trimTo(direction.look || project?.concept?.style, 600);
  return [
    `Square single cover photograph for the song "${trimTo(project?.name || 'Untitled', 120)}".`,
    trimTo(notes, 1500) || `A tight close-up portrait of the lead singer${subject ? `: ${subject}` : ''}.`,
    look ? `Look: ${look}.` : '',
    'Editorial flash photography: hard on-camera flash, deep shadows, rich color, sharp focus on the eyes.',
    'Keep the bottom fifth of the frame simple and dark, since a title band is set over it later.',
    'No text, letters, logos, or watermark anywhere in the image.',
  ].filter(Boolean).join(' ');
}

/**
 * Ask an image backend (Codex when enabled) for a new cover source. The
 * completion hook composes the cover from it with the current title and tag.
 * `reference` (a gallery image) keeps the singer's likeness; it defaults to
 * the Cast & Sets character sheet.
 */
export async function generateCoverArtSource(projectId, { notes = '', reference = null } = {}) {
  const project = await requireProject(projectId);
  if (projectCoverArt(project).pending) throw coverError(409, 'COVER_ART_IN_PROGRESS', 'A cover image is already being made');
  const settings = await deps.getSettings();
  const route = await deps.chooseRoute(project, { preferred: { mode: 'codex' }, settings })
    || await deps.chooseRoute(project, { settings });
  if (!route) throw coverError(409, 'COVER_ART_ROUTE_UNAVAILABLE', 'No image backend is enabled for music videos. Turn on Codex image generation and try again');
  const refName = reference?.filename || project.castAndSets?.images?.character?.imageId || null;
  const refPath = refName ? resolveGalleryImage(refName) : null;
  if (reference?.filename && !refPath) throw coverError(422, 'PUBLISH_ASSET_MISSING', `The reference image is missing (${basename(reference.filename)})`);
  const requestId = randomUUID();
  const common = {
    prompt: buildCoverArtPrompt(project, { notes }),
    width: SOURCE_PX,
    height: SOURCE_PX,
    ...(refPath ? { referenceImagePaths: [refPath], referenceImageStrengths: [1] } : {}),
    // The completion hook files the result by this tag. No `sceneId` or
    // `castAndSets`, so the scene and Cast & Sets hooks ignore the job.
    musicVideo: { projectId: project.id, coverArt: { requestId } },
  };
  const params = await deps.withStyle(project, await deps.imageParams(settings, route, common), route.mode, route.model, settings);
  const sent = await deps.enqueue({ kind: 'image', params, owner: `music-video-cover-art:${project.id}` });
  const out = await writeCoverArt(projectId, () => ({
    pending: { requestId, jobId: typeof sent?.jobId === 'string' ? sent.jobId : null, mode: route.mode, requestedAt: new Date().toISOString() },
    lastError: null,
  }));
  console.log(`🖼️ Music Video cover art ${String(projectId).slice(3, 11)}: source image queued on ${route.mode}`);
  publish(projectId, out.project);
  return { project: out.project };
}

/**
 * The completion hook's entry: file a finished source image and compose the
 * cover from it, or record why it failed. A stale request (the director asked
 * again) still keeps its image as a pickable source but changes nothing else.
 * Returns true when the record changed.
 */
export async function onCoverArtImageSettled({ projectId, requestId, filename = null, status = null, error = null }) {
  const project = await getProject(projectId);
  if (!project) return false;
  const current = projectCoverArt(project).pending?.requestId === requestId;
  if (!filename) {
    if (!current) return false;
    const out = await writeCoverArt(projectId, () => ({ pending: null, lastError: trimTo(error || `The cover image render was ${status || 'not finished'}`, 300) }));
    console.warn(`⚠️ Music Video cover art ${String(projectId).slice(3, 11)}: source image ${status || 'failed'}`);
    publish(projectId, out.project);
    return true;
  }
  const out = await writeCoverArt(projectId, (art) => ({
    generated: [filename, ...(art.generated || []).filter((f) => f !== filename)].slice(0, MAX_GENERATED),
    ...(current ? { pending: null } : {}),
  }));
  if (!current) { publish(projectId, out.project); return true; }
  await composeProjectCoverArt(projectId, { source: { kind: 'image', filename } }).catch(async (err) => {
    console.error(`❌ Music Video cover art ${String(projectId).slice(3, 11)} compose failed: ${err.message}`);
    const failed = await writeCoverArt(projectId, () => ({ lastError: trimTo(`The cover could not be composed: ${err.message}`, 300) }));
    publish(projectId, failed.project);
  });
  return true;
}
