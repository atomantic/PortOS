/**
 * Code Animation orchestration — resolves a brief's configurations (universe,
 * mood board, reference uploads, audio) into prompt inputs, builds the prompt,
 * and optionally runs it through an AI provider to get the animation's HTML.
 *
 * Generated jobs are persisted locally: PostgreSQL stores gallery metadata
 * and the generation brief, while the completed HTML is a managed file asset.
 * The page can reopen completed work after navigation or restart; a job that
 * was still running when the server restarted is marked interrupted on read.
 *
 * The heavy dependencies (provider runner, universe + mood-board stores) are
 * imported lazily so the options/prompt path and its tests stay light.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { emitCodeAnimationChanged } from '../socket.js';
import { PATHS } from '../../lib/paths.js';
import { makePathResolver } from '../../lib/pathSafety.js';
import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';
import { UPLOAD_AUDIO_EXTENSIONS } from '../../lib/mimeTypes.js';
import { normalizeWaveSketch } from '../../lib/waveSketch.js';
import { SUPPORTED_AUDIO_EXTENSIONS } from '../pipeline/musicLibrary.js';
import { resolveMoodBoardStyleSource as resolveMoodBoard, resolveUniverseStyleSource as resolveUniverse } from '../creativeStyleSources.js';
import {
  getCodeAnimationJobRecord,
  isCodeAnimationJobId,
  listCodeAnimationJobRecords,
  listRunningCodeAnimationJobIds,
  listCodeAnimationJobPage,
  countCodeAnimationJobs,
  readCodeAnimationHtml,
  saveCodeAnimationHtml,
  saveCodeAnimationJobRecord,
} from './jobStore.js';
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
const resolveMusicAudio = makePathResolver(() => PATHS.music, { extensions: SUPPORTED_AUDIO_EXTENSIONS });

// This process-local set distinguishes live work from persisted jobs left
// running by a previous server process. Those are marked interrupted when the
// gallery or job detail is next read.
const activeJobs = new Set();

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

/**
 * Derive compact timing cues from a track's drawn waveform (waveSketch).
 * Returns prompt-ready cue text covering section/onset times, strongest note
 * or stroke onsets, and the loudness contour, or '' if no valid sketch.
 */
export function _deriveWaveSketchCues(rawSketch) {
  const sketch = normalizeWaveSketch(rawSketch);
  if (!sketch) return '';

  const durationSec = sketch.durationSec;
  const strokes = [];
  for (const voice of sketch.voices || []) {
    const gain = typeof voice.gain === 'number' ? voice.gain : 0.6;
    for (const note of voice.notes || []) {
      const v = typeof note.v === 'number' ? note.v : 0.8;
      strokes.push({
        voice: voice.name || 'voice',
        t: note.t,
        d: note.d,
        hz: note.hz,
        pitch: note.pitch,
        v,
        strength: v * gain,
      });
    }
  }

  if (strokes.length === 0) return '';

  // 1. Section and onset times
  const uniqueOnsets = [...new Set(strokes.map((s) => Math.round(s.t * 100) / 100))].sort((a, b) => a - b);
  const formattedOnsets = uniqueOnsets.slice(0, 16).map((t) => `${t.toFixed(1)}s`).join(', ');
  const onsetSummary = uniqueOnsets.length > 16 ? `${formattedOnsets} (+${uniqueOnsets.length - 16} more)` : formattedOnsets;

  // 2. Strongest note or stroke onsets
  const strongest = [...strokes]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 6)
    .sort((a, b) => a.t - b.t);
  const formattedStrongest = strongest.map((s) => {
    const pitchStr = s.pitch || (s.hz ? `${Math.round(s.hz)}Hz` : '');
    const voicePitch = pitchStr ? `${s.voice} ${pitchStr}` : s.voice;
    return `${s.t.toFixed(1)}s: ${voicePitch} (vel ${s.v.toFixed(2)})`;
  }).join('; ');

  // 3. Loudness contour
  let contourSummary = '';
  if (Array.isArray(sketch.contour) && sketch.contour.length >= 2) {
    const count = Math.min(6, sketch.contour.length);
    const sampled = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i / (count - 1)) * (sketch.contour.length - 1));
      const t = (i / (count - 1)) * durationSec;
      sampled.push(`${t.toFixed(1)}s: ${Math.round(sketch.contour[idx] * 100)}%`);
    }
    contourSummary = sampled.join(' -> ');
  } else {
    const steps = 4;
    const sampled = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * durationSec;
      const active = strokes.filter((s) => (t >= s.t && t <= s.t + s.d) || Math.abs(s.t - t) < 0.25);
      const energy = active.length > 0
        ? Math.min(1, active.reduce((max, s) => Math.max(max, s.strength), 0))
        : 0;
      sampled.push(`${t.toFixed(1)}s: ${Math.round(energy * 100)}%`);
    }
    contourSummary = sampled.join(' -> ');
  }

  const lines = [
    'Drawn waveform timing cues:',
    `- Section/onset times: ${onsetSummary}`,
    `- Strongest onsets: ${formattedStrongest}`,
    `- Loudness contour: ${contourSummary}`,
  ];

  return lines.join('\n');
}

