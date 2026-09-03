/**
 * The shared yt-dlp spawn/marker/exit core.
 *
 * These pin the parts both importers used to own a copy of: the per-stream line
 * readers (a marker split across chunks, and two streams interleaving), and the
 * cancel branch that deliberately does NOT flush the carry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../lib/childProcess.js', async (importOriginal) => ({ ...(await importOriginal()), spawn: vi.fn() }));

const { spawn } = await import('../lib/childProcess.js');
const { runYtDlp, ytdlpMarkerArgs, YTDLP_MARKERS } = await import('./ytdlpRun.js');

/**
 * A fake yt-dlp child. `script` is a list of `[stream, chunk]` pairs written in
 * order before the close, so a test can split one line across two chunks or
 * interleave the two streams.
 */
function fakeChild({ code = 0, signal = null, script = [] } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    for (const [stream, chunk] of script) proc[stream].emit('data', Buffer.from(chunk));
    proc.emit('close', code, signal);
  });
  return proc;
}

const baseArgs = { ytDlp: '/usr/local/bin/yt-dlp', args: ['--version'], onProgress: () => {}, registerProcess: () => {} };

beforeEach(() => { vi.clearAllMocks(); });

describe('ytdlpMarkerArgs', () => {
  it('emits the print/progress-template pair plus the --no-simulate workaround', () => {
    const args = ytdlpMarkerArgs('extracting');
    expect(args).toEqual(expect.arrayContaining(['--print', `${YTDLP_MARKERS.TITLE}%(title)s`]));
    expect(args).toEqual(expect.arrayContaining([
      '--progress-template', `download:${YTDLP_MARKERS.PROGRESS}%(progress._percent_str)s`,
    ]));
    expect(args).toEqual(expect.arrayContaining([
      '--progress-template', `postprocess:${YTDLP_MARKERS.STAGE}extracting`,
    ]));
    // --print implies --simulate and suppresses reporting; both undos must ride along.
    expect(args).toEqual(expect.arrayContaining(['--no-simulate', '--progress']));
  });
});

describe('runYtDlp — marker parsing', () => {
  it('emits one progress frame for a marker split across two stdout chunks', async () => {
    const seen = [];
    spawn.mockReturnValue(fakeChild({ script: [['stdout', 'PORTOS_PROG'], ['stdout', 'RESS: 42.0%\n']] }));
    await runYtDlp({ ...baseArgs, onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([{ percent: 42 }]);
  });

  it('does not corrupt a marker when stdout and stderr interleave mid-line', async () => {
    const seen = [];
    spawn.mockReturnValue(fakeChild({
      // The reason each stream needs its OWN reader: a shared carry would
      // splice stderr's chunk onto stdout's partial line.
      script: [
        ['stdout', 'PORTOS_PROGRESS: 10'],
        ['stderr', 'PORTOS_STAGE:extracting\n'],
        ['stdout', '.0%\n'],
      ],
    }));
    await runYtDlp({ ...baseArgs, onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([{ percent: 100, stage: 'extracting' }, { percent: 10 }]);
  });

  it('captures the title marker and ignores a non-numeric percent', async () => {
    const seen = [];
    spawn.mockReturnValue(fakeChild({
      script: [['stdout', 'PORTOS_TITLE:Example Clip \nPORTOS_PROGRESS:not-a-number\n']],
    }));
    const result = await runYtDlp({ ...baseArgs, onProgress: (p) => seen.push(p) });
    expect(result.title).toBe('Example Clip');
    expect(seen).toEqual([]);
  });

  it('flushes a final unterminated line on a normal exit', async () => {
    const seen = [];
    spawn.mockReturnValue(fakeChild({ script: [['stdout', 'PORTOS_PROGRESS: 99.0%']] })); // no trailing newline
    await runYtDlp({ ...baseArgs, onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([{ percent: 99 }]);
  });
});

describe('runYtDlp — exit classification', () => {
  it('reports canceled on SIGKILL and fires no progress frame from the unflushed carry', async () => {
    const seen = [];
    spawn.mockReturnValue(fakeChild({
      code: null, signal: 'SIGKILL', script: [['stdout', 'PORTOS_PROGRESS: 50.0%']], // partial line, no newline
    }));
    const result = await runYtDlp({ ...baseArgs, onProgress: (p) => seen.push(p) });
    expect(result).toMatchObject({ canceled: true, signal: 'SIGKILL' });
    expect(seen).toEqual([]);
  });

  it('reports canceled on SIGTERM', async () => {
    spawn.mockReturnValue(fakeChild({ code: null, signal: 'SIGTERM' }));
    await expect(runYtDlp(baseArgs)).resolves.toMatchObject({ canceled: true, signal: 'SIGTERM' });
  });

  it('passes a non-zero exit code through without a reason', async () => {
    spawn.mockReturnValue(fakeChild({ code: 1 }));
    await expect(runYtDlp(baseArgs)).resolves.toMatchObject({ canceled: false, code: 1, reason: null });
  });

  it('reports a spawn failure as a reason rather than throwing', async () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => proc.emit('error', new Error('ENOENT')));
    spawn.mockReturnValue(proc);
    const result = await runYtDlp(baseArgs);
    expect(result).toMatchObject({ canceled: false, code: null, reason: 'spawn failed: ENOENT' });
  });

  it('registers the child then clears it after the exit', async () => {
    const registered = [];
    spawn.mockReturnValue(fakeChild({ code: 0 }));
    await runYtDlp({ ...baseArgs, registerProcess: (p) => registered.push(p) });
    expect(registered).toHaveLength(2);
    expect(registered[0]).not.toBeNull();
    expect(registered[1]).toBeNull();
  });
});
