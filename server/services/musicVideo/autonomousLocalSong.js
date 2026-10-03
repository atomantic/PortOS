/**
 * Autonomous Music Video — the local song source (#9473).
 *
 * The alternative to the Suno step: renders the song with the on-device Music
 * Designer engines (ACE-Step, MiniMax, …) through the same audio media-job lane
 * the Music studio uses, so an unattended run still finishes when Suno is
 * signed out, out of credits or redesigned.
 *
 * The song's Track is created up front and handed to the generation request, so
 * the Music Studio completion hook (`musicStudioHook.js`) lands the rendered
 * audio on it. This module then only waits for the job to finish and for that
 * attach to be visible on the track. The job id is stored the moment it is
 * queued (`onSubmitted`), so a retry rejoins a render still in flight instead of
 * starting a second one, and a track that already has audio is never re-rendered.
 *
 * Every provider (engine registry, media queue, track store) is injectable so
 * the flow is unit-testable without a GPU.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { sleep as defaultSleep } from '../../lib/fileCore.js';
import { trimTo } from '../../lib/textUtils.js';

// A full song, not the engines' short default clip. Clamped to each engine's own window.
const LOCAL_SONG_TARGET_SEC = 180;
// A render waits behind the GPU lane, so the cap is generous; the run's stop
// button cancels the job, which settles the wait.
const LOCAL_SONG_TIMEOUT_MS = 90 * 60 * 1000;
// The completion hook attaches the audio a moment after the job reports done.
const ATTACH_POLL_MS = 500;
const ATTACH_POLLS = 40;
const TERMINAL = ['completed', 'failed', 'canceled'];

const fail = (status, code, message, context) => new ServerError(message, { status, code, ...(context ? { context } : {}) });

const defaults = {
  listEngines: async () => (await import('../pipeline/musicGen.js')).ENGINES,
  isEngineHealthy: async (id) => (await import('../pipeline/musicGen.js')).isEngineHealthy(id),
  queueGeneration: async (body) => (await import('../musicGeneration.js')).queueMusicGeneration(body),
  writeMusicCode: async (args) => (await import('../musicCode.js')).writeMusicCode(args),
  renderSuperColliderSource: async (args) => (await import('../superColliderRender.js')).renderSuperColliderSource(args),
  saveSuperColliderTakeToTrack: async (args) => (await import('../musicCode.js')).saveSuperColliderTakeToTrack(args),
  getSuperColliderStatus: async () => (await import('../superColliderRuntime.js')).getSuperColliderStatus(),
  getJob: async (id) => (await import('../mediaJobQueue/index.js')).getJob(id),
  getTrack: async (id) => (await import('../tracks/index.js')).getTrack(id),
  cancelJob: async (id) => (await import('../mediaJobQueue/index.js')).cancelJob(id),
  // Resolves with the job once it reaches a terminal state (the queue's own
  // events; an already-finished job resolves at once).
  waitForJob: async (jobId, { timeoutMs }) => {
    const { getJob, mediaJobEvents } = await import('../mediaJobQueue/index.js');
    return new Promise((resolve, reject) => {
      const settle = (job) => {
        cleanup();
        resolve(job);
      };
      const onEvent = (job) => { if (job?.id === jobId) settle(job); };
      const timer = setTimeout(() => {
        cleanup();
        reject(fail(504, 'LOCAL_SONG_TIMEOUT', 'The local song did not finish rendering in time', { jobId }));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        for (const status of TERMINAL) mediaJobEvents.off(status, onEvent);
      };
      for (const status of TERMINAL) mediaJobEvents.on(status, onEvent);
      const current = getJob(jobId);
      if (current && TERMINAL.includes(current.status)) settle(current);
    });
  },
  sleep: defaultSleep,
};

/**
 * Pick the local engine for a song: a lyric-capable one when the song has
 * vocals, otherwise any — among the engines this host can actually run now.
 * When `engineId` is specified, verifies it exists, is healthy, and can sing lyrics.
 */
async function pickLocalSongEngine({ instrumental, engineId = null }, deps = {}) {
  const { listEngines, isEngineHealthy } = { ...defaults, ...deps };
  const rawEngines = await listEngines();
  const engines = Array.isArray(rawEngines) ? rawEngines : Object.values(rawEngines || {});

  if (engineId) {
    const specified = engines.find((e) => e.id === engineId);
    if (!specified) {
      throw fail(400, 'LOCAL_SONG_UNKNOWN_ENGINE', `Local music engine '${engineId}' is not installed or recognized`);
    }
    const healthy = await isEngineHealthy(specified.id);
    if (!healthy) {
      throw fail(409, 'LOCAL_SONG_ENGINE_UNHEALTHY', `Selected local music engine '${specified.name || specified.id}' is not ready — check its install in Music Studio`);
    }
    if (!instrumental && specified.lyrics !== true) {
      throw fail(409, 'LOCAL_SONG_ENGINE_NO_LYRICS', `Selected local music engine '${specified.name || specified.id}' cannot sing lyrics — make the song instrumental or select a lyric-capable engine (e.g. ACE-Step)`);
    }
    return specified;
  }

  const healthy = [];
  for (const engine of engines) {
    if (await isEngineHealthy(engine.id)) healthy.push(engine);
  }
  const picked = (instrumental ? healthy : healthy.filter((e) => e.lyrics === true))[0];
  if (picked) return picked;
  throw fail(409, 'LOCAL_SONG_NO_ENGINE', instrumental || !healthy.length
    ? 'No local music engine is ready — install one in Music Studio, or use the Suno source'
    : 'No ready local music engine can sing lyrics — install a lyric-capable one (e.g. ACE-Step) in Music Studio, make the song instrumental, or use the Suno source');
}

