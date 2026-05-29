import { describe, it, expect } from 'vitest';
import { stripDebugMallocEnv } from './processEnv.js';

describe('stripDebugMallocEnv', () => {
  it('drops every key that starts with "Malloc"', () => {
    const out = stripDebugMallocEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      MallocStackLogging: '1',
      MallocScribble: '1',
      MallocCheckHeapEach: '100',
      MallocNanoZone: '0',
    });
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/Users/x' });
  });

  it('preserves keys that contain but do not start with "Malloc"', () => {
    const out = stripDebugMallocEnv({ MY_MallocFlag: 'keep', MallocFlag: 'drop' });
    expect(out).toEqual({ MY_MallocFlag: 'keep' });
  });

  it('returns an empty object for an empty env', () => {
    expect(stripDebugMallocEnv({})).toEqual({});
  });

  it('does not mutate the input', () => {
    const input = { PATH: '/x', MallocStackLogging: '1' };
    stripDebugMallocEnv(input);
    expect(input).toEqual({ PATH: '/x', MallocStackLogging: '1' });
  });
});
