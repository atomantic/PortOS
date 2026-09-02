import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSE_CLEANUP_DELAY_MS } from '../../lib/sseUtils.js';

let voiceProfilesRoot = '';
const queryMock = vi.fn();

vi.mock('../../lib/db.js', () => ({ query: (...args) => queryMock(...args) }));
vi.mock('../../lib/paths.js', async () => {
  const actual = await vi.importActual('../../lib/paths.js');
  return { ...actual, PATHS: { ...actual.PATHS, get voiceProfiles() { return voiceProfilesRoot; } } };
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
});

afterEach(async () => {
  // maxRetries absorbs the ENOTEMPTY race with a job.json write still in flight
  // from a child that exited as the test ended.
  await rm(voiceProfilesRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const seedSourceAudio = async () => {
  const sourceDir = join(voiceProfilesRoot, PROFILE.id, 'source');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'sample.wav'), Buffer.from('RIFFdata'));
};

const jobRecordPath = (jobId) => join(voiceProfilesRoot, PROFILE.id, 'fine-tune', jobId, 'job.json');

// The sidecar is rewritten from the child's terminal handler, so every test that
// outlives a run waits for that write instead of racing the temp-dir teardown.
const waitForTerminalJobRecord = (jobId) => vi.waitFor(async () => {
  const record = JSON.parse(await readFile(jobRecordPath(jobId), 'utf8'));
  expect(record.status).not.toBe('running');
  return record;
}, { timeout: 5_000, interval: 20 });

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

    const startRes = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 2,
      checkpointInterval: 20,
    });
    expect(startRes).toMatchObject({
      jobId: expect.any(String),
      status: 'running',
    });

    await vi.waitFor(async () => {
      expect((await getFineTuningJobStatus(startRes.jobId, PROFILE.id)).status).toBe('completed');
    }, { timeout: 5_000, interval: 20 });

    await waitForTerminalJobRecord(startRes.jobId);
    const status = await getFineTuningJobStatus(startRes.jobId, PROFILE.id);
    expect(status.status).toBe('completed');
    expect(status.checkpoints.length).toBeGreaterThan(0);

    const promoteRes = await promoteCheckpoint({
      profileId: PROFILE.id,
      jobId: startRes.jobId,
      checkpointId: status.checkpoints[0].id,
    });
    expect(promoteRes).toMatchObject({
      kind: 'fine-tuned',
      approval: { status: 'approved' },
    });
  });

  it('cancels an active fine tuning job', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();

    const startRes = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 50,
    });

    const cancelRes = cancelFineTuningJob(startRes.jobId);
    expect(cancelRes).toMatchObject({
      ok: true,
      jobId: startRes.jobId,
      status: 'cancelled',
    });
    await waitForTerminalJobRecord(startRes.jobId);
  });

  it('persists a job.json sidecar beside the checkpoints when the run finishes', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();

    const { jobId } = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 2,
      checkpointInterval: 20,
    });
    await vi.waitFor(async () => {
      expect((await getFineTuningJobStatus(jobId, PROFILE.id)).status).toBe('completed');
    }, { timeout: 5_000, interval: 20 });

    const record = await waitForTerminalJobRecord(jobId);

    expect(record.status).toBe('completed');
    expect(record.id).toBe(jobId);
    expect(record.profileId).toBe(PROFILE.id);
    expect(record.checkpoints.length).toBeGreaterThan(0);
    expect(record.completedAt).toEqual(expect.any(String));
    // Runtime-only handles must never reach disk.
    expect(record.controller).toBeUndefined();
    expect(record.child).toBeUndefined();
  });

  it('promotes a checkpoint from the sidecar after a restart drops the in-memory job', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();

    const { jobId } = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 2,
      checkpointInterval: 20,
    });
    const status = await vi.waitFor(async () => {
      const current = await getFineTuningJobStatus(jobId, PROFILE.id);
      expect(current.status).toBe('completed');
      expect(current.checkpoints.length).toBeGreaterThan(0);
      return current;
    }, { timeout: 5_000, interval: 20 });
    await waitForTerminalJobRecord(jobId);

    // A restart loses `activeJobs` entirely; the sidecar is the only record left.
    vi.resetModules();
    const restarted = await import('./fineTuning.js');

    await expect(restarted.getFineTuningJobStatus(jobId)).rejects.toThrow(/not found/i);
    const promoted = await restarted.promoteCheckpoint({
      profileId: PROFILE.id,
      jobId,
      checkpointId: status.checkpoints[0].id,
    });
    expect(promoted).toMatchObject({ kind: 'fine-tuned', approval: { status: 'approved' } });
  });

  it('reports an unreadable job record as an error rather than a missing job', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    await seedSourceAudio();

    const { jobId } = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 2,
      checkpointInterval: 20,
    });
    await waitForTerminalJobRecord(jobId);
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

      const { jobId } = await startFineTuningJob({
        profileId: PROFILE.id,
        epochs: 2,
        checkpointInterval: 20,
      });
      // Without a profileId the in-memory map is the only lookup source, so this
      // resolving proves the entry is still resident.
      await vi.waitFor(async () => {
        expect((await getFineTuningJobStatus(jobId)).status).toBe('completed');
      }, { timeout: 5_000, interval: 20 });
      await waitForTerminalJobRecord(jobId);

      // The eviction timer is only scheduled once the child process closes, and
      // the sidecar can already read terminal before that (a checkpoint write
      // queued earlier serializes after the "completed" frame set the status).
      // Advancing once would then fire nothing, so keep advancing until the
      // in-memory entry is actually gone.
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(SSE_CLEANUP_DELAY_MS + 100);
        await expect(getFineTuningJobStatus(jobId)).rejects.toThrow(/not found/i);
      }, { timeout: 5_000, interval: 20 });
      expect((await getFineTuningJobStatus(jobId, PROFILE.id)).status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });
});
