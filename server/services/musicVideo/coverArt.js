/**
 * Music Video — cover art for the song's release (Spotify via DistroKid, Suno).
 *
 * `project.publishKit.coverArt` holds one composed square cover: a source
 * image (a kit thumbnail or any gallery image, Cast & Sets renders included)
 * cropped square with the title and artist set over it by code, in the song's
 * own design (coverArtCompose.js). The design is drafted per song by one
 * provider call from the song and the director's direction, and redrafted
 * from their adjustments (coverArtDesign.js). The install's default image generator
 * makes the cover photo from the design's image prompt; that job is tagged
 * `musicVideo: { projectId, coverArt: { requestId } }` and
 * musicVideoCoverArtImageHook.js composes the cover from it when it lands.
 * Nothing here runs without a director action (AI Provider Usage Policy).
 *
 *   coverArt: { filename, source: { kind, filename }, title, tag, focusX,
 *               lettering (false = a finished cover, used bare),
 *               design, imagePrompt, rationale, direction, designedAt,
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
import { composeCoverArt, normalizeCoverDesign } from './coverArtCompose.js';
import { listCoverFonts, registerCoverFonts } from './coverFonts.js';
import { buildCoverDesignPrompt, parseCoverDesign } from './coverArtDesign.js';
import { musicVideoEvents } from './events.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { projectPublishKit, releaseKitFiles } from './publishKit.js';

const MAX_GENERATED = 12;
const LIVE_JOB = new Set(['queued', 'running', 'canceling']);
// A reservation that never got its job id (the process died mid-enqueue) stops blocking after this.
const RESERVATION_TTL_MS = 2 * 60 * 1000;
// Cover photos render square at 1024; the compose scales them to the store size.
const SOURCE_PX = 1024;

const defaults = {
  compose: composeCoverArt,
  getSettings: async () => (await import('../settings.js')).getSettings(),
  getPlatforms: async () => (await import('./publish/platforms.js')).getPublishPlatforms(),
  enqueue: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  defaultRoute: async (settings) => defaultImageRoute(settings),
  imageParams: async (settings, route, common) => (await import('./castAndSetsService.js')).imageJobParams(settings, route, common),
  withStyle: async (...args) => (await import('./styleReferences.js')).withMusicVideoStyle(...args),
  jobStatus: async (jobId) => (await import('../mediaJobQueue/index.js')).getJob(jobId)?.status || null,
  runner: async () => import('../promptRunner.js'),
  fonts: listCoverFonts,
  registerFonts: registerCoverFonts,
  artistStyle: async (name) => (await import('./publish/artistStyles.js')).artistStyleFor(name),
};
let deps = { ...defaults };
export function __setCoverArtDepsForTests(overrides) { deps = { ...defaults, ...overrides }; }

/**
 * The install's own image generator for music videos: the Music Video render
 * default, else the PortOS image default (local, Codex, Grok, …). Null when
 * that backend cannot take a queued job or its cloud toggle is off.
 */
async function defaultImageRoute(settings) {
  const [{ resolveRenderTargetConfig }, { QUEUEABLE_IMAGE_MODES }, { RENDER_TARGET }] = await Promise.all([
    import('../imageGen/cloudProviderConfig.js'), import('../../lib/generationModes.js'), import('../../lib/renderTargets.js'),
  ]);
  const resolved = resolveRenderTargetConfig(settings, RENDER_TARGET.MUSIC_VIDEO, { usableInstallFallback: true });
  if (!QUEUEABLE_IMAGE_MODES.includes(resolved.mode) || (resolved.cloud && !resolved.cloud.enabled)) return null;
  return { mode: resolved.mode, model: null };
}

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
 * project name, tag to the DistroKid artist). `lettering: false` uses the
 * image as a finished cover: squared and sized, with nothing set on it.
 */
export async function composeProjectCoverArt(projectId, { source = null, title, tag, focusX, lettering } = {}) {
  const project = await requireProject(projectId);
  const art = projectCoverArt(project);
  const from = source || art.source;
  if (!from) throw coverError(422, 'VALIDATION_ERROR', 'Pick an image for the cover first');
  const path = sourcePath(project, from);
  const next = {
    source: { kind: from.kind, filename: basename(from.filename) },
    title: typeof title === 'string' ? title.trim() : (art.title || project.name || ''),
    tag: typeof tag === 'string' ? tag.trim() : (art.tag ?? await defaultTag()),
    focusX: Number.isFinite(focusX) ? focusX : (Number.isFinite(art.focusX) ? art.focusX : 0.5),
    lettering: typeof lettering === 'boolean' ? lettering : art.lettering !== false,
  };
  if (next.lettering && !next.title) throw coverError(422, 'VALIDATION_ERROR', 'Give the cover a title');
  await ensureDir(PATHS.videoThumbnails);
  const fonts = await deps.fonts();
  await deps.registerFonts(fonts);
  const filename = `cover-${String(projectId).slice(3, 11)}-${randomUUID().slice(0, 8)}.jpg`;
  await deps.compose({ ...next, design: art.design || null, fonts, source: path, out: safeUnder(PATHS.videoThumbnails, filename) });
  // The JPEG is written in place; the row that first names it commits under a backup lease (#9982).
  const out = await withBackupAssetPublication(() => writeCoverArt(projectId, () => ({
    ...next, filename, composedAt: new Date().toISOString(), lastError: null,
  })));
  if (art.filename && art.filename !== filename) await releaseKitFiles([art.filename], [filename]);
  console.log(`🖼️ Music Video cover art ${String(projectId).slice(3, 11)} ← ${next.source.filename}`);
  publish(projectId, out.project);
  return { project: out.project };
}

