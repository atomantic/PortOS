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
    expect(voices).toContainEqual(expect.objectContaining({
      id: 'qwen3-tts:warm-narrator',
      voice: 'warm-narrator',
      name: 'Warm Narrator (1.7B Design)',
      label: 'Warm Narrator (1.7B Design)',
    }));
    expect(voices.every((preset) => preset.id === `qwen3-tts:${preset.voice}`)).toBe(true);
  });

  it.skipIf(!testPython)('refuses synthesis instead of returning a synthetic tone', async () => {
    await expect(synthesizeQwen3('An invented example sentence.', {
      mode: 'design', instructions: 'warm low alto',
    })).rejects.toThrow(/unavailable/);
  });
});
