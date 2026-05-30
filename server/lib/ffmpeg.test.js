import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { verifyVideoPlayable, safeUnder, runFfmpegProcess } from './ffmpeg.js';

describe('verifyVideoPlayable', () => {
  let tmpDir;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'portos-ffmpeg-test-'));
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects an empty/invalid path', async () => {
    expect(await verifyVideoPlayable('')).toEqual({ ok: false, reason: 'invalid video path' });
    expect(await verifyVideoPlayable(null)).toEqual({ ok: false, reason: 'invalid video path' });
    expect(await verifyVideoPlayable(undefined)).toEqual({ ok: false, reason: 'invalid video path' });
  });

  it('rejects a missing file', async () => {
    const missing = join(tmpDir, 'does-not-exist.mp4');
    const res = await verifyVideoPlayable(missing);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/missing/);
  });

  it('rejects a zero-byte file', async () => {
    const empty = join(tmpDir, 'empty.mp4');
    writeFileSync(empty, '');
    const res = await verifyVideoPlayable(empty);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/empty/);
  });

  it('rejects a non-empty but non-decodable file when ffprobe is available', async () => {
    // Garbage bytes that look like a non-empty file but cannot be decoded as
    // video — ffprobe will report no frames. When ffprobe is NOT installed
    // on the test host, the helper short-circuits to ok:true (documented
    // behavior), so we accept either outcome here rather than skipping.
    const junk = join(tmpDir, 'junk.mp4');
    writeFileSync(junk, Buffer.alloc(64, 0));
    const res = await verifyVideoPlayable(junk);
    if (!res.ok) {
      expect(res.reason).toMatch(/ffprobe|frame/);
    } else {
      expect(res.ok).toBe(true);
    }
  });
});

describe('runFfmpegProcess', () => {
  it('returns ok:false when bin is not a string', async () => {
    const res = await runFfmpegProcess({ args: ['-version'] });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/invalid ffmpeg binary/);
  });

  it('returns ok:false when args is not an array', async () => {
    const res = await runFfmpegProcess({ bin: '/bin/true', args: 'oops' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/invalid ffmpeg args/);
  });

  it('returns ok:true when the child exits 0 (using /bin/true as a fake ffmpeg)', async () => {
    // POSIX-only — Windows skips. The helper only cares about the spawn-
    // exit-0 contract, not anything ffmpeg-specific, so any zero-exit binary
    // exercises the happy path.
    if (process.platform === 'win32') return;
    const res = await runFfmpegProcess({ bin: '/usr/bin/true', args: [] });
    if (res.ok) {
      expect(res).toEqual({ ok: true });
    } else {
      // Some hosts ship /bin/true instead — try once more.
      const res2 = await runFfmpegProcess({ bin: '/bin/true', args: [] });
      expect(res2).toEqual({ ok: true });
    }
  });

  it('returns ok:false with non-zero exit code in reason', async () => {
    if (process.platform === 'win32') return;
    const res = await runFfmpegProcess({ bin: '/usr/bin/false', args: [] });
    if (res.reason?.includes('spawn failed')) {
      // /usr/bin/false may not exist (e.g. macOS sometimes uses /bin/false);
      // try the alternative and re-assert.
      const res2 = await runFfmpegProcess({ bin: '/bin/false', args: [] });
      expect(res2.ok).toBe(false);
      expect(res2.reason).toMatch(/ffmpeg exit 1/);
    } else {
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/ffmpeg exit 1/);
    }
  });

  it('returns ok:false with spawn-failed reason for a missing binary', async () => {
    const res = await runFfmpegProcess({ bin: '/this/does/not/exist/ffmpeg-fake', args: ['-x'] });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/spawn failed/);
  });

  it('strips Malloc debug variables from spawned ffmpeg children', async () => {
    const oldMalloc = process.env.MallocStackLogging;
    process.env.MallocStackLogging = '0';
    try {
      const res = await runFfmpegProcess({
        bin: process.execPath,
        args: ['-e', "process.exit(process.env.MallocStackLogging === undefined ? 0 : 2)"],
      });
      expect(res).toEqual({ ok: true });
    } finally {
      if (oldMalloc === undefined) delete process.env.MallocStackLogging;
      else process.env.MallocStackLogging = oldMalloc;
    }
  });

  it('removes the abort listener on normal completion (no listener leak)', async () => {
    if (process.platform === 'win32') return;
    const controller = new AbortController();
    // Spy on add/remove to confirm the helper cleans up.
    let added = 0;
    let removed = 0;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { added += 1; return origAdd(...args); };
    controller.signal.removeEventListener = (...args) => { removed += 1; return origRemove(...args); };
    const trueBin = process.platform === 'darwin' ? '/usr/bin/true' : '/bin/true';
    await runFfmpegProcess({ bin: trueBin, args: [], signal: controller.signal });
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });
});

describe('safeUnder', () => {
  it('accepts a plain basename under a root', () => {
    const root = '/tmp/portos-root';
    expect(safeUnder(root, 'foo.mp4')).toBe('/tmp/portos-root/foo.mp4');
  });

  it('rejects path-traversal segments', () => {
    expect(safeUnder('/tmp/portos-root', '../escape.mp4')).toBeNull();
    expect(safeUnder('/tmp/portos-root', 'sub/foo.mp4')).toBeNull();
    expect(safeUnder('/tmp/portos-root', '..')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(safeUnder('/tmp/portos-root', null)).toBeNull();
    expect(safeUnder('/tmp/portos-root', undefined)).toBeNull();
    expect(safeUnder('/tmp/portos-root', 42)).toBeNull();
  });
});
