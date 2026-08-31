import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  await rm(voiceProfilesRoot, { recursive: true, force: true });
});

describe('fineTuning', () => {
  it('validates dataset readiness and checks source recordings', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ data: PROFILE }] });
    const profileDir = join(voiceProfilesRoot, PROFILE.id, 'source');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'sample.wav'), Buffer.from('RIFFdata'));

    const result = await validateFineTuningDataset(PROFILE.id);
    expect(result.ready).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.transcriptsCount).toBe(1);
  });

  it('runs fine tuning lifecycle, emits checkpoints, and promotes checkpoint', async () => {
    queryMock.mockResolvedValue({ rows: [{ data: PROFILE }] });
    const profileDir = join(voiceProfilesRoot, PROFILE.id, 'source');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'sample.wav'), Buffer.from('RIFFdata'));

    const startRes = await startFineTuningJob({
      profileId: PROFILE.id,
      epochs: 2,
      checkpointInterval: 20,
    });
    expect(startRes).toMatchObject({
      jobId: expect.any(String),
      status: 'running',
    });

    await vi.waitFor(() => {
      expect(getFineTuningJobStatus(startRes.jobId).status).toBe('completed');
    }, { timeout: 5_000, interval: 20 });

    const status = getFineTuningJobStatus(startRes.jobId);
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
    const profileDir = join(voiceProfilesRoot, PROFILE.id, 'source');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'sample.wav'), Buffer.from('RIFFdata'));

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
  });
});
