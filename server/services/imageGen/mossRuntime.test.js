import { describe, expect, it } from 'vitest';
import { mossHostProblem } from './mossRuntime.js';

const ENOUGH_MEMORY = 64 * 1024 ** 3;

describe('mossHostProblem', () => {
  it('refuses a real Intel Mac', () => {
    expect(mossHostProblem({
      platform: 'darwin', arch: 'x64', appleSilicon: false, osRelease: '25.0.0', memory: ENOUGH_MEMORY,
    })).toBe('MOSS Swift requires native Apple Silicon macOS.');
  });

  it('accepts Apple Silicon when Node reports x64', () => {
    expect(mossHostProblem({
      platform: 'darwin', arch: 'x64', appleSilicon: true, osRelease: '25.0.0', memory: ENOUGH_MEMORY,
    })).toBeNull();
  });

  it('refuses a non-Mac even if the caller claims Apple Silicon', () => {
    expect(mossHostProblem({
      platform: 'linux', arch: 'x64', appleSilicon: true, osRelease: '25.0.0', memory: ENOUGH_MEMORY,
    })).toBe('MOSS Swift requires native Apple Silicon macOS.');
  });
});
