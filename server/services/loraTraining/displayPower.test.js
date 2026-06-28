import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock state so the os/child_process factories can reach it.
const h = vi.hoisted(() => ({
  platform: 'darwin',
  spawned: [], // [{ cmd, args }]
}));

vi.mock('os', () => ({ platform: () => h.platform }));
vi.mock('child_process', () => ({
  spawn: (cmd, args) => {
    h.spawned.push({ cmd, args });
    return { on: () => {}, unref: () => {} };
  },
}));

const { isDisplaySleepEnabled, sleepDisplayForTraining, wakeDisplay } = await import('./displayPower.js');

beforeEach(() => {
  h.platform = 'darwin';
  h.spawned = [];
});

describe('displayPower', () => {
  describe('isDisplaySleepEnabled', () => {
    it('is on by default on darwin (absent slice / absent flag)', () => {
      expect(isDisplaySleepEnabled(undefined)).toBe(true);
      expect(isDisplaySleepEnabled({})).toBe(true);
      expect(isDisplaySleepEnabled({ loraTraining: {} })).toBe(true);
    });

    it('respects an explicit false', () => {
      expect(isDisplaySleepEnabled({ loraTraining: { displaySleep: false } })).toBe(false);
    });

    it('honors an explicit true', () => {
      expect(isDisplaySleepEnabled({ loraTraining: { displaySleep: true } })).toBe(true);
    });

    it('is off on non-darwin regardless of the setting', () => {
      h.platform = 'linux';
      expect(isDisplaySleepEnabled({ loraTraining: { displaySleep: true } })).toBe(false);
    });
  });

  describe('sleepDisplayForTraining', () => {
    it('runs `pmset displaysleepnow` when enabled', () => {
      expect(sleepDisplayForTraining({ loraTraining: {} })).toBe(true);
      expect(h.spawned).toEqual([{ cmd: 'pmset', args: ['displaysleepnow'] }]);
    });

    it('is a no-op (no spawn) when disabled', () => {
      expect(sleepDisplayForTraining({ loraTraining: { displaySleep: false } })).toBe(false);
      expect(h.spawned).toEqual([]);
    });

    it('is a no-op off darwin', () => {
      h.platform = 'win32';
      expect(sleepDisplayForTraining({ loraTraining: {} })).toBe(false);
      expect(h.spawned).toEqual([]);
    });
  });

  describe('wakeDisplay', () => {
    it('runs `caffeinate -u -t 5` when enabled', () => {
      expect(wakeDisplay({ loraTraining: {} })).toBe(true);
      expect(h.spawned).toEqual([{ cmd: 'caffeinate', args: ['-u', '-t', '5'] }]);
    });

    it('is a no-op when disabled (so we never wake a display we did not sleep)', () => {
      expect(wakeDisplay({ loraTraining: { displaySleep: false } })).toBe(false);
      expect(h.spawned).toEqual([]);
    });
  });
});
