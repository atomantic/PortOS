import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSE_CLEANUP_DELAY_MS } from '../../lib/sseUtils.js';
import { acquireBackupSnapshotCut } from '../../lib/backupSnapshotBoundary.js';

let voiceProfilesRoot = '';
const queryMock = vi.fn();

// Both overrides default to null = "use the real thing". The runner's own
// publication contract is covered in scripts/qwen3_tts_runner.test.js; these
// lifecycle cases script its stdout frames instead of training a model.
let spawnOverride = null;
let runtimeOverride = null;

// Every sidecar write is recorded when it is ATTEMPTED, so a test can tell a write
// held behind backup admission from one that is merely still in flight.
const sidecarWrites = [];
vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, atomicWrite: (path, ...rest) => { sidecarWrites.push(path); return actual.atomicWrite(path, ...rest); } };
});
vi.mock('../../lib/db.js', () => ({ query: (...args) => queryMock(...args) }));
vi.mock('../../lib/paths.js', async () => {
  const actual = await vi.importActual('../../lib/paths.js');
  return { ...actual, PATHS: { ...actual.PATHS, get voiceProfiles() { return voiceProfilesRoot; } } };
});
vi.mock('../../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => (spawnOverride ? spawnOverride(...args) : actual.spawn(...args)) };
});
vi.mock('./qwen3TtsRuntime.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getQwen3RuntimeStatus: async () => runtimeOverride ?? actual.getQwen3RuntimeStatus() };
});

const { fineTuningEvents } = await import('./fineTuningEvents.js');
const {
  validateFineTuningDataset,
  listFineTuningJobs,
  startFineTuningJob,
  getFineTuningJobStatus,
  cancelFineTuningJob,
  promoteCheckpoint,
} = await import('./fineTuning.js');

const PROFILE = {
  id: 'voice-profile-ft',
  version: 1,
  binding: { universeId: 'universe-1', characterId: 'character-1' },
  kind: 'cloned',
  engine: 'qwen3-tts',
  voiceId: 'qwen3:test',
  modelRevision: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
  sourceAssets: [{
    filename: 'sample.wav',
    sha256: 'a'.repeat(64),
    transcript: 'Training transcription sample.',
    performerConsentConfirmed: true,
    rightsConfirmedAt: '2026-08-29T00:00:00.000Z',
  }],
  routes: { studio: { enabled: true }, interactive: { enabled: false } },
  delivery: { rate: 1, pitchSemitones: null, formantSemitones: null },
  mastering: { chain: ['preset-output:unprocessed'] },
  approval: { status: 'draft', approvedAt: null, benchmarkRevision: 1 },
};

beforeEach(async () => {
  voiceProfilesRoot = await mkdtemp(join(tmpdir(), 'portos-voice-profiles-'));
  queryMock.mockReset();
  spawnOverride = null;
  runtimeOverride = null;
});

afterEach(async () => {
  // Every case drains its job record first (see `drainJobRecord`); maxRetries
  // stays as a backstop for a case that never started a run at all.
  await rm(voiceProfilesRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const seedSourceAudio = async () => {
  const sourceDir = join(voiceProfilesRoot, PROFILE.id, 'source');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'sample.wav'), Buffer.from('RIFFdata'));
};

const jobRecordPath = (jobId) => join(voiceProfilesRoot, PROFILE.id, 'fine-tune', jobId, 'job.json');

/**
 * A child-process double whose frames the TEST decides, so lifecycle assertions
 * are driven by the state machine rather than by however long a real Python
 * interpreter needs to start on a contended CI worker (#6268).
 *
 * It models node's abort contract exactly — `error` with an AbortError on the
 * next tick, then `close(null, 'SIGTERM')` — because that ordering is what
 * decides whether a cancelled job settles as 'cancelled' or 'failed'.
 */
const createScriptedChild = ({ signal } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  // Frames mirror the runner's stdout contract (scripts/qwen3_tts_runner.py);
  // they describe the contract a real training adapter must emit.
  child.emitFrames = (...frames) => {
    for (const frame of frames) {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
    }
  };
  child.exit = (code = 0, signal = null) => child.emit('close', code, signal);
  signal?.addEventListener('abort', () => {
    child.kill('SIGTERM');
    process.nextTick(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      child.emit('error', err);
      child.emit('close', null, 'SIGTERM');
    });
  }, { once: true });
  return child;
};

