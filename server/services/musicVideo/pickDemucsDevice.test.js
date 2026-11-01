import { describe, expect, it } from 'vitest';
import { _pickDemucsDevice } from './vocalSeparation.js';

describe('_pickDemucsDevice', () => {
  it('uses MPS on Apple Silicon even when Node reports x64', () => {
    expect(_pickDemucsDevice({ platform: 'darwin', arch: 'x64', appleSilicon: true })).toBe('mps');
  });

  it('uses CUDA, then CPU, when the Mac is not Apple Silicon', () => {
    expect(_pickDemucsDevice({ platform: 'darwin', arch: 'x64', appleSilicon: false, cudaAvailable: true })).toBe('cuda');
    expect(_pickDemucsDevice({ platform: 'linux', arch: 'x64', appleSilicon: false, cudaAvailable: false })).toBe('cpu');
  });
});
