import { describe, it, expect } from 'vitest';
import { resolveTestPython } from '../../lib/testHelper.js';
import { synthesizeQwen3, listQwen3Voices } from './tts-qwen3.js';

// The runner boundary is valuable when Python is installed, but Windows CI
// does not guarantee a Python runtime. Keep the deterministic preset test
// available everywhere and skip only the subprocess case when no runnable
// interpreter exists.
const testPython = resolveTestPython();

describe('tts-qwen3', () => {
  it('enumerates default Qwen3 voices', async () => {
    const voices = await listQwen3Voices();
    expect(Array.isArray(voices)).toBe(true);
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toHaveProperty('id');
  });

  it.skipIf(!testPython)('synthesizes speech with voice design and rate controls', async () => {
    const result = await synthesizeQwen3('This is a test of voice design synthesis.', {
      mode: 'design',
      instructions: 'warm low alto',
      seed: 42,
      rate: 1.1,
    });

    expect(result).toMatchObject({
      engine: 'qwen3-tts',
      effectiveControls: {
        rate: 1.1,
        seed: 42,
        instructions: 'warm low alto',
        mode: 'design',
      },
    });
    expect(result.wav).toBeInstanceOf(Buffer);
    expect(result.wav.length).toBeGreaterThan(44); // standard WAV header + data
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
