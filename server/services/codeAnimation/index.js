/**
 * Code Animation orchestration — resolves a brief's configurations (universe,
 * mood board, reference uploads, audio) into prompt inputs, builds the prompt,
 * and optionally runs it through an AI provider to get the animation's HTML.
 *
 * Nothing is persisted: the prompt is returned for the user to copy, and a
 * generation is a short-lived in-memory job the page polls until the HTML is
 * ready. The page then previews, records, and saves the result through the
 * existing gallery-video upload path, which is where the durable artifact
 * lives. A server restart simply forgets in-flight jobs.
 *
 * The heavy dependencies (provider runner, universe + mood-board stores) are
 * imported lazily so the options/prompt path and its tests stay light.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';
import { makePathResolver, resolveGalleryImage, resolveImageRef } from '../../lib/pathSafety.js';
import { universeVisualStyleTokens } from '../../lib/universeVisualStyle.js';
import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';
import { UPLOAD_AUDIO_EXTENSIONS } from '../../lib/mimeTypes.js';
import {
  buildCodeAnimationPrompt,
  extractAnimationHtml,
  resolveFrameSize,
  CODE_ANIMATION_ASPECT_RATIOS,
  CODE_ANIMATION_AUDIO_GLOBAL,
  CODE_ANIMATION_LIMITS,
  CODE_ANIMATION_MESSAGES,
  CODE_ANIMATION_RENDERERS,
  CODE_ANIMATION_RESOLUTIONS,
} from './prompt.js';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const resolveUploadImage = makePathResolver(() => PATHS.uploads, { extensions: IMAGE_EXTENSIONS });
const resolveUploadAudio = makePathResolver(() => PATHS.uploads, { extensions: UPLOAD_AUDIO_EXTENSIONS });

const JOB_TTL_MS = 60 * 60 * 1000;
const JOBS_MAX = 20;
const jobs = new Map();

export function getCodeAnimationOptions() {
  return {
    aspectRatios: Object.keys(CODE_ANIMATION_ASPECT_RATIOS),
    resolutions: Object.keys(CODE_ANIMATION_RESOLUTIONS),
    renderers: CODE_ANIMATION_RENDERERS,
    limits: CODE_ANIMATION_LIMITS,
    messages: CODE_ANIMATION_MESSAGES,
    audioGlobal: CODE_ANIMATION_AUDIO_GLOBAL,
    audioExtensions: UPLOAD_AUDIO_EXTENSIONS,
  };
}

// The two served image dirs a reference can live in, by asset kind.
const IMAGE_DIRS = {
  'image-ref': { resolve: resolveImageRef, urlPrefix: '/data/image-refs/' },
  image: { resolve: resolveGalleryImage, urlPrefix: '/data/images/' },
};

// A local image as a prompt reference, or null when the file is missing.
function localReference(kind, filename, label, origin) {
  const dir = IMAGE_DIRS[kind];
  const path = dir?.resolve(filename);
  return path ? { label, origin, path, url: `${dir.urlPrefix}${encodeURIComponent(filename)}` } : null;
}

// Resolve reference candidates in order until `slots` are filled, so a
// universe or board with many images costs only the stats it can use.
function fillReferences(candidates, slots) {
  const images = [];
  for (const candidate of candidates) {
    if (images.length >= slots) break;
    const image = candidate();
    if (image && !images.some((existing) => existing.path === image.path)) images.push(image);
  }
  return images;
}

async function resolveUniverse(universeId, { imageSlots }) {
  if (!universeId) return null;
  const { getUniverse } = await import('../universeBuilder/crud.js');
  const universe = await getUniverse(universeId).catch((error) => {
    if (error?.code === 'NOT_FOUND') throw new ServerError('Universe not found', { status: 404, code: 'NOT_FOUND' });
    throw error;
  });
  const { embrace, avoid } = universeVisualStyleTokens(universe);
  const refs = Array.isArray(universe.styleReferences) ? universe.styleReferences : [];
  const styleReferences = refs
    .filter((ref) => isNonBlankStr(ref?.prompt))
    .slice(0, 6)
    .map((ref) => ({ title: trimTo(ref.title, 120), prompt: trimTo(ref.prompt, 600) }));
  // A style image lives in either served dir depending on how it was made
  // (style-reference upload vs gallery probe), so try refs first, then gallery.
  const styleImage = (filename, label) => () => localReference('image-ref', filename, label, 'universe')
    || localReference('image', filename, label, 'universe');
  const candidates = [
    ...refs.map((ref) => [ref?.imageRefs?.[0], trimTo(ref?.title, 120) || 'Universe style reference']),
    ...(Array.isArray(universe.styleImageRefs) ? universe.styleImageRefs : []).map((filename) => [filename, 'Universe style probe']),
  ].filter(([filename]) => isNonBlankStr(filename)).map(([filename, label]) => styleImage(filename, label));
  const images = fillReferences(candidates, imageSlots);
  return {
    name: universe.name,
    embrace,
    avoid,
    styleNotes: trimTo(universe.styleNotes, 2_000),
    styleReferences,
    moodBoardId: isNonBlankStr(universe.moodBoardId) ? universe.moodBoardId : null,
    images,
  };
}

async function resolveMoodBoard(moodBoardId, { imageSlots }) {
  if (!moodBoardId) return { board: null, images: [] };
  const [{ getBoard }, { collectBoardStyleContext }, { boardItemLocalImage }] = await Promise.all([
    import('../moodBoard/db.js'),
    import('../moodBoard/styleContext.js'),
    import('../moodBoard/logic.js'),
  ]);
  const board = await getBoard(moodBoardId);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  // Text items, videos, and external pins attach nothing — they still
  // contribute their caption/analysis text through the board context.
  const candidates = (board.items || []).map((item) => () => {
    const asset = boardItemLocalImage(item);
    return asset ? localReference(asset.kind, asset.filename, trimTo(item.caption, 120) || asset.filename, 'mood-board') : null;
  });
  return { board: collectBoardStyleContext(board), images: fillReferences(candidates, imageSlots) };
}

function resolveUploadedImages(referenceImages) {
  return referenceImages.map((ref) => {
    const path = resolveUploadImage(ref.filename);
    if (!path) {
      throw new ServerError(`Reference image not found: ${ref.filename}`, { status: 400, code: 'REFERENCE_NOT_FOUND' });
    }
    return {
      label: trimTo(ref.label, 120) || ref.filename,
      origin: 'upload',
      note: ref.note,
      path,
      url: `/api/uploads/${encodeURIComponent(ref.filename)}`,
    };
  });
}

function resolveAudio(audio) {
  if (!audio) return null;
  if (!resolveUploadAudio(audio.filename)) {
    throw new ServerError(`Audio file not found: ${audio.filename}`, { status: 400, code: 'AUDIO_NOT_FOUND' });
  }
  return {
    name: trimTo(audio.label, 200) || audio.filename,
    durationSeconds: audio.durationSeconds ?? null,
    notes: audio.notes,
    url: `/api/uploads/${encodeURIComponent(audio.filename)}`,
  };
}

/**
 * Resolve every configuration a brief references and build its prompt.
 * `delivery` decides how reference images are described to the model
 * (attached for copy/API, on-disk paths for CLI agents).
 */
