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
import { VOICE_PROFILE_BENCHMARK_LINES, renderProfileBenchmark, benchmarkProfileInteractive, completeProfileInteractiveBenchmark } from './profileBenchmarks.js';

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
  it('never qualifies rendering alone and persists actual browser playback evidence and route together', async () => {
    getVoiceProfileRequired.mockResolvedValue(PROFILE);
    synthesize.mockResolvedValue({
      wav: pcmToWavBuffer(new Float32Array(240), { sampleRate: 24000 }), firstAudioMs: 45,
      provenance: { modelRevision: 'example-model@revision' },
    });
    saveProfileBenchmark.mockClear();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const probe = await benchmarkProfileInteractive(PROFILE.id);
    expect(saveProfileBenchmark).not.toHaveBeenCalled();
    expect(probe).toMatchObject({ profileRevision: 2, audioBase64: expect.any(String) });
    await completeProfileInteractiveBenchmark(PROFILE.id, {
      benchmarkId: probe.benchmarkId, playbackLatencyMs: 1200,
    });
    expect(saveProfileBenchmark).toHaveBeenLastCalledWith(PROFILE, expect.objectContaining({
      interactiveLatencyMs: 1200, similarityScore: null, profileRevision: 2,
      interactiveMeasurement: { boundary: 'browser-playing', synthesisLatencyMs: 0, modelRevision: 'example-model@revision' },
    }), { interactive: { enabled: false, maxFirstAudioMs: 900 } });
    await expect(completeProfileInteractiveBenchmark(PROFILE.id, {
      benchmarkId: probe.benchmarkId, playbackLatencyMs: 10,
    })).rejects.toMatchObject({ code: 'VOICE_BENCHMARK_RECEIPT_INVALID' });
    const timely = await benchmarkProfileInteractive(PROFILE.id);
    await completeProfileInteractiveBenchmark(PROFILE.id, { benchmarkId: timely.benchmarkId, playbackLatencyMs: 50 });
    expect(saveProfileBenchmark).toHaveBeenLastCalledWith(PROFILE, expect.objectContaining({ interactiveLatencyMs: 50 }), {
      interactive: { enabled: true, maxFirstAudioMs: 900 },
    });
    clock.mockRestore();
  });

  it('rejects missing audio, mismatched, replaced, expired and impossible playback receipts without qualifying', async () => {
    getVoiceProfileRequired.mockResolvedValue(PROFILE);
    synthesize.mockResolvedValue({ wav: Buffer.alloc(0) });
    saveProfileBenchmark.mockClear();
    await expect(benchmarkProfileInteractive(PROFILE.id)).rejects.toMatchObject({ code: 'VOICE_BENCHMARK_NO_AUDIO' });
    synthesize.mockResolvedValue({ wav: pcmToWavBuffer(new Float32Array(240), { sampleRate: 24000 }) });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const first = await benchmarkProfileInteractive(PROFILE.id);
    await expect(completeProfileInteractiveBenchmark('another-profile', { benchmarkId: first.benchmarkId, playbackLatencyMs: 50 }))
      .rejects.toMatchObject({ code: 'VOICE_BENCHMARK_RECEIPT_INVALID' });
    const second = await benchmarkProfileInteractive(PROFILE.id);
    await expect(completeProfileInteractiveBenchmark(PROFILE.id, { benchmarkId: first.benchmarkId, playbackLatencyMs: 50 }))
      .rejects.toMatchObject({ code: 'VOICE_BENCHMARK_RECEIPT_INVALID' });
    clock.mockReturnValue(120101);
    await expect(completeProfileInteractiveBenchmark(PROFILE.id, { benchmarkId: second.benchmarkId, playbackLatencyMs: 50 }))
      .rejects.toMatchObject({ code: 'VOICE_BENCHMARK_RECEIPT_INVALID' });
    clock.mockReturnValueOnce(100).mockReturnValueOnce(200).mockReturnValue(200);
    const third = await benchmarkProfileInteractive(PROFILE.id);
    await expect(completeProfileInteractiveBenchmark(PROFILE.id, { benchmarkId: third.benchmarkId, playbackLatencyMs: 50 }))
      .rejects.toMatchObject({ code: 'VOICE_BENCHMARK_TIMING_INVALID' });
    expect(saveProfileBenchmark).not.toHaveBeenCalled();
    clock.mockRestore();
  });
});
