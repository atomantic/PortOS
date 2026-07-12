import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createInstallLogger } from './installLogger.js';

describe('createInstallLogger', () => {
  let logSpy;
  let errSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const logged = () => logSpy.mock.calls.map((c) => c[0]);
  const errored = () => errSpy.mock.calls.map((c) => c[0]);

  it('logs a START line on start() with installer and target', () => {
    const log = createInstallLogger({ installer: 'Example Engine', target: '/venv/py' });
    log.start();
    expect(logged().some((l) => /Install starting: Example Engine/.test(l) && l.includes('/venv/py'))).toBe(true);
  });

  it('no-ops onEvent before start()', () => {
    const log = createInstallLogger({ installer: 'Example' });
    log.onEvent({ type: 'complete', message: 'done' });
    log.onEvent({ type: 'error', message: 'boom' });
    log.onEvent({ type: 'stage', stage: 'venv' });
    expect(logged()).toHaveLength(0);
    expect(errored()).toHaveLength(0);
  });

  it('logs stage milestones but throttles raw log lines to a timed heartbeat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const log = createInstallLogger({ installer: 'Example' });
      log.start();
      log.onEvent({ type: 'stage', stage: 'install', message: 'Installing torch' });
      // A burst of raw log lines inside the heartbeat window emits ZERO
      // heartbeats (lastHeartbeat was set at start(), same instant).
      for (let i = 0; i < 50; i += 1) log.onEvent({ type: 'log', message: `line ${i}` });
      expect(logged().filter((l) => /Example: install/.test(l))).toHaveLength(1);
      expect(logged().filter((l) => /installing…/.test(l))).toHaveLength(0);

      // Cross the heartbeat threshold → the next line emits exactly one heartbeat.
      vi.advanceTimersByTime(16000);
      for (let i = 0; i < 50; i += 1) log.onEvent({ type: 'log', message: `more ${i}` });
      expect(logged().filter((l) => /installing…/.test(l))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs SUCCESS outcome on a complete event', () => {
    const log = createInstallLogger({ installer: 'Example', target: '/venv/py' });
    log.start();
    log.onEvent({ type: 'complete', message: 'ready' });
    expect(logged().some((l) => /Install complete: Example/.test(l) && /ready/.test(l))).toBe(true);
  });

  it('logs FAILURE outcome on an error event via console.error', () => {
    const log = createInstallLogger({ installer: 'Example' });
    log.start();
    log.onEvent({ type: 'error', message: 'pip exploded' });
    expect(errored().some((l) => /Install failed: Example/.test(l) && /pip exploded/.test(l))).toBe(true);
  });

  it('logs a terminal outcome only once (dedupes complete then failure())', () => {
    const log = createInstallLogger({ installer: 'Example' });
    log.start();
    log.onEvent({ type: 'complete', message: 'ready' });
    log.failure('should be ignored');
    const outcomes = [...logged(), ...errored()].filter((l) => /Install (complete|failed):/.test(l));
    expect(outcomes).toHaveLength(1);
  });

  it('logs a CANCEL outcome and blocks later outcomes', () => {
    const log = createInstallLogger({ installer: 'Example' });
    log.start();
    log.cancel();
    log.onEvent({ type: 'error', message: 'exit code 143' });
    expect(logged().some((l) => /Install cancelled: Example/.test(l))).toBe(true);
    expect(errored()).toHaveLength(0);
  });

  it('cancel() before start() is a no-op (nothing was installing)', () => {
    const log = createInstallLogger({ installer: 'Example' });
    log.cancel();
    expect(logged()).toHaveLength(0);
    expect(errored()).toHaveLength(0);
  });

  it('survives a malformed event without throwing', () => {
    const log = createInstallLogger({ installer: 'Example' });
    log.start();
    expect(() => log.onEvent(null)).not.toThrow();
    expect(() => log.onEvent('nope')).not.toThrow();
    expect(() => log.onEvent(undefined)).not.toThrow();
  });
});
