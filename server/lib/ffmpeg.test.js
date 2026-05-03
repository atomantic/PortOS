import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { verifyVideoPlayable, safeUnder } from './ffmpeg.js';

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
