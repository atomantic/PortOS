import { describe, expect, it, vi } from 'vitest';
import { isPidAlive, isPidConfirmedDead, isPidPossiblyAlive } from './processLiveness.js';

describe('individual PID liveness', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 2 ** 31, Number.MAX_SAFE_INTEGER + 1, '42', null, undefined])(
    'rejects the invalid PID %s without asking the OS',
    pid => {
      const kill = vi.fn();
      expect(isPidAlive(pid, { kill })).toBe(false);
      expect(isPidConfirmedDead(pid, { kill })).toBe(false);
      expect(isPidPossiblyAlive(pid, { kill })).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it.each([
    { code: null, alive: true, dead: false, possiblyAlive: true },
    { code: 'EPERM', alive: true, dead: false, possiblyAlive: true },
    { code: 'ESRCH', alive: false, dead: true, possiblyAlive: false },
    { code: 'EIO', alive: false, dead: false, possiblyAlive: true },
  ])('classifies a signal-zero probe with error $code', ({ code, alive, dead, possiblyAlive }) => {
    const kill = vi.fn(() => {
      if (code) throw Object.assign(new Error(code), { code });
    });
    expect(isPidAlive(42, { kill })).toBe(alive);
    expect(isPidConfirmedDead(42, { kill })).toBe(dead);
    expect(isPidPossiblyAlive(42, { kill })).toBe(possiblyAlive);
    expect(kill.mock.calls).toEqual([[42, 0], [42, 0], [42, 0]]);
  });
});
