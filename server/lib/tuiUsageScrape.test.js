import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrapeTuiUsage } from './tuiUsageScrape.js';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const PASTE = '\x1b[200~/usage show\x1b[201~';

function fakePty() {
  let data;
  let exit;
  return {
    pid: 12345,
    onData(listener) { data = listener; },
    onExit(listener) { exit = listener; },
    emitData(chunk) { data(chunk); },
    emitExit() { exit({ exitCode: 0 }); },
    write: vi.fn(),
    kill: vi.fn(),
  };
}

describe('scrapeTuiUsage', () => {
  let tempDir;
  let sandboxDir;
  let pty;

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(join(tmpdir(), 'portos-test-tui-usage-'));
    sandboxDir = join(tempDir, 'sandbox');
    pty = fakePty();
    vi.mocked(spawn).mockReset().mockReturnValue(pty);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function scrape(options = {}) {
    return scrapeTuiUsage({
      command: 'example-tui',
      slashCommand: '/usage show',
      sandboxDir,
      idleMs: 100,
      ...options,
    });
  }

  async function paintStartup() {
    await vi.advanceTimersByTimeAsync(10);
    pty.emitData('Trust this folder?\n');
  }

  it.each([
    ['command', {}],
    ['slashCommand', { command: 'example-tui' }],
  ])('rejects a missing %s before spawning', async (field, options) => {
    await expect(scrapeTuiUsage({ sandboxDir, ...options })).rejects.toThrow(`${field} is required`);
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(sandboxDir)).toBe(false);
  });

  it('starts the TUI in a dedicated sandbox with the provider environment', async () => {
    const result = scrape({ args: ['--example'], env: { EXAMPLE_PROVIDER_MODE: 'usage', TERM: 'dumb', PWD: tempDir } });
    expect(existsSync(sandboxDir)).toBe(true);
    expect(spawn).toHaveBeenCalledWith('example-tui', ['--example'], {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: sandboxDir,
      env: expect.objectContaining({
        EXAMPLE_PROVIDER_MODE: 'usage',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PWD: sandboxDir,
      }),
    });

    pty.emitExit();
    await vi.advanceTimersToNextTimerAsync();
    await expect(result).resolves.toBe('');
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it('waits for startup, primes with Enter, then waits for the ANSI-stripped usage marker', async () => {
    const result = scrape({ readyMarker: /Usage remaining/ });
    await vi.advanceTimersByTimeAsync(250);
    expect(pty.write).not.toHaveBeenCalled();

    await paintStartup();
    await vi.advanceTimersToNextTimerAsync();
    expect(pty.write.mock.calls).toEqual([['\r']]);

    await vi.advanceTimersToNextTimerAsync();
    expect(pty.write.mock.calls).toEqual([['\r'], [PASTE]]);
    await vi.advanceTimersToNextTimerAsync();
    expect(pty.write.mock.calls).toEqual([['\r'], [PASTE], ['\r']]);

    await vi.advanceTimersByTimeAsync(500);
    expect(pty.kill).not.toHaveBeenCalled();
    pty.emitData('Loading usage…\n');
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.kill).not.toHaveBeenCalled();

    pty.emitData('Usage \x1b[32mremaining\x1b[0m: 40%\n');
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe('Trust this folder?\nLoading usage…\nUsage remaining: 40%\n');
    expect(pty.kill).toHaveBeenCalledExactlyOnceWith('SIGHUP');
  });

  it('waits for post-submit output even without a ready marker', async () => {
    const result = scrape();
    await paintStartup();
    await vi.advanceTimersByTimeAsync(1400);
    expect(pty.write.mock.calls).toEqual([['\r'], [PASTE], ['\r']]);
    expect(pty.kill).not.toHaveBeenCalled();

    pty.emitData('Usage: 40%');
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe('Trust this folder?\nUsage: 40%');
  });

  it('retains only the latest 512 KiB once the capture crosses the buffer headroom', async () => {
    const result = scrape();
    await paintStartup();
    await vi.advanceTimersByTimeAsync(900);
    const cap = 512 * 1024;
    const quota = 'Usage: 40%\n';
    const tail = 'y'.repeat(cap - quota.length) + quota;
    pty.emitData('Discarded paint\n' + 'x'.repeat(cap));
    pty.emitData(tail);

    await vi.advanceTimersByTimeAsync(500);
    const captured = await result;
    expect(captured).toHaveLength(cap);
    expect(captured.endsWith(quota)).toBe(true);
    expect(captured.startsWith('y')).toBe(true);
  });

  it('stops an idle startup at the hard timeout without sending keystrokes', async () => {
    const result = scrape({ timeoutMs: 120 });
    await vi.advanceTimersByTimeAsync(119);
    expect(pty.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('');
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.kill).toHaveBeenCalledExactlyOnceWith('SIGHUP');
  });

  it('kills the wrapper process group when time expires during paste settling', async () => {
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const result = scrape({ processGroup: true, timeoutMs: 600 });
    await paintStartup();
    await vi.advanceTimersByTimeAsync(590);
    await expect(result).resolves.toBe('Trust this folder?\n');

    expect(pty.write.mock.calls).toEqual([['\r'], [PASTE]]);
    expect(signal).toHaveBeenCalledExactlyOnceWith(-pty.pid, 'SIGHUP');
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it('does not submit the pasted command after the PTY exits', async () => {
    const result = scrape();
    await paintStartup();
    await vi.advanceTimersByTimeAsync(490);
    expect(pty.write.mock.calls).toEqual([['\r'], [PASTE]]);
    pty.emitExit();

    await vi.advanceTimersToNextTimerAsync();
    await expect(result).resolves.toBe('Trust this folder?\n');
    expect(pty.write).toHaveBeenCalledTimes(2);
    expect(pty.kill).not.toHaveBeenCalled();
  });
});