/** The render window for an engine: automatic when it supports that, else a full song clamped to its limits. */
const durationFor = (engine) => (engine.autoDuration
  ? { durationMode: 'auto' }
  : { durationSec: Math.max(engine.minDurationSec ?? 1, Math.min(LOCAL_SONG_TARGET_SEC, engine.maxDurationSec ?? LOCAL_SONG_TARGET_SEC)) });

/**
 * Render one song and wait for its audio to land on `trackId`.
 *
 * `prompt` is the musical description; `lyrics` is ignored for an instrumental.
 * Resolves to `{ trackId, filename, jobId }`. `jobId` (a previous attempt's
 * queued render) is rejoined while it is still live or finished.
 */
export async function generateLocalSong({
  trackId, title, prompt, lyrics = '', instrumental = false, jobId = null, localMusic = null, onSubmitted,
}, overrides = {}) {
  const deps = { ...defaults, ...overrides };
  const { timeoutMs = LOCAL_SONG_TIMEOUT_MS } = overrides;

  const existing = await deps.getTrack(trackId);
  if (!existing) throw fail(404, 'NOT_FOUND', 'The song track was removed before its audio rendered');
  if (existing.audioFilename) return { trackId, filename: existing.audioFilename, jobId };

  if (localMusic?.type === 'code') {
    if (localMusic.language === 'supercollider') {
      const status = await deps.getSuperColliderStatus().catch(() => ({ ready: false, message: 'Status check failed' }));
      if (!status?.ready) {
        throw fail(409, 'LOCAL_SONG_SUPERCOLLIDER_UNAVAILABLE', `SuperCollider is not ready: ${status?.message || 'runtime unavailable'} — check its install in Music Studio`);
      }
      const codeJobId = jobId || `sc-${randomUUID()}`;
      await onSubmitted?.(codeJobId);
      const codeResult = await deps.writeMusicCode({
        description: prompt,
        lyrics: instrumental ? '' : lyrics,
        language: 'supercollider',
      });
      const preview = await deps.renderSuperColliderSource({
        jobId: codeJobId,
        source: codeResult.code,
        durationSec: Math.min(LOCAL_SONG_TARGET_SEC, 120),
        seed: Math.floor(Math.random() * 100000),
      });
      const saved = await deps.saveSuperColliderTakeToTrack({
        trackId,
        jobId: preview.jobId,
        prompt,
        title,
      });
      return { trackId, filename: saved.filename, jobId: codeJobId };
    }
    throw fail(400, 'LOCAL_SONG_BROWSER_CODE_ENGINE',
      `${localMusic.language === 'tonejs' ? 'Tone.js' : 'Strudel'} music code requires an interactive browser session to synthesize audio — select SuperCollider or an Audio Model for autonomous runs`);
  }

  let job = jobId ? await deps.getJob(jobId) : null;
  if (!job || job.status === 'failed' || job.status === 'canceled') {
    const engine = await pickLocalSongEngine({ instrumental, engineId: localMusic?.engine || null }, deps);
    const queued = await deps.queueGeneration({
      prompt: trimTo(prompt, 8000),
      ...(instrumental || !lyrics ? {} : { lyrics: trimTo(lyrics, 20000) }),
      instrumentalOnly: instrumental,
      engine: engine.id,
      ...durationFor(engine),
      trackId,
      title: trimTo(title, 200) || undefined,
    });
    jobId = queued.jobId;
    await onSubmitted?.(jobId);
    console.log(`🎵 Autonomous music video queued a local song on ${engine.id} (job ${String(jobId).slice(0, 8)})`);
  }

  job = await deps.waitForJob(jobId, { timeoutMs }).catch(async (err) => {
    // Give up on the render too, or it keeps the GPU busy behind the next scheduled run.
    if (err.code === 'LOCAL_SONG_TIMEOUT') await deps.cancelJob(jobId).catch(() => {});
    throw err;
  });
  if (job.status !== 'completed') {
    throw fail(502, 'LOCAL_SONG_FAILED', `The local song ${job.status === 'canceled' ? 'was canceled' : 'failed to render'}${job.error ? `: ${trimTo(job.error, 300)}` : ''}`, { jobId });
  }
  const filename = job.result?.filename;
  for (let i = 0; i < ATTACH_POLLS; i += 1) {
    const track = await deps.getTrack(trackId);
    if (track?.audioFilename && (!filename || track.audioFilename === filename)) return { trackId, filename: track.audioFilename, jobId };
    await deps.sleep(ATTACH_POLL_MS);
  }
  throw fail(504, 'LOCAL_SONG_ATTACH_TIMEOUT', 'The local song rendered but did not reach its track', { jobId, filename });
}