/**
 * Draft this song's cover design (lettering and the photo to make) in one
 * provider call. With a design already in place, `direction` adjusts it. An
 * existing cover is recomposed in the new lettering at once; a new photo
 * waits for "Make a cover image".
 */
export async function designCoverArt(projectId, { direction = '', providerId = null, model = null } = {}) {
  const project = await requireProject(projectId);
  const art = projectCoverArt(project);
  const { resolveProviderAndModel, runPromptThroughProvider } = await deps.runner();
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  if (!provider) throw coverError(503, 'NO_PROVIDER', 'No AI provider is available to design the cover');
  const previous = art.design ? { design: art.design, imagePrompt: art.imagePrompt || '' } : null;
  const fonts = await deps.fonts();
  // A fresh design starts from the artist's saved style, when they have one.
  const artistStyle = previous ? null : await deps.artistStyle(art.tag ?? await defaultTag()).catch(() => null);
  const prompt = buildCoverDesignPrompt(project, { direction: trimTo(direction, 1500), previous, artistStyle: artistStyle?.design || null, fonts });
  const { text } = await runPromptThroughProvider({ provider, model: selectedModel, prompt, source: 'music-video-cover-design' });
  const drafted = parseCoverDesign(text, { fonts });
  if (!drafted) throw coverError(502, 'COVER_DESIGN_UNPARSEABLE', 'The cover design came back without a usable design. Try again or another model');
  const out = await writeCoverArt(projectId, () => ({
    design: drafted.design,
    imagePrompt: drafted.imagePrompt || art.imagePrompt || '',
    rationale: drafted.rationale,
    direction: trimTo(direction, 1500),
    designedAt: new Date().toISOString(),
    lastError: null,
  }));
  console.log(`🖼️ Music Video cover art ${String(projectId).slice(3, 11)}: design ${previous ? 'adjusted' : 'drafted'} (${drafted.design.layout}, ${drafted.design.typeface})`);
  // Restyling the lettering puts it back on a cover that was used bare.
  if (art.source) return composeProjectCoverArt(projectId, { lettering: true });
  publish(projectId, out.project);
  return { project: out.project };
}

/**
 * Set the song's lettering from the Lettering controls (or an artist style):
 * `patch` is any subset of the design, merged over the current one, with no AI
 * call. A song with a cover is recomposed at once, so the saved JPEG matches
 * what the preview showed.
 */
export async function saveCoverDesign(projectId, patch = {}) {
  const project = await requireProject(projectId);
  const art = projectCoverArt(project);
  const fonts = await deps.fonts();
  const design = normalizeCoverDesign({ ...normalizeCoverDesign(art.design, { fonts }), ...patch }, { fonts });
  const out = await writeCoverArt(projectId, () => ({ design, lastError: null }));
  console.log(`🖼️ Music Video cover art ${String(projectId).slice(3, 11)}: lettering set (${design.layout}, ${design.typeface}, ${design.titleStyle})`);
  // Like a restyle, setting the lettering puts it back on a cover that was used bare.
  if (art.source) return composeProjectCoverArt(projectId, { lettering: true });
  publish(projectId, out.project);
  return { project: out.project };
}

// Where the photo should stay calm, so the title reads over it.
const QUIET_AREA = {
  'bottom-left': 'the lower left', 'bottom-center': 'the bottom', 'top-left': 'the upper left',
  'top-center': 'the top', center: 'the middle', 'vertical-left': 'the left edge',
};

/** The image prompt for a cover photo: the design's own photo when drafted, adjusted by `notes`. */
function buildCoverArtPrompt(project, art, { notes = '' } = {}) {
  const direction = project?.castAndSets?.direction || {};
  const p = direction.protagonist || {};
  const subject = trimTo([p.face, p.hair, p.signature].filter(Boolean).join('; '), 600);
  const look = trimTo(direction.look || project?.concept?.style, 600);
  const layout = normalizeCoverDesign(art.design).layout;
  return [
    `Square single cover photograph for the song "${trimTo(project?.name || 'Untitled', 120)}".`,
    art.imagePrompt || [`A close-up portrait of the lead singer${subject ? `: ${subject}` : ''}.`, look ? `Look: ${look}.` : ''].filter(Boolean).join(' '),
    notes ? `Adjustment from the artist: ${trimTo(notes, 1500)}` : '',
    `Keep ${QUIET_AREA[layout]} of the frame calm, since the title is set there later.`,
    'No text, letters, logos, or watermark anywhere in the image.',
  ].filter(Boolean).join(' ');
}

