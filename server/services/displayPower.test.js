import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  platform: 'darwin',
  spawned: [],
}));

vi.mock('os', () => ({ platform: () => state.platform }));
vi.mock('../lib/childProcess.js', () => ({
  spawn: (cmd, args) => {
    state.spawned.push({ cmd, args });
    return { on: () => {}, unref: () => {} };
  },
}));

const { sleepDisplay, wakeDisplay } = await import('./displayPower.js');

beforeEach(() => {
  state.platform = 'darwin';
  state.spawned = [];
});

describe('displayPower', () => {
  it('wakes the display after an enabled GPU workload completes', () => {
    expect(sleepDisplay({}, 'Video generation')).toBe(true);
    expect(wakeDisplay({}, 'Video generation')).toBe(true);

    expect(state.spawned).toEqual([
      { cmd: 'pmset', args: ['displaysleepnow'] },
      { cmd: 'caffeinate', args: ['-u', '-t', '5'] },
    ]);
  });

  it('does not wake a display when the workload opted out', () => {
    expect(sleepDisplay({ displaySleep: false }, 'Video generation')).toBe(false);
    expect(wakeDisplay({ displaySleep: false }, 'Video generation')).toBe(false);
    expect(state.spawned).toEqual([]);
  });
});
