import { describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({ default: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));

import { floatToPcm16, pcm16ToFloat } from './voiceRealtime';

describe('realtime PCM helpers', () => {
  it('clamps and converts float samples to PCM16 and back', () => {
    const pcm = new Int16Array(floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5])));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
    const back = pcm16ToFloat(pcm.buffer);
    expect(back[1]).toBeCloseTo(1, 3);
    expect(back[2]).toBe(-1);
  });

  it('reads PCM16 from a misaligned byte view and drops a trailing odd byte', () => {
    const bytes = new Uint8Array(7);
    new DataView(bytes.buffer).setInt16(1, 16384, true);
    expect(Array.from(pcm16ToFloat(bytes.subarray(1)))).toEqual([0.5, 0, 0]);
  });
});