/**
 * Whether a recorded request still has a render on the way. One whose job left
 * the queue without its terminal event reaching the hook (a restart mid-render)
 * is not, so it never locks the director out of asking again.
 */
async function pendingIsLive(pending) {
  if (!pending) return false;
  if (pending.jobId) return LIVE_JOB.has(await deps.jobStatus(pending.jobId).catch(() => null));
  return Date.now() - Date.parse(pending.requestedAt || 0) < RESERVATION_TTL_MS;
}

/**
 * Ask the install's default image generator for a new cover source. The
 * completion hook composes the cover from it with the current title and tag.
 * `reference` (a gallery image) keeps the singer's likeness, or is the image
 * `notes` adjusts; it defaults to the Cast & Sets character sheet. A song with
 * no design yet gets one first, steered by `notes`.
 */
export async function generateCoverArtSource(projectId, { notes = '', reference = null } = {}) {
  let project = await requireProject(projectId);
  const previous = projectCoverArt(project).pending;
  if (await pendingIsLive(previous)) throw coverError(409, 'COVER_ART_IN_PROGRESS', 'A cover image is already being made');
  if (!projectCoverArt(project).design) {
    const designed = await designCoverArt(projectId, { direction: notes }).then(() => true).catch((err) => {
      console.warn(`⚠️ Music Video cover art ${String(projectId).slice(3, 11)}: no design drafted (${err.message}); using the plain look`);
      return false;
    });
    if (designed) { project = await requireProject(projectId); notes = ''; }
  }
  const settings = await deps.getSettings();
  const route = await deps.defaultRoute(settings);
  if (!route) throw coverError(409, 'COVER_ART_ROUTE_UNAVAILABLE', 'Image generation is not set up. Choose an image generator in Settings and try again');
  const refName = reference?.filename || project.castAndSets?.images?.character?.imageId || null;
  const refPath = refName ? resolveGalleryImage(refName) : null;
  if (reference?.filename && !refPath) throw coverError(422, 'PUBLISH_ASSET_MISSING', `The reference image is missing (${basename(reference.filename)})`);
  const requestId = randomUUID();
  // Reserve before queueing, so a job that settles at once finds its request
  // current. The check runs again inside the write: a second click that raced
  // past the one above loses here.
  await writeCoverArt(projectId, (art) => {
    if ((art.pending?.requestId || null) !== (previous?.requestId || null)) throw coverError(409, 'COVER_ART_IN_PROGRESS', 'A cover image is already being made');
    return { pending: { requestId, jobId: null, mode: route.mode, requestedAt: new Date().toISOString() }, lastError: null };
  });
  const common = {
    prompt: buildCoverArtPrompt(project, projectCoverArt(project), { notes }),
    width: SOURCE_PX,
    height: SOURCE_PX,
    ...(refPath ? { referenceImagePaths: [refPath], referenceImageStrengths: [1] } : {}),
    // The completion hook files the result by this tag. No `sceneId` or
    // `castAndSets`, so the scene and Cast & Sets hooks ignore the job.
    musicVideo: { projectId: project.id, coverArt: { requestId } },
  };
  const sent = await deps.imageParams(settings, route, common)
    .then((params) => deps.withStyle(project, params, route.mode, route.model, settings))
    .then((params) => deps.enqueue({ kind: 'image', params, owner: `music-video-cover-art:${project.id}` }))
    .catch(async (err) => {
      const failed = await writeCoverArt(projectId, (art) => (art.pending?.requestId === requestId
        ? { pending: null, lastError: trimTo(`The cover image could not be queued: ${err.message}`, 300) } : {}));
      publish(projectId, failed.project);
      throw err;
    });
  const jobId = typeof sent?.jobId === 'string' ? sent.jobId : null;
  // The job may already have settled and cleared the reservation; only a still-current one gets its id.
  const out = await writeCoverArt(projectId, (art) => (art.pending?.requestId === requestId && jobId ? { pending: { ...art.pending, jobId } } : {}));
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
  await composeProjectCoverArt(projectId, { source: { kind: 'image', filename }, lettering: true }).catch(async (err) => {
    console.error(`❌ Music Video cover art ${String(projectId).slice(3, 11)} compose failed: ${err.message}`);
    const failed = await writeCoverArt(projectId, () => ({ lastError: trimTo(`The cover could not be composed: ${err.message}`, 300) }));
    publish(projectId, failed.project);
  });
  return true;
}
