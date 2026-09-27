import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./apiVoice', () => ({ benchmarkProfileInteractive: vi.fn(), completeVoiceProfileInteractiveBenchmark: vi.fn() }));
import { benchmarkProfileInteractive, completeVoiceProfileInteractiveBenchmark } from './apiVoice';
import { prepareProfilePlayback } from './voiceProfileBenchmark';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });
const prepare = (play = vi.fn().mockResolvedValue()) => {
  const audio = new EventTarget();
  Object.assign(audio, { play, pause: vi.fn(), removeAttribute: vi.fn() });
  vi.stubGlobal('Audio', vi.fn(function () { return audio; }));
  benchmarkProfileInteractive.mockResolvedValue({ benchmark: { benchmarkId: 'probe-1', profileRevision: 2, audioBase64: 'fixture' } });
  return audio;
};

describe('profile browser playback qualification', () => {
  it('plays synchronously in the second gesture and measures both segments excluding operator wait', async () => {
    const audio = prepare();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    completeVoiceProfileInteractiveBenchmark.mockResolvedValue({ profile: { id: 'profile-1' } });
    const preparing = prepareProfilePlayback('profile-1');
    clock.mockReturnValue(300);
    const probe = await preparing;
    expect(audio.play).not.toHaveBeenCalled();
    clock.mockReturnValue(10000);
    const pending = probe.play();
    expect(audio.play).toHaveBeenCalled();
    expect(completeVoiceProfileInteractiveBenchmark).not.toHaveBeenCalled();
    clock.mockReturnValue(10250);
    audio.dispatchEvent(new Event('playing'));
    await expect(pending).resolves.toEqual({ profile: { id: 'profile-1' } });
    expect(completeVoiceProfileInteractiveBenchmark).toHaveBeenCalledWith('profile-1', {
      benchmarkId: 'probe-1', renderRequestLatencyMs: 200, playbackStartupMs: 250,
    }, undefined);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('does not qualify rejected playback or a playback timeout', async () => {
    prepare(vi.fn().mockRejectedValue(new Error('Playback denied')));
    const denied = await prepareProfilePlayback('profile-1');
    await expect(denied.play()).rejects.toThrow('Playback denied');
    expect(completeVoiceProfileInteractiveBenchmark).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const audio = prepare();
    const probe = await prepareProfilePlayback('profile-1');
    const pending = probe.play();
    const rejection = expect(pending).rejects.toThrow('Benchmark playback timed out');
    await vi.advanceTimersByTimeAsync(30000);
    await rejection;
    expect(audio.pause).toHaveBeenCalled();
    expect(completeVoiceProfileInteractiveBenchmark).not.toHaveBeenCalled();
  });
});
