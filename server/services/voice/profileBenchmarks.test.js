import { join } from 'node:path';
import { pcmToWavBuffer } from '../../lib/chiptuneRender.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./tts.js', () => ({ synthesize: vi.fn() }));
vi.mock('./profiles.js', () => ({
  getProfileForSynthesis: vi.fn(),
  getVoiceProfileRequired: vi.fn(),
  profileArtifactDirectory: vi.fn((id) => join('/tmp', id)),
  saveProfileBenchmark: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));

import { mkdir, writeFile } from 'node:fs/promises';
import { synthesize } from './tts.js';
import {
  getProfileForSynthesis,
  getVoiceProfileRequired,
  profileArtifactDirectory,
  saveProfileBenchmark,
} from './profiles.js';
import { VOICE_PROFILE_BENCHMARK_LINES, renderProfileBenchmark, benchmarkProfileInteractive } from './profileBenchmarks.js';

const PROFILE = {
  id: 'voice-profile-1', version: 2, label: 'Example Character',
  mastering: { chain: ['preset-output:unprocessed'] },
};

describe('voice profile benchmarks', () => {
  it('renders the fixed script sequentially and records profile-scoped provenance', async () => {
    getProfileForSynthesis.mockResolvedValue(PROFILE);
    synthesize.mockResolvedValue({
      wav: Buffer.from('wav'), latencyMs: 24, engine: 'kokoro',
      provenance: { modelRevision: 'kokoro-test:q8', effectiveControls: { rate: 1 } },
    });
    saveProfileBenchmark.mockImplementation(async (_profile, benchmark) => ({ ...PROFILE, benchmark }));

    const result = await renderProfileBenchmark(PROFILE.id);

    expect(getProfileForSynthesis).toHaveBeenCalledWith(PROFILE.id, 'studio');
    expect(profileArtifactDirectory).toHaveBeenCalledWith(PROFILE.id);
    expect(mkdir).toHaveBeenCalledWith(join('/tmp', PROFILE.id, 'benchmarks', 'v2'), { recursive: true });
    expect(synthesize).toHaveBeenCalledTimes(VOICE_PROFILE_BENCHMARK_LINES.length);
    expect(synthesize).toHaveBeenNthCalledWith(1, expect.stringContaining('Example Character'), {
      profileId: PROFILE.id, route: 'studio', signal: undefined,
    });
    expect(writeFile).toHaveBeenCalledTimes(VOICE_PROFILE_BENCHMARK_LINES.length);
    expect(result.benchmark).toMatchObject({
      profileRevision: 2,
      mastering: PROFILE.mastering,
    });
    expect(result.benchmark.lines[0]).toMatchObject({
      filename: `voice-profiles/${PROFILE.id}/benchmarks/v2/01-identity.wav`, modelRevision: 'kokoro-test:q8',
    });
  });
});

describe('interactive qualification', () => {
  it('measures buffered audio availability instead of trusting fabricated engine latency', async () => {
    getVoiceProfileRequired.mockResolvedValue(PROFILE);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(1300);
    synthesize.mockResolvedValue({ wav: pcmToWavBuffer(new Float32Array(240), { sampleRate: 24000 }), firstAudioMs: 45 });
    await benchmarkProfileInteractive(PROFILE.id);
    expect(saveProfileBenchmark).toHaveBeenLastCalledWith(PROFILE, expect.objectContaining({
      interactiveLatencyMs: 1200, similarityScore: null, profileRevision: 2,
    }), { interactive: { enabled: false, maxFirstAudioMs: 900 } });
    clock.mockRestore();
  });

  it('qualifies timely audio and refuses empty output', async () => {
    getVoiceProfileRequired.mockResolvedValue(PROFILE);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(150);
    synthesize.mockResolvedValue({ wav: pcmToWavBuffer(new Float32Array(240), { sampleRate: 24000 }) });
    await benchmarkProfileInteractive(PROFILE.id);
    expect(saveProfileBenchmark).toHaveBeenLastCalledWith(PROFILE, expect.objectContaining({
      interactiveLatencyMs: 50, similarityScore: null,
    }), { interactive: { enabled: true, maxFirstAudioMs: 900 } });
    clock.mockRestore();
    saveProfileBenchmark.mockClear();
    synthesize.mockResolvedValue({ wav: Buffer.alloc(0) });
    await expect(benchmarkProfileInteractive(PROFILE.id)).rejects.toMatchObject({ code: 'VOICE_BENCHMARK_NO_AUDIO' });
    expect(saveProfileBenchmark).not.toHaveBeenCalled();
  });
});
