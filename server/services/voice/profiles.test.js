import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
  parsePresetVoiceId,
  sanitizeVoiceProfile,
  promotePresetProfile,
  createVoiceDesignCandidate,
  createClonedVoiceCandidate,
  promoteFineTunedProfile,
  promoteVoiceProfile,
  resolveCharacterVoice,
  getProfileForSynthesis,
  profileArtifactDirectory,
  recordVoiceProfileRender,
} = await import('./profiles.js');

const PROFILE = {
  id: 'voice-profile-1',
  version: 2,
  binding: { universeId: 'universe-1', characterId: 'character-1' },
  label: 'Example Character',
  kind: 'preset',
  engine: 'kokoro',
  voiceId: 'kokoro:af_heart',
  modelRevision: 'kokoro-test:q8',
  routes: { studio: { enabled: true }, interactive: { enabled: false } },
  delivery: { rate: 0.9, pitchSemitones: null, formantSemitones: null },
  mastering: { chain: ['preset-output:unprocessed'] },
  approval: { status: 'approved', approvedAt: '2026-08-29T00:00:00.000Z', benchmarkRevision: 2 },
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

beforeEach(async () => {
  voiceProfilesRoot = await mkdtemp(join(tmpdir(), 'portos-voice-profiles-'));
  queryMock.mockReset();
});

afterEach(async () => {
  await rm(voiceProfilesRoot, { recursive: true, force: true });
});

describe('voice profile contract', () => {
  it('accepts namespaced preset engines including qwen3', () => {
    expect(parsePresetVoiceId('kokoro:af_heart')).toEqual({
      engine: 'kokoro', voice: 'af_heart', voiceId: 'kokoro:af_heart',
    });
    expect(parsePresetVoiceId('piper:en_GB-jenny_dioco-medium')).toMatchObject({ engine: 'piper' });
    expect(parsePresetVoiceId('qwen3:warm-narrator')).toEqual({
      engine: 'qwen3-tts', voice: 'warm-narrator', voiceId: 'qwen3-tts:warm-narrator',
    });
    expect(parsePresetVoiceId('unknown-engine:foo')).toBeNull();
    expect(parsePresetVoiceId('af_heart')).toBeNull();
  });

  it('keeps local binding data valid while rejecting path-like profile ids', () => {
    expect(sanitizeVoiceProfile(PROFILE)).toMatchObject({
      id: 'voice-profile-1',
      binding: { universeId: 'universe-1', characterId: 'character-1' },
      routes: { studio: { enabled: true }, interactive: { enabled: false } },
      delivery: { rate: 0.9, pitchSemitones: null, formantSemitones: null },
    });
    expect(sanitizeVoiceProfile({ ...PROFILE, id: '../outside' })).toBeNull();
    expect(sanitizeVoiceProfile({
      ...PROFILE,
      sourceAssets: [
        { filename: 'approved-reference.wav', sha256: 'A'.repeat(64) },
        { filename: '../outside.wav', sha256: 'b'.repeat(64) },
      ],
    }).sourceAssets).toEqual([{
      filename: 'approved-reference.wav', sha256: 'a'.repeat(64), transcript: null, rightsConfirmedAt: null, performerConsentConfirmed: false, licensePosture: null,
    }]);
    expect(() => profileArtifactDirectory('../outside')).toThrow(/invalid voice profile/i);
  });

  it('promotes a preset into a DB-primary local profile and creates its managed directory', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const profile = await promotePresetProfile({
      universeId: 'universe-1',
      characterId: 'character-1',
      characterName: 'Example Character',
      voiceId: 'kokoro:af_heart',
      modelRevision: 'kokoro-test:q8',
    });
    expect(profile).toMatchObject({
      version: 1,
      voiceId: 'kokoro:af_heart',
      approval: { status: 'approved', benchmarkRevision: 1 },
      routes: { studio: { enabled: true }, interactive: { enabled: true } },
      delivery: { rate: 1, pitchSemitones: null, formantSemitones: null },
    });
    const { stat } = await import('node:fs/promises');
    expect((await stat(profileArtifactDirectory(profile.id))).isDirectory()).toBe(true);
    expect(queryMock.mock.calls.at(-1)[0]).toContain('INSERT INTO voice_profiles');
  });

  it('creates voice design candidate profile as draft without altering approved profile', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const candidate = await createVoiceDesignCandidate({
      universeId: 'universe-1',
      characterId: 'character-1',
      characterName: 'Example Character',
      instructions: 'warm low alto, measured delivery',
      seed: 12345,
      rate: 1.1,
    });
    expect(candidate).toMatchObject({
      kind: 'designed',
      engine: 'qwen3-tts',
      approval: { status: 'draft', approvedAt: null },
      inference: {
        instructions: 'warm low alto, measured delivery',
        seed: 12345,
        rate: 1.1,
      },
    });
  });

  it('creates consented cloned profile with audio asset hash and validates consent requirement', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const audioBuffer = Buffer.from('RIFFmockwavheaderdata');

    // Missing consent must throw
    await expect(createClonedVoiceCandidate({
      universeId: 'universe-1',
      characterId: 'character-1',
      characterName: 'Example Character',
      audioBuffer,
      filename: 'sample.wav',
      performerConsentConfirmed: false,
    })).rejects.toThrow(/consent/i);

    const candidate = await createClonedVoiceCandidate({
      universeId: 'universe-1',
      characterId: 'character-1',
      characterName: 'Example Character',
      audioBuffer,
      filename: 'sample.wav',
      transcript: 'Spoken line here.',
      performerConsentConfirmed: true,
      licensePosture: 'consented-performance',
    });

    expect(candidate).toMatchObject({
      kind: 'cloned',
      engine: 'qwen3-tts',
      approval: { status: 'draft' },
      sourceAssets: [{
        filename: 'sample.wav',
        transcript: 'Spoken line here.',
        performerConsentConfirmed: true,
        licensePosture: 'consented-performance',
      }],
    });
    expect(candidate.sourceAssets[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('promotes fine-tuned checkpoint into an approved profile', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const profile = await promoteFineTunedProfile({
      profileId: 'profile-fine-tuned-1',
      universeId: 'universe-1',
      characterId: 'character-1',
      checkpointPath: '/path/to/checkpoint-100.safetensors',
      checkpointId: 'checkpoint-100',
      step: 100,
    });

    expect(profile).toMatchObject({
      kind: 'fine-tuned',
      engine: 'qwen3-tts',
      approval: { status: 'approved' },
      modelRevision: 'qwen3-tts:checkpoint-100',
      inference: {
        checkpointPath: '/path/to/checkpoint-100.safetensors',
      },
    });
  });

  it('prefers an approved local profile and visibly degrades to a character preset or project default', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ data: PROFILE }] });
    await expect(resolveCharacterVoice({
      universeId: 'universe-1', characterId: 'character-1', characterVoiceId: 'piper:en_GB-jenny_dioco-medium',
    })).resolves.toMatchObject({ source: 'profile', profileId: PROFILE.id, degraded: false });

    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(resolveCharacterVoice({
      universeId: 'universe-1', characterId: 'character-1', characterVoiceId: 'piper:en_GB-jenny_dioco-medium',
    })).resolves.toMatchObject({ source: 'character-preset', degraded: false });

    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(resolveCharacterVoice({ universeId: 'universe-1', characterId: 'character-1' }))
      .resolves.toMatchObject({ source: 'project-default', degraded: true });
  });

  it('reports a route-disabled approved profile as unavailable before using the portable fallback', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ data: PROFILE }] });
    await expect(resolveCharacterVoice({
      universeId: 'universe-1', characterId: 'character-1',
      characterVoiceId: 'piper:en_GB-jenny_dioco-medium', route: 'interactive',
    })).resolves.toMatchObject({
      source: 'character-preset', degraded: true, warning: expect.stringMatching(/unavailable for interactive/i),
    });
  });

  it('records dialogue lineage locally with the effective controls and timing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await recordVoiceProfileRender({
      issueId: 'iss-1', lineId: 'line-001', audioFilename: 'vo-local-profile.wav', latencyMs: 24, durationMs: 850,
      provenance: {
        profileId: PROFILE.id, profileRevision: 2, engine: 'kokoro', modelRevision: 'kokoro-test:q8',
        effectiveControls: { rate: 0.9 }, mastering: PROFILE.mastering,
      },
    });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO voice_profile_renders'), expect.arrayContaining([
      'iss-1', 'line-001', PROFILE.id, 2,
    ]));
    const saved = JSON.parse(queryMock.mock.calls[0][1][4]);
    expect(saved).toMatchObject({
      profileId: PROFILE.id,
      profileRevision: 2,
      audioFilename: 'vo-local-profile.wav',
      effectiveControls: { rate: 0.9 },
      timing: { latencyMs: 24, durationMs: 850 },
      mastering: PROFILE.mastering,
    });
  });

  it('rejects a profile on a disabled route instead of silently synthesizing it', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ data: PROFILE }] });
    await expect(getProfileForSynthesis(PROFILE.id, 'interactive'))
      .rejects.toMatchObject({ code: 'VOICE_PROFILE_ROUTE_DISABLED' });
  });
});