export async function buildCodeAnimationRequest(input, { delivery = 'copy' } = {}) {
  const uploads = resolveUploadedImages(input.referenceImages || []);
  const audio = resolveAudio(input.audio);
  const universe = await resolveUniverse(input.universeId, {
    imageSlots: Math.max(0, CODE_ANIMATION_LIMITS.referenceImagesMax - uploads.length),
  });
  // The universe is the art direction, so its linked mood board is the default:
  // an ABSENT moodBoardId follows the universe, an explicit null means none.
  const moodBoardId = input.moodBoardId === undefined ? universe?.moodBoardId : input.moodBoardId;
  // Reference-image slots go to the user's own uploads first, then the
  // universe's style images, then the board's pins.
  const universeImages = universe?.images || [];
  const { board, images: boardImages } = await resolveMoodBoard(moodBoardId, {
    imageSlots: input.includeMoodBoardImages === false
      ? 0
      : Math.max(0, CODE_ANIMATION_LIMITS.referenceImagesMax - uploads.length - universeImages.length),
  });
  const referenceImages = [...uploads, ...universeImages, ...boardImages];
  const prompt = buildCodeAnimationPrompt({
    title: input.title,
    concept: input.concept,
    onScreenText: input.onScreenText,
    styleNotes: input.styleNotes,
    format: input.format,
    renderer: input.renderer,
    interactive: input.interactive,
    soundtrack: input.soundtrack,
    audio,
    universe,
    moodBoard: board,
    referenceImages,
    delivery,
  });
  return {
    prompt,
    moodBoardId: moodBoardId || null,
    frame: { ...resolveFrameSize(input.format.aspectRatio, input.format.resolution), fps: input.format.fps, durationSeconds: input.format.durationSeconds },
    // Absolute paths never leave the server — the client gets served URLs only.
    attachments: referenceImages.map(({ label, origin, url }) => ({ label, origin, url })),
    audioUrl: audio?.url || null,
    referencePaths: referenceImages.map((image) => image.path),
  };
}

