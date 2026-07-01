import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../pipeline/musicGen.js', () => ({
  generateMusic: vi.fn(),
}));

import { generateMusic } from '../pipeline/musicGen.js';
import { generateAudio, cancel } from './local.js';
import { audioGenEvents } from './events.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateAudio', () => {
  it('calls generateMusic and emits completed with the result merged onto generationId', async () => {
    generateMusic.mockResolvedValue({ filename: 'music-gen-x.wav', durationSec: 12, modelId: 'musicgen-medium', model: 'MusicGen Medium', engine: 'musicgen' });
    const onCompleted = vi.fn();
    audioGenEvents.once('completed', onCompleted);

    await generateAudio({ jobId: 'job-1', prompt: 'a moody synth bed', engine: 'musicgen', durationSec: 12 });

    expect(generateMusic).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a moody synth bed', engine: 'musicgen', durationSec: 12,
      signal: expect.any(AbortSignal),
      onActivity: expect.any(Function),
    }));
    expect(onCompleted).toHaveBeenCalledWith({
      generationId: 'job-1', filename: 'music-gen-x.wav', durationSec: 12,
      modelId: 'musicgen-medium', model: 'MusicGen Medium', engine: 'musicgen',
    });
  });

  it('emits failed with the error message when generateMusic throws', async () => {
    generateMusic.mockRejectedValue(new Error('runtime not found'));
    const onFailed = vi.fn();
    audioGenEvents.once('failed', onFailed);

    await generateAudio({ jobId: 'job-2', prompt: 'x' });

    expect(onFailed).toHaveBeenCalledWith({ generationId: 'job-2', error: 'runtime not found' });
  });

  it('forwards onActivity pings as audioGenEvents activity events keyed by jobId', async () => {
    let capturedOnActivity;
    generateMusic.mockImplementation(async ({ onActivity }) => {
      capturedOnActivity = onActivity;
      onActivity();
      return { filename: 'f.wav' };
    });
    const onActivityEvent = vi.fn();
    audioGenEvents.once('activity', onActivityEvent);

    await generateAudio({ jobId: 'job-3', prompt: 'x' });

    expect(capturedOnActivity).toBeInstanceOf(Function);
    expect(onActivityEvent).toHaveBeenCalledWith({ generationId: 'job-3' });
  });
});

describe('cancel', () => {
  it('aborts the in-flight generateMusic signal for a known jobId', async () => {
    let capturedSignal;
    generateMusic.mockImplementation(({ signal }) => {
      capturedSignal = signal;
      return new Promise(() => {}); // hang until aborted
    });

    const pending = generateAudio({ jobId: 'job-4', prompt: 'x' });
    // Let generateAudio's synchronous setup (controller registration) run.
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal.aborted).toBe(false);
    cancel('job-4');
    expect(capturedSignal.aborted).toBe(true);

    void pending; // never resolves in this test; not awaited intentionally
  });

  it('is a no-op for an unknown / already-settled jobId', () => {
    expect(() => cancel('no-such-job')).not.toThrow();
  });
});