const BASE_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
const jobDir = (jobId) => join(voiceProfilesRoot, PROFILE.id, 'fine-tune', jobId);
const revisionFor = (step) => `${BASE_MODEL}@${'a'.repeat(40)}+sha256.${String(step).padStart(64, '0')}`;

// A sealed, auditioned checkpoint as the runner publishes it: inside the job's
// directory, with the digest-bound revision promotion records.
const checkpointFrame = (jobId, step) => ({
  stage: 'checkpoint',
  step,
  checkpoint: `checkpoint-step-${step}`,
  checkpoint_path: join(jobDir(jobId), `checkpoint-step-${step}`),
  sample_wav: join(jobDir(jobId), `checkpoint-step-${step}`, 'audition.wav'),
  loss: 0.42,
  model_revision: revisionFor(step),
});

const READY_RUNTIME = Object.freeze({
  ok: true,
  pythonPath: '/scripted/python',
  trainingAdapter: 'qwen-tts-sft-12hz',
  models: { [BASE_MODEL]: { downloaded: true } },
});

/** Install a scripted child and hand the test the handle spawn will return. */
const useScriptedRunner = () => {
  runtimeOverride = READY_RUNTIME;
  let child = null;
  spawnOverride = (_command, args, options) => {
    child = createScriptedChild(options);
    child.args = args;
    return child;
  };
  // The job's spawn happens inside startFineTuningJob, so resolve lazily.
  return () => child;
};

/**
 * Wait for the run's terminal sidecar AND for the per-job write chain behind it
 * to drain, so the temp-dir teardown never races an in-flight `atomicWrite`.
 *
 * A terminal status alone is not proof: `persistJob` snapshots at QUEUE time, so
 * a checkpoint write queued before the terminal one can serialize an already
 * terminal status. The finalize write is the last the chain can take (`close`
 * only fires once stdout is done), so bytes that stop changing mean drained.
 */
const drainJobRecord = async (jobId, { timeout = 5_000 } = {}) => {
  const record = await vi.waitFor(async () => {
    const parsed = JSON.parse(await readFile(jobRecordPath(jobId), 'utf8'));
    expect(parsed.status).not.toBe('running');
    return parsed;
  }, { timeout, interval: 20 });

  let previous = await readFile(jobRecordPath(jobId), 'utf8');
  await vi.waitFor(async () => {
    const bytes = await readFile(jobRecordPath(jobId), 'utf8');
    const prior = previous;
    previous = bytes;
    expect(bytes).toBe(prior);
  }, { timeout, interval: 20 });

  return record;
};

