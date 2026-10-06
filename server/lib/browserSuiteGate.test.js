import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserSuiteCanRun } from './browserSuiteGate.js';

const original = process.env.PORTOS_REQUIRE_BROWSER_SUITES;

afterEach(() => {
  if (original === undefined) delete process.env.PORTOS_REQUIRE_BROWSER_SUITES;
  else process.env.PORTOS_REQUIRE_BROWSER_SUITES = original;
  vi.restoreAllMocks();
});

describe('browserSuiteCanRun', () => {
  it('skips with a visible log naming the missing prerequisites when the flag is unset', () => {
    delete process.env.PORTOS_REQUIRE_BROWSER_SUITES;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(browserSuiteCanRun('suite', { Chrome: '/usr/bin/chrome', ffmpeg: null, 'client bundler': undefined })).toBe(false);
    expect(log).toHaveBeenCalledWith('⏭️ suite: skipping suite — missing ffmpeg, client bundler');
  });

  it('fails loudly, naming the missing prerequisites, when CI requires browser suites', () => {
    process.env.PORTOS_REQUIRE_BROWSER_SUITES = '1';

    expect(() => browserSuiteCanRun('suite', { Chrome: '/usr/bin/chrome', 'client bundler': undefined }))
      .toThrow('suite: browser suite skipped but PORTOS_REQUIRE_BROWSER_SUITES is set — missing client bundler');
  });

  it('runs the cleanup hook before it skips or throws, since Vitest runs no hooks for a skipped file', () => {
    const onUnavailable = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    delete process.env.PORTOS_REQUIRE_BROWSER_SUITES;
    browserSuiteCanRun('suite', { Chrome: null }, { onUnavailable });
    process.env.PORTOS_REQUIRE_BROWSER_SUITES = '1';
    expect(() => browserSuiteCanRun('suite', { Chrome: null }, { onUnavailable })).toThrow();
    expect(onUnavailable).toHaveBeenCalledTimes(2);
  });

  it('runs, even when the flag is set, once every prerequisite is present', () => {
    process.env.PORTOS_REQUIRE_BROWSER_SUITES = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(browserSuiteCanRun('suite', { Chrome: '/usr/bin/chrome', ffmpeg: '/usr/bin/ffmpeg' })).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});
