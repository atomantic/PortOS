import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSE_CLEANUP_DELAY_MS } from '../../lib/sseUtils.js';

let voiceProfilesRoot = '';
const queryMock = vi.fn();

// Both overrides default to null = "use the real thing". The runner itself
// reports no training adapter today (scripts/qwen3_tts_runner.test.js), so the
// lifecycle cases stand in a scripted adapter and child for a future one.
let spawnOverride = null;
let runtimeOverride = null;

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

const {
  validateFineTuningDataset,
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

const checkpointFrame = (step) => ({
  stage: 'checkpoint',
  step,
  checkpoint: `checkpoint-${step}.safetensors`,
  checkpoint_path: `/scripted/checkpoint-${step}.safetensors`,
  sample_wav: `/scripted/sample-step-${step}.wav`,
  loss: 0.42,
});

/** Install a scripted child and hand the test the handle spawn will return. */
const useScriptedRunner = () => {
  runtimeOverride = { ok: true, pythonPath: '/scripted/python', trainingAdapter: 'scripted-adapter' };
  let child = null;
  spawnOverride = (_command, _args, options) => {
    child = createScriptedChild(options);
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
    child.emitFrames(
      { stage: 'init', total_steps: 100 },
      { stage: 'training', step: 20, total_steps: 100, loss: 1.2, progress: 20 },
      checkpointFrame(20),
      checkpointFrame(100),
      { stage: 'completed', total_steps: 100 },
    );
    child.exit(0);

    const record = await drainJobRecord(startRes.jobId);
    expect(record.status).toBe('completed');

    const status = await getFineTuningJobStatus(startRes.jobId, PROFILE.id);
    expect(status.status).toBe('completed');
    expect(status.progress).toBe(100);
    expect(status.step).toBe(20);
    expect(status.checkpoints).toHaveLength(2);
    expect(status.checkpoints[0]).toMatchObject({
      id: 'checkpoint-20.safetensors',
      step: 20,
      checkpointPath: '/scripted/checkpoint-20.safetensors',
      sampleWav: '/scripted/sample-step-20.wav',
    });

    const promoteRes = await promoteCheckpoint({
      profileId: PROFILE.id,
      jobId: startRes.jobId,
      checkpointId: status.checkpoints[0].id,
    });
    expect(promoteRes).toMatchObject({
      kind: 'fine-tuned',
      approval: { status: 'approved' },
      inference: { checkpointPath: '/scripted/checkpoint-20.safetensors' },
    });
  });

  it('settles a cancelled job as cancelled even though the abort also fires an error', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();
    const scripted = useScriptedRunner();

    const startRes = await startFineTuningJob({ profileId: PROFILE.id, epochs: 50 });
    scripted().emitFrames(checkpointFrame(50));

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

    // A killed child reports a null code; "exited with code null" tells the
    // operator nothing about an OOM reap partway through a long run.
    const killed = await startFineTuningJob({ profileId: PROFILE.id, epochs: 2 });
    scripted().exit(null, 'SIGKILL');
    expect(await drainJobRecord(killed.jobId)).toMatchObject({
      status: 'failed',
      error: 'Process terminated by signal SIGKILL',
    });
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
    scripted().emitFrames(checkpointFrame(100), { stage: 'completed', total_steps: 100 });
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
    scripted().emitFrames(checkpointFrame(100), { stage: 'completed', total_steps: 100 });
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
      scripted().emitFrames(checkpointFrame(100), { stage: 'completed', total_steps: 100 });
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
    expect(queryMock.mock.calls.some(([sql]) => /insert|update/i.test(sql))).toBe(false);
  });
});