async function resolveAudio(audio) {
  if (!audio) return null;

  if (audio.source === 'track' || audio.trackId) {
    const { getTrack } = await import('../tracks/index.js');
    const track = await getTrack(audio.trackId);
    if (!track || track.deletedAt) {
      throw new ServerError(`Track not found: ${audio.trackId}`, { status: 400, code: 'AUDIO_NOT_FOUND' });
    }
    if (!track.audioFilename || !resolveMusicAudio(track.audioFilename)) {
      throw new ServerError(`Audio file not found: ${track.audioFilename || audio.trackId}`, { status: 400, code: 'AUDIO_NOT_FOUND' });
    }
    const name = trimTo(audio.label, 200) || trimTo(track.title, 200) || track.audioFilename;
    const durationSeconds = audio.durationSeconds ?? track.durationSec ?? null;
    let notes = isNonBlankStr(audio.notes) ? trimTo(audio.notes, CODE_ANIMATION_LIMITS.audioNotesMax) : '';
    if (track.waveSketch) {
      const cues = _deriveWaveSketchCues(track.waveSketch);
      if (cues) {
        notes = notes ? `${notes}\n\n${cues}` : cues;
        notes = trimTo(notes, CODE_ANIMATION_LIMITS.audioNotesMax);
      }
    }
    return {
      source: 'track',
      trackId: track.id,
      name,
      durationSeconds,
      notes,
      url: `/data/music/${encodeURIComponent(track.audioFilename)}`,
    };
  }

  if (!resolveUploadAudio(audio.filename)) {
    throw new ServerError(`Audio file not found: ${audio.filename}`, { status: 400, code: 'AUDIO_NOT_FOUND' });
  }
  return {
    source: 'upload',
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
  const audio = await resolveAudio(input.audio);
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
  const promptInput = {
    title: input.title,
    concept: input.concept,
    cast: input.cast,
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
  };
  const prompt = buildCodeAnimationPrompt({ ...promptInput, delivery });
  return {
    prompt,
    // The copy form describes references as attachments; the CLI form embeds
    // their on-disk paths, which must not reach the client.
    copyPrompt: delivery === 'copy' ? prompt : buildCodeAnimationPrompt({ ...promptInput, delivery: 'copy' }),
    moodBoardId: moodBoardId || null,
    frame: { ...resolveFrameSize(input.format.aspectRatio, input.format.resolution), fps: input.format.fps, durationSeconds: input.format.durationSeconds },
    // Absolute paths never leave the server — the client gets served URLs only.
    attachments: referenceImages.map(({ label, origin, url }) => ({ label, origin, url })),
    audioUrl: audio?.url || null,
    referencePaths: referenceImages.map((image) => image.path),
  };
}

/**
 * Write the brief itself: ask a model for a title / beat sheet / character
 * bible / on-screen text / style refinement grounded in the universe's bible and canon cast, the same
 * way a series or story is generated from a universe. Synchronous — a few
 * hundred words comes back inside one request, unlike the HTML generation.
 *
 * Returns `{ brief }`, which the client drops straight into the form so the
 * user can edit it before building the animation prompt.
 */
export async function generateCodeAnimationBrief(input) {
  // With no world and no words the model has nothing to be faithful to, and a
  // blank-slate brief is not what this writer is for. The rule lives here, not
  // in the route, so a non-HTTP caller gets it too.
  const { title, concept } = input.current || {};
  if (!input.universeId && !input.seedIdea && !concept && !title) {
    throw new ServerError('Pick a universe or describe a starting idea to write a brief from', { status: 400, code: 'BRIEF_INPUT_REQUIRED' });
  }
  const { assertProvider, resolveProviderAndModel, runPromptThroughProvider } = await import('../promptRunner.js');
  const { buildCodeAnimationBriefPrompt, extractBriefIdea } = await import('./brief.js');
  // Resolving the provider and loading the universe are independent — only the
  // board depends on which universe came back. No image slots: the brief is
  // text, and the style images are already the coding prompt's job.
  const [{ provider, selectedModel }, universe] = await Promise.all([
    resolveProviderAndModel({ providerId: input.providerId, model: input.model }),
    resolveUniverse(input.universeId, { imageSlots: 0, narrative: true }),
  ]);
  assertProvider(provider, { message: 'No AI provider available to write the brief', code: 'PROVIDER_UNAVAILABLE', status: 400 });
  const moodBoardId = input.moodBoardId === undefined ? universe?.moodBoardId : input.moodBoardId;
  const { board } = await resolveMoodBoard(moodBoardId, { imageSlots: 0 });
  const prompt = buildCodeAnimationBriefPrompt({
    universe,
    moodBoard: board,
    seedIdea: input.seedIdea,
    format: input.format,
    current: input.current,
  });
  console.log(`📝 Code animation brief writing on ${provider.id}/${selectedModel || 'default'}${universe ? ` for universe "${universe.name}"` : ''}`);
  const { text, runId } = await runPromptThroughProvider({
    provider,
    model: selectedModel || undefined,
    effort: input.effort || undefined,
    prompt,
    source: 'code-animation-brief',
    // Same containment as the HTML generation: a CLI/TUI agent only needs to
    // print a JSON document, never to touch the PortOS checkout.
    cwd: PATHS.data,
  });
  const brief = extractBriefIdea(text);
  console.log(`✅ Code animation brief written — runId=${runId || 'n/a'} concept=${brief.concept.length} chars`);
  return { brief };
}

const jobTitle = (input) => input.title?.trim() || input.concept.slice(0, 120);

function summaryJob(job) {
  return {
    id: job.id,
    status: job.status,
    title: job.title,
    concept: job.concept || job.input?.concept || '',
    providerId: job.providerId,
    model: job.model,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

async function reconcileJob(job) {
  if (job.status !== 'running' || activeJobs.has(job.id)) return job;
  const now = new Date().toISOString();
  const interrupted = {
    ...job,
    status: 'failed',
    error: 'Generation was interrupted by a server restart',
    completedAt: now,
    updatedAt: now,
  };
  await saveCodeAnimationJobRecord(interrupted);
  emitCodeAnimationChanged(job.id);
  return interrupted;
}

export async function listCodeAnimationJobs() {
  const records = await listCodeAnimationJobRecords();
  return Promise.all(records.map(async (job) => {
    if (job.status !== 'running' || activeJobs.has(job.id)) return summaryJob(job);
    const record = await getCodeAnimationJobRecord(job.id);
    return record ? summaryJob(await reconcileJob(record)) : summaryJob(job);
  }));
}

const JOB_PAGE_SIZE = 50;
const JOB_PAGE_MAX = 100;

function decodeJobCursor(value) {
  if (!value) return null;
  let tuple;
  try { tuple = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { /* invalid cursor */ }
  if (!Array.isArray(tuple) || tuple.length !== 2
      || typeof tuple[0] !== 'string' || Number.isNaN(Date.parse(tuple[0]))
      || !isCodeAnimationJobId(tuple[1])) {
    throw new ServerError('Invalid job cursor', { status: 400, code: 'INVALID_CURSOR' });
  }
  return { createdAt: new Date(tuple[0]).toISOString(), id: tuple[1] };
}

export async function pageCodeAnimationJobs({ limit = JOB_PAGE_SIZE, cursor } = {}) {
  const size = Math.min(limit, JOB_PAGE_MAX);
  const after = decodeJobCursor(cursor);
  // Reconcile only the small running subset before counting or reading a page.
  const runningIds = await listRunningCodeAnimationJobIds();
  await Promise.all(runningIds.filter((id) => !activeJobs.has(id)).map(async (id) => {
    const record = await getCodeAnimationJobRecord(id);
    if (record) await reconcileJob(record);
  }));
  const [rows, counts] = await Promise.all([
    listCodeAnimationJobPage({ limit: size, cursor: after }),
    countCodeAnimationJobs(),
  ]);
  const items = rows.slice(0, size);
  const last = items.at(-1);
  return {
    items,
    total: counts.total,
    counts: { running: counts.running, completed: counts.completed },
    nextCursor: rows.length > size && last
      ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url') : null,
  };
}

async function runGeneration({ provider, model, effort, prompt, referencePaths }) {
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
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    status: 'running',
    title: jobTitle(input),
    input,
    providerId: provider.id,
    model: input.model || null,
    frame: built.frame,
    audioUrl: built.audioUrl,
    prompt: built.copyPrompt,
    attachments: built.attachments,
    moodBoardId: built.moodBoardId,
    error: null,
    runId: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  activeJobs.add(id);
  await saveCodeAnimationJobRecord(job).catch((error) => {
    activeJobs.delete(id);
    throw error;
  });
  emitCodeAnimationChanged(id);
  console.log(`🎞️ Code animation generation ${id.slice(0, 8)} started on ${provider.id}`);
  runGeneration({ provider, model: input.model, effort: input.effort, prompt: built.prompt, referencePaths: built.referencePaths })
    .then(async ({ html, provider: ranOn, model, runId }) => {
      await saveCodeAnimationHtml(id, html);
      const completedAt = new Date().toISOString();
      await saveCodeAnimationJobRecord({
        ...job,
        status: 'completed',
        providerId: ranOn,
        model,
        runId,
        completedAt,
        updatedAt: completedAt,
      });
      emitCodeAnimationChanged(id);
      activeJobs.delete(id);
      console.log(`✅ Code animation generation ${id.slice(0, 8)} completed (${html.length} chars)`);
    })
    .catch(async (error) => {
      const message = String(error?.message || error || 'Generation failed').slice(0, 2_000);
      const completedAt = new Date().toISOString();
      const failed = { ...job, status: 'failed', error: message, completedAt, updatedAt: completedAt };
      await saveCodeAnimationJobRecord(failed).then(() => emitCodeAnimationChanged(id)).catch((persistError) => {
        console.error(`❌ Code animation generation ${id.slice(0, 8)} status could not be saved: ${persistError.message}`);
      });
      activeJobs.delete(id);
      console.error(`❌ Code animation generation ${id.slice(0, 8)} failed: ${message}`);
    });
  return job;
}

export async function getCodeAnimationJob(id) {
  if (!isCodeAnimationJobId(id)) return null;
  const record = await getCodeAnimationJobRecord(id);
  if (!record) return null;
  let job = await reconcileJob(record);
  if (job.status !== 'completed') return { ...job, html: null };
  try {
    return { ...job, html: await readCodeAnimationHtml(job.id) };
  } catch (error) {
    if (error?.code !== 'CODE_ANIMATION_OUTPUT_MISSING') throw error;
    const completedAt = new Date().toISOString();
    job = {
      ...job,
      status: 'failed',
      error: 'Generated animation file is missing from this installation',
      completedAt,
      updatedAt: completedAt,
    };
    await saveCodeAnimationJobRecord(job);
    emitCodeAnimationChanged(id);
    return { ...job, html: null };
  }
}
