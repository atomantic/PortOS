/**
 * Generated soundtrack for a finished Fast HTML animation. The animation code is
 * never re-run: one Music-library track is rendered by a local music engine at
 * the film's length and becomes the job's audio, which the preview and the
 * frame-exact export (muxed) already read from `job.audioUrl`.
 *
 * The track is created before the render so regenerating reuses it (each take
 * lands as a render on that track) and the Music Studio completion hook files
 * the audio on it. The job's audio is resolved from the track on read, so no
 * second completion hook has to order itself after the Music Studio one.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { emitCodeAnimationChanged } from '../socket.js';
import { getCodeAnimationJobRecord, isCodeAnimationJobId, saveCodeAnimationJobRecord } from './jobStore.js';

const fail = (status, code, message, context) => new ServerError(message, { status, code, ...(context ? { context } : {}) });

const defaults = {
  getEngine: async (id) => (await import('../pipeline/musicGen.js')).ENGINES[id] || null,
  isEngineHealthy: async (id) => (await import('../pipeline/musicGen.js')).isEngineHealthy(id),
  getTrack: async (id) => (await import('../tracks/index.js')).getTrack(id),
  createTrack: async (input) => (await (await import('../trackAlbumMembership.js')).createTrackWithAlbum(input, { preserveUnassigned: true })).track,
  queueGeneration: async (body) => (await import('../musicGeneration.js')).queueMusicGeneration(body),
};

// One request per animation at a time; the queue's own per-track duplicate
// check covers a render that is already queued.
const starting = new Set();

const trackAudioUrl = (track) => `/data/music/${encodeURIComponent(track.audioFilename)}`;

/** The job with its generated soundtrack (once rendered) as the audio. */
export async function withGeneratedSoundtrack(job, deps = {}) {
  const trackId = job?.soundtrack?.trackId;
  if (!trackId) return job;
  const { getTrack } = { ...defaults, ...deps };
  const track = await getTrack(trackId).catch(() => null);
  if (!track?.audioFilename) return job;
  return {
    ...job,
    audioUrl: trackAudioUrl(track),
    input: {
      ...job.input,
      audio: {
        source: 'track',
        trackId: track.id,
        label: track.title || 'Soundtrack',
        durationSeconds: track.durationSec ?? null,
        notes: job.input?.audio?.trackId === track.id ? job.input.audio.notes || '' : '',
      },
      soundtrack: 'none',
    },
  };
}

/**
 * Queue a soundtrack render for a completed animation. Resolves to the updated
 * job's `soundtrack` record: `{ trackId, mediaJobId, engine, modelId, prompt,
 * instrumentalOnly, durationSec, requestedAt }`.
 */
export async function startCodeAnimationSoundtrack(id, request, overrides = {}) {
  const deps = { ...defaults, ...overrides };
  const job = isCodeAnimationJobId(id) ? await getCodeAnimationJobRecord(id) : null;
  if (!job) throw fail(404, 'NOT_FOUND', 'Code Animation job not found');
  if (job.status !== 'completed') throw fail(409, 'NOT_COMPLETED', 'Generate audio once the animation has finished');
  if (starting.has(id)) throw fail(409, 'CODE_ANIMATION_SOUNDTRACK_BUSY', 'A soundtrack for this animation is already starting');

  const engine = await deps.getEngine(request.engine);
  if (!engine) throw fail(400, 'PIPELINE_MUSIC_UNKNOWN_ENGINE', `Unknown music engine: ${request.engine}`);
  const filmSec = Math.ceil(Number(job.frame?.durationSeconds) || 0);
  if (!filmSec) throw fail(409, 'CODE_ANIMATION_NO_DURATION', 'This animation has no recorded duration');
  if (Number.isFinite(engine.maxDurationSec) && filmSec > engine.maxDurationSec) {
    throw fail(400, 'CODE_ANIMATION_SOUNDTRACK_TOO_LONG',
      `The film is ${filmSec}s; ${engine.name} renders at most ${engine.maxDurationSec}s. Pick a model that renders ${filmSec}s or more.`,
      { filmSec, maxDurationSec: engine.maxDurationSec });
  }
  if (!await deps.isEngineHealthy(engine.id)) {
    throw fail(409, 'CODE_ANIMATION_SOUNDTRACK_ENGINE_NOT_READY', `${engine.name} is not installed yet. Install it in Music › Generate, or pick another model.`);
  }
  const durationSec = Math.max(engine.minDurationSec ?? 1, filmSec);

  starting.add(id);
  try {
    const existing = job.soundtrack?.trackId ? await deps.getTrack(job.soundtrack.trackId).catch(() => null) : null;
    const track = existing || await deps.createTrack({ title: `${job.title || 'Code animation'} soundtrack`.slice(0, 200) });
    const queued = await deps.queueGeneration({
      trackId: track.id,
      prompt: request.prompt,
      instrumentalOnly: request.instrumentalOnly,
      engine: engine.id,
      ...(request.modelId ? { modelId: request.modelId } : {}),
      durationSec,
    });
    const now = new Date().toISOString();
    const soundtrack = {
      trackId: track.id,
      mediaJobId: queued.jobId,
      engine: engine.id,
      modelId: request.modelId || null,
      prompt: request.prompt,
      instrumentalOnly: request.instrumentalOnly,
      durationSec,
      requestedAt: now,
    };
    // Re-read so a field written while the render was being queued survives.
    const latest = await getCodeAnimationJobRecord(id) || job;
    await saveCodeAnimationJobRecord({ ...latest, soundtrack, updatedAt: now });
    emitCodeAnimationChanged(id);
    console.log(`🎵 Code animation ${id.slice(0, 8)} soundtrack queued on ${engine.id} (${durationSec}s) as ${queued.jobId}`);
    return soundtrack;
  } finally {
    starting.delete(id);
  }
}
