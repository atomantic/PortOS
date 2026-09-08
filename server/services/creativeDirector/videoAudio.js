/** Standalone soundtrack selection over the existing music library and audio queue. */
import { canonicalSnapshotChecksum } from '../../lib/snapshotChecksum.js';
import { ServerError } from '../../lib/errorHandler.js';
import { sleep } from '../../lib/fileUtils.js';

const blocked = message => new ServerError(message, { status: 409, code: 'VIDEO_AUDIO_BLOCKED' });

export async function resolveVideoAudioChoice(project) {
  const audio = project.videoDraft?.audio || {};
  const mode = audio.mode || 'native';
  if (mode === 'silent' || mode === 'native') return { mode };
  if (mode === 'imported') {
    const { getTrack } = await import('../tracks/index.js');
    const { resolveMusicTrackPath } = await import('../pipeline/audioMux.js');
    const track = audio.trackId ? await getTrack(audio.trackId) : null;
    if (!track?.audioFilename || !await resolveMusicTrackPath(track.audioFilename)) throw blocked('Choose an existing soundtrack in Music before Start.');
    return { mode, trackId: track.id, filename: track.audioFilename };
  }
  const { ENGINES, isEngineHealthy } = await import('../pipeline/musicGen.js');
  const { hasConfiguredMediaRoute } = await import('../federatedMedia/defaultRouting.js');
  if (await hasConfiguredMediaRoute('audio')) throw blocked('Disable the standing audio route before using the selected local soundtrack engine.');
  const engine = ENGINES[audio.providerId];
  if (!engine || !await isEngineHealthy(engine.id)) throw blocked('The selected audio engine is unavailable. Configure it in Music or change the audio choice.');
  const model = audio.model || engine.defaultModelId;
  if (!engine.models.some(entry => entry.id === model)) throw blocked('Select an available model for the chosen audio engine.');
  if (!audio.prompt?.trim()) throw blocked('Describe the generated soundtrack before Start.');
  return { mode, providerId: engine.id, model, prompt: audio.prompt,
    durationSec: Math.min(engine.maxDurationSec, Math.max(engine.minDurationSec, project.targetDurationSeconds)) };
}

/** One bounded soundtrack job. A short bed loops at assembly; it never expands into a batch. */
export async function prepareVideoSoundtrack(project, isCurrent) {
  const audio = { mode: 'native', ...project.videoExecution.choices.audio };
  if (audio.mode === 'silent' || audio.mode === 'native') return null;
  const { resolveMusicTrackPath } = await import('../pipeline/audioMux.js');
  if (audio.mode === 'imported') {
    const current = await resolveVideoAudioChoice(project);
    if (current.filename !== audio.filename) throw blocked('The selected soundtrack changed. Review the new choices and Resume.');
    return { filename: audio.filename, trackId: audio.trackId };
  }
  const audioRevision = canonicalSnapshotChecksum(audio);
  if (project.musicBed?.audioRevision === audioRevision && await resolveMusicTrackPath(project.musicBed.filename)) return project.musicBed;
  const { reserveVideoAttempt, assertVideoAttemptDispatch, settleVideoAttempt } = await import('./videoExecution.js');
  const { getJob, enqueueJob } = await import('../mediaJobQueue/index.js');
  const { getProject, mutateVideoProject } = await import('./local.js');
  const key = `audio:${audioRevision}`;
  let attempt = [...(project.videoExecution.attempts || [])].reverse().find(row => row.key === key && ['submitting', 'queued', 'running', 'completed', 'uncertain'].includes(row.status));
  if (attempt?.status === 'uncertain' || (attempt?.status === 'submitting' && !attempt.jobId)) throw blocked('The previous soundtrack submission is uncertain. Reconcile it or authorize retry before Resume.');
  if (!attempt) {
    attempt = await reserveVideoAttempt(project.id, { kind: 'audio', key, expectedProductionRevision: project.videoWorkRevision || 0 });
    if (!attempt) return null;
    await assertVideoAttemptDispatch(project.id, attempt.id);
    // Persist before enqueue; the queue worker checks this receipt again.
    const { jobId } = enqueueJob({ kind: 'audio', owner: `creative-director:${project.id}`,
      params: { engine: audio.providerId, modelId: audio.model, prompt: audio.prompt, durationSec: audio.durationSec,
        videoProduction: { projectId: project.id, attemptId: attempt.id, executionId: attempt.executionId } } });
    await settleVideoAttempt(project.id, attempt.id, { status: 'queued', jobId });
    attempt = { ...attempt, jobId };
  }
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    if (!await isCurrent()) return null;
    const job = getJob(attempt.jobId);
    if (!job || ['failed', 'canceled'].includes(job.status)) throw blocked('Soundtrack generation failed or its receipt is missing. Inspect the queue, then Resume within the saved limits.');
    if (job.status === 'completed') {
      const filename = job.result?.filename;
      if (!filename || !await resolveMusicTrackPath(filename)) throw blocked('The generated soundtrack file is missing. Inspect the audio job before retrying.');
      const { listTracks, createTrack } = await import('../tracks/index.js');
      const track = (await listTracks()).find(row => row.audioFilename === filename)
        || await createTrack({ title: `${project.name} — Soundtrack`, audioFilename: filename, engine: audio.providerId, modelId: audio.model, durationSec: job.result.durationSec });
      const bed = { filename, trackId: track.id, jobId: job.id, audioRevision };
      await mutateVideoProject(project.id, current => isCurrentSnapshot(current, project) ? { project: { ...current, musicBed: bed }, result: true } : { project: current, result: false, skipPersist: true });
      return bed;
    }
    await sleep(1000);
  }
  // Keep the job receipt live; a timeout never implies it is safe to resubmit.
  const current = await getProject(project.id);
  if (isCurrentSnapshot(current, project)) throw blocked('Soundtrack generation is still running. Inspect the queue before Resume.');
  return null;
}

function isCurrentSnapshot(current, project) {
  return current?.videoExecution?.authorized && ['rendering', 'stitching'].includes(current.status)
    && (current.videoWorkRevision || 0) === (project.videoWorkRevision || 0);
}
