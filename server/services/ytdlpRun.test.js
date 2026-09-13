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
const { runYtDlp, ytdlpMarkerArgs, YTDLP_MARKERS, describeYtDlpFailure } = await import('./ytdlpRun.js');

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

const YT_URL = 'https://youtu.be/aaaaaaaaaaa';
const X_URL = 'https://x.com/someone/status/1234567890';
const FORBIDDEN = 'ERROR: unable to download video data: HTTP Error 403: Forbidden';

describe('describeYtDlpFailure', () => {
  it('names the stale-binary remedy for the YouTube gating class', () => {
    // A 403 on media URLs is what a yt-dlp that has fallen behind YouTube's
    // player handshake reports for a video the browser plays fine; without the
    // hint the user has a real message and still no next step.
    const reason = describeYtDlpFailure(1, FORBIDDEN, { url: YT_URL });
    expect(reason).toContain('HTTP Error 403: Forbidden');
    expect(reason).toMatch(/yt-dlp -U/);
  });

  it('leaves an unrelated failure without the upgrade hint', () => {
    const reason = describeYtDlpFailure(1, 'ERROR: Video unavailable', { url: YT_URL });
    expect(reason).toBe('yt-dlp failed: ERROR: Video unavailable');
    expect(reason).not.toMatch(/yt-dlp -U/);
  });

  // Failures that LOOK like the stale-player class and are not. Advising an
  // upgrade for any of them sends the user to the one action that cannot help,
  // so each exclusion is pinned rather than left to the regex's shape.
  it('does not advise an upgrade for YouTube\'s bot check, whose remedy is cookies', () => {
    const reason = describeYtDlpFailure(1, 'ERROR: Sign in to confirm you are not a bot', { url: YT_URL });
    expect(reason).not.toMatch(/yt-dlp -U/);
  });

  // The message alone can't decide this one: x.com returns a plain 403 for a
  // login-walled or rate-limited post, which no yt-dlp upgrade fixes.
  it('does not advise an upgrade for the same 403 from a non-YouTube source', () => {
    const reason = describeYtDlpFailure(1, FORBIDDEN, { url: X_URL });
    expect(reason).toContain('HTTP Error 403: Forbidden');
    expect(reason).not.toMatch(/yt-dlp -U/);
  });

  it('withholds the hint when the caller passed no URL at all', () => {
    expect(describeYtDlpFailure(1, FORBIDDEN)).not.toMatch(/yt-dlp -U/);
  });

  it('falls back to the exit code when there is no output', () => {
    expect(describeYtDlpFailure(2, '   ')).toBe('yt-dlp exited 2');
  });

  describe('with a caller fallback (a clean exit that produced nothing)', () => {
    it('appends what yt-dlp printed to the caller\'s guess', () => {
      const reason = describeYtDlpFailure(0, 'ERROR: boom', { fallback: 'no video was produced' });
      expect(reason).toBe('no video was produced — yt-dlp said: ERROR: boom');
    });

    it('uses the guess alone when yt-dlp printed nothing', () => {
      expect(describeYtDlpFailure(0, '', { fallback: 'no video was produced' })).toBe('no video was produced');
    });

    it('still names the upgrade remedy when the printed cause is the gating class', () => {
      const reason = describeYtDlpFailure(0, FORBIDDEN, { fallback: 'no video was produced', url: YT_URL });
      expect(reason).toMatch(/yt-dlp -U/);
    });
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

  it('falls back to the exit code when yt-dlp printed nothing', async () => {
    spawn.mockReturnValue(fakeChild({ code: 1 }));
    await expect(runYtDlp(baseArgs)).resolves.toMatchObject({
      canceled: false, code: 1, reason: 'yt-dlp exited 1',
    });
  });

  // The reported bug: a real 403 reached the user as a bare "yt-dlp exited 1"
  // because stderr was read for markers and then dropped.
  it('reports what yt-dlp printed to stderr rather than just the exit code', async () => {
    spawn.mockReturnValue(fakeChild({
      code: 1,
      script: [['stderr', 'ERROR: unable to download video data: HTTP Error 403: Forbidden\n']],
    }));
    const result = await runYtDlp(baseArgs);
    expect(result.reason).toContain('HTTP Error 403: Forbidden');
    expect(result.reason).not.toBe('yt-dlp exited 1');
  });

  // Pins that the URL actually reaches describeYtDlpFailure — without the
  // forwarding, both of these would report the same reason.
  it('forwards the source URL, so the hint follows the site and not just the message', async () => {
    const child = () => fakeChild({ code: 1, script: [['stderr', `${FORBIDDEN}\n`]] });

    spawn.mockReturnValue(child());
    const youtube = await runYtDlp({ ...baseArgs, url: YT_URL });
    expect(youtube.reason).toMatch(/yt-dlp -U/);

    spawn.mockReturnValue(child());
    const x = await runYtDlp({ ...baseArgs, url: X_URL });
    expect(x.reason).not.toMatch(/yt-dlp -U/);
  });

  it('flushes an unterminated final stderr line into the failure reason', async () => {
    // yt-dlp's ERROR line is frequently the last thing written, with no newline.
    spawn.mockReturnValue(fakeChild({ code: 1, script: [['stderr', 'ERROR: Video unavailable']] }));
    const result = await runYtDlp(baseArgs);
    expect(result.reason).toContain('Video unavailable'); // prose itself is pinned above

  });

  it('keeps our own marker lines out of the failure reason', async () => {
    spawn.mockReturnValue(fakeChild({
      code: 1,
      script: [['stdout', 'PORTOS_TITLE:Example Clip\nPORTOS_PROGRESS: 12.0%\n'], ['stderr', 'ERROR: boom\n']],
    }));
    const result = await runYtDlp(baseArgs);
    expect(result.reason).toBe('yt-dlp failed: ERROR: boom');
    expect(result.output).not.toContain('PORTOS_');
  });

  it('leaves reason null on a clean exit so the caller owns the "produced nothing" case', async () => {
    spawn.mockReturnValue(fakeChild({ code: 0, script: [['stderr', 'WARNING: something benign\n']] }));
    const result = await runYtDlp(baseArgs);
    expect(result.reason).toBeNull();
    expect(result.output).toContain('WARNING: something benign');
  });

  // Also pins that a spawn failure keeps its own message rather than falling
  // through to the empty-output `yt-dlp exited null`.
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
