import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnedFixtureSetup } from './ownedFixtureSetup.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('whole fixture setup ownership', () => {
  it.each(['preparation', 'browser-acquire'])('retains a deadline failure and settles deferred %s before cleanup', async stalled => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const waiting = deferred();
    const entered = deferred();
    const ownedBrowser = { close: vi.fn(async () => {}) };
    const unrelatedBrowser = { close: vi.fn(async () => {}) };
    let browser;
    const acquire = vi.fn(async () => {
      if (stalled === 'browser-acquire') { entered.resolve(); await waiting.promise; }
      // Retain the exact capability before the phase's post-settlement guard.
      browser = ownedBrowser;
    });
    const cleanup = vi.fn(async () => browser?.close());
    const report = vi.fn();
    const fixture = createOwnedFixtureSetup({ cleanup, report });
    const starting = fixture.run(async phase => {
      await phase('preparation', async () => {
        if (stalled === 'preparation') { entered.resolve(); await waiting.promise; }
      });
      await phase('browser-acquire', acquire);
      await phase('page-acquire', () => { throw new Error('Must never acquire a page after timeout'); });
    });
    const verdict = starting.catch(error => error);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30000);
    const failure = await verdict;
    expect(failure.message).toContain(`Fixture setup deadline; phase=${stalled}`);
    const closing = fixture.close();
    expect(fixture.close()).toBe(closing);
    expect(cleanup).not.toHaveBeenCalled();
    waiting.resolve();
    await closing;
    expect(await verdict).toBe(failure);
    expect(acquire).toHaveBeenCalledTimes(stalled === 'browser-acquire' ? 1 : 0);
    expect(ownedBrowser.close).toHaveBeenCalledTimes(stalled === 'browser-acquire' ? 1 : 0);
    expect(unrelatedBrowser.close).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(report.mock.calls.flat().join('\n')).toContain(`phase=${stalled}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the next acquisition when the runner starts teardown before its own deadline fires', async () => {
    const waiting = deferred();
    const entered = deferred();
    const acquire = vi.fn();
    const cleanup = vi.fn();
    const fixture = createOwnedFixtureSetup({ cleanup, report: vi.fn() });
    const verdict = fixture.run(async phase => {
      await phase('bundle', () => { entered.resolve(); return waiting.promise; });
      await phase('browser-acquire', acquire);
    }).catch(error => error);
    await entered.promise;
    const closing = fixture.close();
    waiting.resolve();
    await closing;
    expect((await verdict).message).toContain('Fixture setup stopped; phase=bundle');
    expect(acquire).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects a synchronous phase that exhausts the budget before timers can fire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const acquire = vi.fn();
    const fixture = createOwnedFixtureSetup({ cleanup: vi.fn(), report: vi.fn() });
    await expect(fixture.run(async phase => {
      await phase('clip-encode', remaining => { expect(remaining).toBe(30000); now = 30001; });
      await phase('browser-acquire', acquire);
    })).rejects.toThrow('Fixture setup stopped; phase=clip-encode');
    await fixture.close();
    expect(acquire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains phase evidence when CI silences console output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const fixture = createOwnedFixtureSetup({ cleanup: vi.fn() });
    try {
      await expect(fixture.run(phase => phase('bundle', () => { throw new Error('private details'); }))).rejects.toThrow('private details');
      await fixture.close();
      const evidence = output.mock.calls.map(([message]) => message).join('');
      expect(evidence).toContain('Fixture setup failed; phase=bundle');
      expect(evidence).not.toContain('private details');
      expect(evidence.length).toBeLessThan(512);
      expect(log).not.toHaveBeenCalled();
    } finally { output.mockRestore(); log.mockRestore(); }
  });

  it('keeps setup and cleanup failures distinct and emits only phase timing', async () => {
    const initial = new Error('synthetic private path or launch details');
    const cleanupFailure = new Error('synthetic cleanup failure');
    const report = vi.fn();
    const fixture = createOwnedFixtureSetup({ report, cleanup: async () => { throw cleanupFailure; } });
    await expect(fixture.run(phase => phase('bundle', () => { throw initial; }))).rejects.toBe(initial);
    const closing = fixture.close();
    await expect(closing).rejects.toBe(cleanupFailure);
    expect(fixture.close()).toBe(closing);
    expect(report.mock.calls.flat().join('\n')).not.toContain(initial.message);
  });
});