// Drop settled jobs past their TTL, then the oldest settled ones past the cap.
// A running job is never evicted — its result would have nowhere to land.
function pruneJobs() {
  const now = Date.now();
  const settled = [...jobs.values()].filter((job) => job.status !== 'running')
    .sort((a, b) => a.updatedAtMs - b.updatedAtMs);
  let overflow = jobs.size - JOBS_MAX;
  for (const job of settled) {
    if (overflow > 0 || now - job.updatedAtMs > JOB_TTL_MS) {
      jobs.delete(job.id);
      overflow -= 1;
    }
  }
}

const publicJob = ({ updatedAtMs: _updatedAtMs, ...job }) => job;

function settleJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.set(id, { ...job, ...patch, completedAt: new Date().toISOString(), updatedAtMs: Date.now() });
}

async function runGeneration(jobId, { provider, model, effort, prompt, referencePaths }) {
  const { runPromptThroughProvider } = await import('../promptRunner.js');
  const result = await runPromptThroughProvider({
    provider,
    model: model || undefined,
    effort: effort || undefined,
    prompt,
    source: 'code-animation-generation',
    // CLI/TUI agents only need to read the references and print a document;
    // keep them in runtime data so a generation can't become a code-editing
    // session in the PortOS checkout.
    cwd: PATHS.data,
    screenshots: provider.type === 'api' ? referencePaths : [],
    timeout: Math.max(provider.timeout || 0, 15 * 60 * 1000),
  });
  const html = extractAnimationHtml(result.text);
  if (!html) throw new Error('The model response did not contain an HTML document');
  return { html, provider: result.provider?.id || provider.id, model: result.model || null, runId: result.runId || null };
}

/**
 * Start generating the animation HTML. Resolves the provider and builds the
 * prompt synchronously (so a bad provider/universe/upload is a 4xx on this
 * request), then runs the model in the background and returns the job.
 */
export async function startCodeAnimationGeneration(input) {
  const { getProviderById } = await import('../providers.js');
  const provider = await getProviderById(input.providerId);
  if (!provider || provider.enabled === false) {
    throw new ServerError('Choose an enabled AI provider', { status: 400, code: 'PROVIDER_UNAVAILABLE' });
  }
  const built = await buildCodeAnimationRequest(input, { delivery: provider.type === 'api' ? 'api' : 'cli' });
  pruneJobs();
  const id = randomUUID();
  const now = new Date().toISOString();
  jobs.set(id, {
    id,
    status: 'running',
    providerId: provider.id,
    model: input.model || null,
    frame: built.frame,
    audioUrl: built.audioUrl,
    html: null,
    error: null,
    runId: null,
    startedAt: now,
    completedAt: null,
    updatedAtMs: Date.now(),
  });
  console.log(`🎞️ Code animation generation ${id.slice(0, 8)} started on ${provider.id}`);
  runGeneration(id, { provider, model: input.model, effort: input.effort, prompt: built.prompt, referencePaths: built.referencePaths })
    .then(({ html, provider: ranOn, model, runId }) => {
      settleJob(id, { status: 'completed', html, providerId: ranOn, model, runId });
      console.log(`✅ Code animation generation ${id.slice(0, 8)} completed (${html.length} chars)`);
    })
    .catch((error) => {
      const message = String(error?.message || error || 'Generation failed').slice(0, 2_000);
      settleJob(id, { status: 'failed', error: message });
      console.error(`❌ Code animation generation ${id.slice(0, 8)} failed: ${message}`);
    });
  return { ...publicJob(jobs.get(id)), prompt: built.prompt, attachments: built.attachments };
}

export function getCodeAnimationJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

