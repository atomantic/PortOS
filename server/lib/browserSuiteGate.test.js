import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserSuiteCanRun, chromeWithH264, describeH264Probe, probeChromeH264 } from './browserSuiteGate.js';

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

describe('H.264 probe outcomes', () => {
  const dirs = [];
  const fakeChrome = (body) => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-fake-chrome-'));
    dirs.push(dir);
    const path = join(dir, 'chrome');
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  // The fake binaries are shebang scripts, which Windows cannot execute.
  const posix = it.skipIf(process.platform === 'win32');

  posix('accepts a clean exit that reports H.264', async () => {
    const chrome = fakeChrome("process.stdout.write('<body>H264:probably</body>');");
    expect(await probeChromeH264(chrome)).toEqual({ ok: true, chromePath: chrome });
    expect(await chromeWithH264(chrome)).toBe(chrome);
  });

  posix('treats a positive codec answer followed by a nonzero exit as a lifecycle failure, never a missing codec', async () => {
    const chrome = fakeChrome("process.stdout.write('<body>H264:probably</body>'); process.exitCode = 2;");
    const result = await probeChromeH264(chrome);
    expect(result).toMatchObject({ ok: false, cause: 'teardown-failed', exit: 2 });
    expect(describeH264Probe(result)).toMatch(/lifecycle failure, not a missing codec/);

    const failure = await chromeWithH264(chrome);
    expect(failure).toEqual({ probeFailure: 'teardown-failed' });

    process.env.PORTOS_REQUIRE_BROWSER_SUITES = '1';
    expect(() => browserSuiteCanRun('suite', { 'Chrome with H.264': failure, ffmpeg: '/usr/bin/ffmpeg' }))
      .toThrow('suite: browser suite skipped but PORTOS_REQUIRE_BROWSER_SUITES is set — Chrome with H.264 probe failed (teardown-failed)');
  });

  posix('reports a codec-less Chrome and a missing executable as absent prerequisites', async () => {
    const codecless = fakeChrome("process.stdout.write('<body>H264:</body>');");
    expect(await probeChromeH264(codecless)).toEqual({ ok: false, cause: 'codec-unavailable' });
    expect(await chromeWithH264(codecless)).toBeNull();
    expect(await chromeWithH264(join(tmpdir(), 'portos-no-such-chrome'))).toBeNull();
    expect(await probeChromeH264(join(tmpdir(), 'portos-no-such-chrome'))).toEqual({ ok: false, cause: 'missing-executable' });
    expect(await probeChromeH264(undefined)).toEqual({ ok: false, cause: 'missing-executable' });
  });

  posix('distinguishes a probe that never answered from a codec-less one', async () => {
    const silent = fakeChrome('process.exitCode = 0;');
    expect(await probeChromeH264(silent)).toMatchObject({ ok: false, cause: 'no-answer' });
    const crashed = fakeChrome('process.exitCode = 9;');
    expect(await probeChromeH264(crashed)).toMatchObject({ ok: false, cause: 'no-answer', exit: 9 });
  });

  posix('kills a SIGTERM-ignoring hang and its group, and reports the timeout with verified cleanup', async () => {
    const pids = join(mkdtempSync(join(tmpdir(), 'portos-fake-pids-')), 'pids');
    dirs.push(join(pids, '..'));
    const chrome = fakeChrome(`
      const { spawn } = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + helper.pid);
      process.stdout.write('H264:probably');
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `);
    const result = await probeChromeH264(chrome, { timeoutMs: 800, graceMs: 300 });
    expect(result).toMatchObject({ ok: false, cause: 'probe-timeout', cleanupVerified: true });
    expect(describeH264Probe(result)).toBe('Chrome H.264 probe timed out after 1s; child cleanup verified');
    const [parent, helper] = readFileSync(pids, 'utf8').split(' ').map(Number);
    await vi.waitFor(() => {
      expect(pidAlive(parent)).toBe(false);
      expect(pidAlive(helper)).toBe(false);
    }, { timeout: 3000 });
    expect(await chromeWithH264(chrome, { timeoutMs: 800, graceMs: 300 })).toEqual({ probeFailure: 'probe-timeout' });
  });

  it('names a probe failure beside missing prerequisites when skipping locally', () => {
    delete process.env.PORTOS_REQUIRE_BROWSER_SUITES;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(browserSuiteCanRun('suite', { 'Chrome with H.264': { probeFailure: 'teardown-failed' }, ffmpeg: null })).toBe(false);
    expect(log).toHaveBeenCalledWith('⏭️ suite: skipping suite — missing ffmpeg; Chrome with H.264 probe failed (teardown-failed)');
  });
});
