import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock state so the os/child_process factories can reach it.
const h = vi.hoisted(() => ({
  platform: 'darwin',
  spawned: [], // [{ cmd, args }]
}));

vi.mock('os', () => ({ platform: () => h.platform }));
vi.mock('../../lib/childProcess.js', () => ({
  spawn: (cmd, args) => {
    h.spawned.push({ cmd, args });
    return { on: () => {}, unref: () => {} };
  },
}));

const { isDisplaySleepEnabled, sleepDisplayForVideo, wakeDisplayForVideo } = await import('./displayPower.js');

beforeEach(() => {
  h.platform = 'darwin';
  h.spawned = [];
});

describe('videoGen displayPower', () => {
  describe('isDisplaySleepEnabled', () => {
    it('is off by default on darwin (absent slice / absent flag) — opt-in, unlike LoRA training', () => {
      expect(isDisplaySleepEnabled(undefined)).toBe(false);
      expect(isDisplaySleepEnabled({})).toBe(false);
      expect(isDisplaySleepEnabled({ displaySleep: false })).toBe(false);
    });

    it('honors an explicit true', () => {
      expect(isDisplaySleepEnabled({ displaySleep: true })).toBe(true);
    });

    it('is off on non-darwin even when opted in', () => {
      h.platform = 'linux';
      expect(isDisplaySleepEnabled({ displaySleep: true })).toBe(false);
    });
  });

  describe('sleepDisplayForVideo', () => {
    it('runs `pmset displaysleepnow` only when explicitly opted in', () => {
      expect(sleepDisplayForVideo({ displaySleep: true })).toBe(true);
      expect(h.spawned).toEqual([{ cmd: 'pmset', args: ['displaysleepnow'] }]);
    });

    it('is a no-op (no spawn) by default', () => {
      expect(sleepDisplayForVideo({})).toBe(false);
      expect(h.spawned).toEqual([]);
    });

    it('is a no-op off darwin even when opted in', () => {
      h.platform = 'win32';
      expect(sleepDisplayForVideo({ displaySleep: true })).toBe(false);
      expect(h.spawned).toEqual([]);
    });
  });

  describe('wakeDisplayForVideo', () => {
    it('runs `caffeinate -u -t 5` when opted in', () => {
      expect(wakeDisplayForVideo({ displaySleep: true })).toBe(true);
      expect(h.spawned).toEqual([{ cmd: 'caffeinate', args: ['-u', '-t', '5'] }]);
    });

    it('is a no-op by default (so we never wake a display we did not sleep)', () => {
      expect(wakeDisplayForVideo({})).toBe(false);
      expect(h.spawned).toEqual([]);
    });
  });
});