describe('fineTuning', () => {
  it('validates dataset readiness and checks source recordings', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();

    const result = await validateFineTuningDataset(PROFILE.id);
    expect(result.ready).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.transcriptsCount).toBe(1);
  });

  it('runs fine tuning lifecycle, emits checkpoints, and promotes checkpoint', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    const scripted = useScriptedRunner();

    const startRes = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 2,
      checkpointInterval: 20,
    });
    expect(startRes).toMatchObject({ jobId: expect.any(String), status: 'running' });

    const child = scripted();
    // The runner receives the verified model root and a dataset manifest that
    // pairs each transcribed recording with its text.
    const argValue = (flag) => child.args[child.args.indexOf(flag) + 1];
    expect(argValue('--model-id')).toBe(BASE_MODEL);
    expect(argValue('--models-dir')).toEqual(expect.any(String));
    expect(JSON.parse(await readFile(argValue('--dataset-manifest'), 'utf8'))).toEqual({
      speaker: 'portos_voice',
      reference_audio: join(voiceProfilesRoot, PROFILE.id, 'source', 'sample.wav'),
      samples: [{ audio: join(voiceProfilesRoot, PROFILE.id, 'source', 'sample.wav'), text: 'Training transcription sample.' }],
    });
    child.emitFrames(
      { stage: 'training', step: 20, total_steps: 100, loss: 1.2, progress: 20 },
      checkpointFrame(startRes.jobId, 20),
      // Frames that were not sealed inside this job are never indexed.
      { ...checkpointFrame(startRes.jobId, 40), checkpoint_path: '/elsewhere/checkpoint-step-40' },
      { ...checkpointFrame(startRes.jobId, 60), model_revision: 'qwen3-tts:checkpoint-60' },
      checkpointFrame(startRes.jobId, 100),
      { stage: 'completed', checkpoints: 2 },
    );
    child.exit(0);

    const record = await drainJobRecord(startRes.jobId);
    expect(record.status).toBe('completed');

    const status = await getFineTuningJobStatus(startRes.jobId, PROFILE.id);
    expect(status.status).toBe('completed');
    expect(status.progress).toBe(100);
    expect(status.step).toBe(20);
    expect(status.totalSteps).toBe(100);
    expect(status.checkpoints.map((checkpoint) => checkpoint.step)).toEqual([20, 100]);
    expect(status.checkpoints[0]).toMatchObject({
      id: 'checkpoint-step-20',
      step: 20,
      checkpointPath: join(jobDir(startRes.jobId), 'checkpoint-step-20'),
      sampleWav: join(jobDir(startRes.jobId), 'checkpoint-step-20', 'audition.wav'),
      modelRevision: revisionFor(20),
    });

    const promoteRes = await promoteCheckpoint({
      profileId: PROFILE.id,
      jobId: startRes.jobId,
      checkpointId: status.checkpoints[0].id,
    });
    expect(promoteRes).toMatchObject({
      kind: 'fine-tuned',
      approval: { status: 'approved' },
      modelRevision: revisionFor(20),
      inference: { checkpointPath: join(jobDir(startRes.jobId), 'checkpoint-step-20') },
    });
  });

  it('lists a checkpoint in job.json only after an open backup cut releases (#9982)', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    const scripted = useScriptedRunner();
    const { jobId } = await startFineTuningJob({ profileId: PROFILE.id, epochs: 2, checkpointInterval: 20 });
    const readCheckpoints = async () => JSON.parse(await readFile(jobRecordPath(jobId), 'utf8')).checkpoints;
    expect(await readCheckpoints()).toEqual([]);
    const writesBefore = sidecarWrites.length;

    // The runner sealed checkpoint 20 while a snapshot was copying this run's
    // directory. The record naming it must wait, or the snapshot would list a
    // checkpoint whose bytes it copied before they existed.
    const release = await acquireBackupSnapshotCut();
    scripted().emitFrames(checkpointFrame(jobId, 20));
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(sidecarWrites).toHaveLength(writesBefore);
    expect(await readCheckpoints()).toEqual([]);

    release();
    await vi.waitFor(async () => expect((await readCheckpoints()).map((c) => c.step)).toEqual([20]));
    scripted().exit(0);
    await drainJobRecord(jobId);
  });

  it('settles a cancelled job as cancelled even though the abort also fires an error', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    const scripted = useScriptedRunner();

    const startRes = await startFineTuningJob({ profileId: PROFILE.id, epochs: 50 });
    scripted().emitFrames(checkpointFrame(startRes.jobId, 50));

    const cancelRes = cancelFineTuningJob(startRes.jobId);
    expect(cancelRes).toMatchObject({ ok: true, jobId: startRes.jobId, status: 'cancelled' });
    // The abort has to reach the child, or a cancelled run leaves an orphaned
    // trainer burning the machine for the rest of its epochs.
    expect(scripted().kill).toHaveBeenCalled();

    // The AbortError arrives AFTER cancel wrote 'cancelled'. Without the
    // first-terminal-event guard it overwrites the outcome with 'failed', both
    // in memory and in the sidecar the operator reads after a restart.
    const record = await drainJobRecord(startRes.jobId);
    expect(record.status).toBe('cancelled');
    expect(record.error).toBe('Cancelled by user');
    expect(record.checkpoints).toHaveLength(1);
    expect((await getFineTuningJobStatus(startRes.jobId, PROFILE.id)).status).toBe('cancelled');
  });

  it('reports an abnormal exit by its code, or by the signal that killed it', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    const scripted = useScriptedRunner();

    const exited = await startFineTuningJob({ profileId: PROFILE.id, epochs: 2 });
    scripted().exit(3);
    expect(await drainJobRecord(exited.jobId)).toMatchObject({
      status: 'failed',
      error: 'Process exited with code 3',
    });

    // The runner's structured, path-free failure is what the operator sees.
    const refused = await startFineTuningJob({ profileId: PROFILE.id, epochs: 2 });
    scripted().stderr.emit('data', Buffer.from(`${JSON.stringify({
      ok: false, code: 'QWEN3_TRAINING_FAILED', error: 'No fine-tuned checkpoint passed its reload audition',
    })}\n`));
    scripted().exit(1);
    expect(await drainJobRecord(refused.jobId)).toMatchObject({
      status: 'failed',
      error: 'No fine-tuned checkpoint passed its reload audition',
    });

    // A killed child reports a null code; "exited with code null" tells the
    // operator nothing about an OOM reap partway through a long run.
    const killed = await startFineTuningJob({ profileId: PROFILE.id, epochs: 2 });
    scripted().exit(null, 'SIGKILL');
    expect(await drainJobRecord(killed.jobId)).toMatchObject({
      status: 'failed',
      error: 'Process terminated by signal SIGKILL',
    });
  });

  it('pushes status changes, sealed checkpoints and throttled progress for the Voice Lab (#10400)', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    const scripted = useScriptedRunner();
    const frames = [];
    const onUpdated = (frame) => frames.push(frame);
    fineTuningEvents.on('updated', onUpdated);
    try {
      const { jobId, job } = await startFineTuningJob({ profileId: PROFILE.id, epochs: 2, checkpointInterval: 20 });
      // The start response carries the same projection the event does.
      expect(job).toMatchObject({ id: jobId, status: 'running', checkpoints: [] });
      expect(frames.at(-1)).toMatchObject({ profileId: PROFILE.id, job: { id: jobId, status: 'running' } });

      // Two steps in one burst: the first is pushed, the second is throttled.
      const before = frames.length;
      scripted().emitFrames(
        { stage: 'training', step: 10, total_steps: 100, loss: 1.5, progress: 10 },
        { stage: 'training', step: 11, total_steps: 100, loss: 1.4, progress: 11 },
      );
      expect(frames.slice(before).map((frame) => frame.job.step)).toEqual([10]);

      scripted().emitFrames(checkpointFrame(jobId, 20));
      expect(frames.at(-1).job.checkpoints).toEqual([expect.objectContaining({
        id: 'checkpoint-step-20',
        auditionUrl: `/data/voice-profiles/${PROFILE.id}/fine-tune/${jobId}/checkpoint-step-20/audition.wav`,
        promotable: true,
        promotionBlockedReason: null,
      })]);

      // Cancel is scoped to the profile that owns the run.
      expect(() => cancelFineTuningJob(jobId, 'other-profile')).toThrow(/not found/i);
      expect(cancelFineTuningJob(jobId, PROFILE.id).job.status).toBe('cancelled');
      expect(frames.at(-1).job.status).toBe('cancelled');

      await drainJobRecord(jobId);
      expect(frames.at(-1).job).toMatchObject({ status: 'cancelled', checkpoints: [expect.any(Object)] });
    } finally {
      fineTuningEvents.off('updated', onUpdated);
    }
  });

  it('lists a profile\'s runs newest first from their sidecars, flagging lost and unverified ones', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    expect(await listFineTuningJobs(PROFILE.id)).toEqual([]);

    const seedRecord = async (jobId, record) => {
      await mkdir(jobDir(jobId), { recursive: true });
      if (record !== undefined) await writeFile(jobRecordPath(jobId), typeof record === 'string' ? record : JSON.stringify(record));
    };
    const older = '11111111-2222-4333-8444-555555555555';
    const newer = '22222222-2222-4333-8444-555555555555';
    await seedRecord(older, {
      id: older, profileId: PROFILE.id, status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
      // A legacy placeholder: no producing adapter, no sealed revision.
      checkpoints: [{ id: 'checkpoint-20.safetensors', step: 20, checkpointPath: '/legacy/checkpoint-20.safetensors' }],
    });
    // The server restarted mid-run: the sidecar still says running.
    await seedRecord(newer, {
      id: newer, profileId: PROFILE.id, status: 'running', startedAt: '2026-02-01T00:00:00.000Z',
      trainingAdapter: 'qwen-tts-sft-12hz', checkpoints: [],
    });
    await seedRecord('33333333-2222-4333-8444-555555555555', '{ truncated');
    await seedRecord('not-a-job');

    const jobs = await listFineTuningJobs(PROFILE.id);
    expect(jobs.map((job) => [job.id, job.status])).toEqual([[newer, 'interrupted'], [older, 'completed']]);
    expect(jobs[0].error).toMatch(/server restarted/);
    expect(jobs[1].checkpoints[0]).toMatchObject({
      promotable: false,
      promotionBlockedReason: 'Checkpoint was not produced by a supported training adapter',
      auditionUrl: null,
    });
    // Reported, never rewritten.
    expect(JSON.parse(await readFile(jobRecordPath(newer), 'utf8')).status).toBe('running');
  });

  it('refuses a second concurrent run of the same voice before spawning it', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    useScriptedRunner();
    const spawned = [];
    const scriptedSpawn = spawnOverride;
    // No abort wiring: this test decides when an aborted trainer actually exits.
    spawnOverride = (command, args, options) => {
      const child = scriptedSpawn(command, args, { ...options, signal: undefined });
      spawned.push(child);
      return child;
    };

    // Two overlapping starts: exactly one becomes a run.
    const results = await Promise.allSettled([
      startFineTuningJob({ profileId: PROFILE.id, epochs: 2 }),
      startFineTuningJob({ profileId: PROFILE.id, epochs: 2 }),
    ]);
    const started = results.filter((result) => result.status === 'fulfilled');
    expect(started).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason)
      .toMatchObject({ status: 409, code: 'FINE_TUNE_ALREADY_RUNNING' });
    await expect(startFineTuningJob({ profileId: PROFILE.id, epochs: 2 }))
      .rejects.toMatchObject({ status: 409, code: 'FINE_TUNE_ALREADY_RUNNING' });
    expect(spawned).toHaveLength(1);

    // A cancel reports `cancelled` at once, but the aborted trainer may still
    // hold the GPU until it exits, so the voice stays busy until then.
    const cancelled = cancelFineTuningJob(started[0].value.jobId, PROFILE.id);
    expect(cancelled.job).toMatchObject({ status: 'cancelled', processActive: true });
    await expect(startFineTuningJob({ profileId: PROFILE.id, epochs: 2 }))
      .rejects.toMatchObject({ status: 409, code: 'FINE_TUNE_ALREADY_RUNNING' });
    expect(spawned).toHaveLength(1);

    // Once the child has exited the voice can train again.
    spawned[0].exit(null, 'SIGTERM');
    await drainJobRecord(started[0].value.jobId);
    const next = await startFineTuningJob({ profileId: PROFILE.id, epochs: 2 });
    expect(spawned).toHaveLength(2);
    expect(next.job.processActive).toBe(true);
    expect((await getFineTuningJobStatus(started[0].value.jobId, PROFILE.id)).processActive).toBe(false);
    spawned[1].exit(0);
    await drainJobRecord(next.jobId);
  });

  it('persists a job.json sidecar beside the checkpoints when the run finishes', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    const scripted = useScriptedRunner();

    const { jobId } = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 2,
      checkpointInterval: 20,
    });
    scripted().emitFrames(checkpointFrame(jobId, 100), { stage: 'completed', total_steps: 100 });
    scripted().exit(0);

    const record = await drainJobRecord(jobId);

    expect(record.status).toBe('completed');
    expect(record.id).toBe(jobId);
    expect(record.profileId).toBe(PROFILE.id);
    expect(record.checkpoints).toHaveLength(1);
    expect(record.completedAt).toEqual(expect.any(String));
    // Runtime-only handles must never reach disk.
    expect(record.controller).toBeUndefined();
    expect(record.child).toBeUndefined();
  });

  it('promotes a checkpoint from the sidecar after a restart drops the in-memory job', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    const scripted = useScriptedRunner();

    const { jobId } = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 2,
      checkpointInterval: 20,
    });
    scripted().emitFrames(checkpointFrame(jobId, 100), { stage: 'completed', total_steps: 100 });
    scripted().exit(0);
    const record = await drainJobRecord(jobId);
    expect(record.checkpoints.length).toBeGreaterThan(0);

    // A restart loses `activeJobs` entirely; the sidecar is the only record left.
    vi.resetModules();
    const restarted = await import('./fineTuning.js');

    await expect(restarted.getFineTuningJobStatus(jobId)).rejects.toThrow(/not found/i);
    const promoted = await restarted.promoteCheckpoint({
      profileId: PROFILE.id,
      jobId,
      checkpointId: record.checkpoints[0].id,
    });
    expect(promoted).toMatchObject({ kind: 'fine-tuned', approval: { status: 'approved' } });
  });

  it('reports an unreadable job record as an error rather than a missing job', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    const scripted = useScriptedRunner();

    const { jobId } = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 2,
      checkpointInterval: 20,
    });
    scripted().emitFrames({ stage: 'completed', total_steps: 100 });
    scripted().exit(0);
    await drainJobRecord(jobId);
    await writeFile(jobRecordPath(jobId), '{ truncated');

    // A corrupt record must not read as "no such job" — the checkpoints it
    // indexes are still on disk.
    vi.resetModules();
    const restarted = await import('./fineTuning.js');
    await expect(restarted.getFineTuningJobStatus(jobId, PROFILE.id))
      .rejects.toMatchObject({ code: 'JOB_RECORD_UNREADABLE' });

    // Parsing cleanly is not enough — a record without the job shape would let
    // promoteCheckpoint blow up on `job.checkpoints.find`.
    await writeFile(jobRecordPath(jobId), '{}');
    await expect(restarted.getFineTuningJobStatus(jobId, PROFILE.id))
      .rejects.toMatchObject({ code: 'JOB_RECORD_UNREADABLE' });
  });

  it('evicts the in-memory job entry after the grace window and keeps serving from disk', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
      await seedSourceAudio();
      const scripted = useScriptedRunner();

      const { jobId } = await startFineTuningJob({
        profileId: PROFILE.id,
        epochs: 2,
        checkpointInterval: 20,
      });
      scripted().emitFrames(checkpointFrame(jobId, 100), { stage: 'completed', total_steps: 100 });
      scripted().exit(0);
      await drainJobRecord(jobId);

      // Without a profileId the in-memory map is the only lookup source, so this
      // resolving proves the entry is still resident.
      expect((await getFineTuningJobStatus(jobId)).status).toBe('completed');

      await vi.advanceTimersByTimeAsync(SSE_CLEANUP_DELAY_MS + 100);
      await expect(getFineTuningJobStatus(jobId)).rejects.toThrow(/not found/i);
      expect((await getFineTuningJobStatus(jobId, PROFILE.id)).status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fineTuning without a trainable model', () => {
  it('refuses non-Base or unverified base weights before creating a job or spawning', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    spawnOverride = vi.fn();
    runtimeOverride = READY_RUNTIME;

    await expect(startFineTuningJob({ profileId: PROFILE.id, baseModel: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign' }))
      .rejects.toMatchObject({ status: 400, code: 'QWEN3_TRAINING_UNSUPPORTED_MODEL' });
    runtimeOverride = { ...READY_RUNTIME, models: { [BASE_MODEL]: { downloaded: false } } };
    await expect(startFineTuningJob({ profileId: PROFILE.id }))
      .rejects.toMatchObject({ status: 409, code: 'QWEN3_MODEL_NOT_INSTALLED' });
    expect(spawnOverride).not.toHaveBeenCalled();
    await expect(readFile(join(voiceProfilesRoot, PROFILE.id, 'fine-tune'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('fineTuning without a training adapter', () => {
  it('refuses to start before creating a job or spawning when inference is ready but training is not', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    runtimeOverride = { ok: true, pythonPath: '/scripted/python', trainingAdapter: null };
    spawnOverride = vi.fn();

    await expect(startFineTuningJob({ profileId: PROFILE.id, epochs: 2 }))
      .rejects.toMatchObject({ status: 503, code: 'QWEN3_TRAINING_UNAVAILABLE' });
    expect(spawnOverride).not.toHaveBeenCalled();
    await expect(readFile(join(voiceProfilesRoot, PROFILE.id, 'fine-tune'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never promotes a legacy placeholder checkpoint that has no producing adapter', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    const jobId = '11111111-2222-4333-8444-555555555555';
    await mkdir(join(voiceProfilesRoot, PROFILE.id, 'fine-tune', jobId), { recursive: true });
    await writeFile(jobRecordPath(jobId), JSON.stringify({
      id: jobId,
      profileId: PROFILE.id,
      universeId: 'universe-1',
      characterId: 'character-1',
      status: 'completed',
      checkpoints: [{ id: 'checkpoint-20.safetensors', step: 20, checkpointPath: '/legacy/checkpoint-20.safetensors' }],
    }));

    await expect(promoteCheckpoint({ profileId: PROFILE.id, jobId, checkpointId: 'checkpoint-20.safetensors' }))
      .rejects.toMatchObject({ status: 409, code: 'CHECKPOINT_UNVERIFIED' });

    // An adapter name alone is not enough: an unsealed checkpoint has no
    // digest-bound revision for synthesis to verify against.
    await writeFile(jobRecordPath(jobId), JSON.stringify({
      ...JSON.parse(await readFile(jobRecordPath(jobId), 'utf8')),
      trainingAdapter: 'qwen-tts-sft-12hz',
    }));
    await expect(promoteCheckpoint({ profileId: PROFILE.id, jobId, checkpointId: 'checkpoint-20.safetensors' }))
      .rejects.toMatchObject({ status: 409, code: 'CHECKPOINT_UNVERIFIED' });
    expect(queryMock.mock.calls.some(([sql]) => /insert|update/i.test(sql))).toBe(false);
  });
});
