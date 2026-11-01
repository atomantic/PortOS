import { describe, expect, it } from 'vitest';
import { pickDemucsDevice } from './vocalSeparation.js';

describe('pickDemucsDevice', () => {
  it('uses MPS on Apple Silicon even when Node reports x64', () => {
    expect(pickDemucsDevice({ platform: 'darwin', arch: 'x64', appleSilicon: true })).toBe('mps');
  });

  it('uses CUDA, then CPU, when the Mac is not Apple Silicon', () => {
    expect(pickDemucsDevice({ platform: 'darwin', arch: 'x64', appleSilicon: false, cudaAvailable: true })).toBe('cuda');
    expect(pickDemucsDevice({ platform: 'linux', arch: 'x64', appleSilicon: false, cudaAvailable: false })).toBe('cpu');
  });
});
