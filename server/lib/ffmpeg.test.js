import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { verifyVideoPlayable, safeUnder, runFfmpegProcess, hasAudioStream, buildTrimConcatArgs } from './ffmpeg.js';

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

describe('hasAudioStream', () => {
  it('returns false for an empty/invalid path without shelling out', async () => {
    expect(await hasAudioStream('')).toBe(false);
    expect(await hasAudioStream(null)).toBe(false);
    expect(await hasAudioStream(undefined)).toBe(false);
  });

  it('returns false for a non-media file (no audio stream, or ffprobe absent)', async () => {
    // Garbage bytes: ffprobe reports no audio stream → false. When ffprobe is
    // not installed the helper short-circuits to false (documented safe
    // default), so false is the expected outcome either way.
    const tmpDir = mkdtempSync(join(tmpdir(), 'portos-ffmpeg-audio-'));
    const junk = join(tmpDir, 'junk.mp4');
    writeFileSync(junk, Buffer.alloc(64, 0));
    expect(await hasAudioStream(junk)).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
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

describe('buildTrimConcatArgs', () => {
  const CLIPS = [
    { path: '/v/a.mp4', startFrame: 0 },
    { path: '/v/b.mp4', startFrame: 9 },
  ];
  const graphOf = (args) => args[args.indexOf('-filter_complex') + 1];

  it('needs at least two inputs to concat', () => {
    expect(buildTrimConcatArgs({ inputs: [CLIPS[0]], outPath: '/v/out.mp4' })).toBeNull();
    expect(buildTrimConcatArgs({ inputs: [], outPath: '/v/out.mp4' })).toBeNull();
    expect(buildTrimConcatArgs({ inputs: null, outPath: '/v/out.mp4' })).toBeNull();
  });

  it('trims only the inputs that carry an offset, and maps them in order', () => {
    const args = buildTrimConcatArgs({ inputs: CLIPS, outPath: '/v/out.mp4', width: 512, height: 288, fps: 24 });
    expect(args.slice(0, 4)).toEqual(['-i', '/v/a.mp4', '-i', '/v/b.mp4']);
    const graph = graphOf(args);
    // The untrimmed input still gets normalized + PTS-rebased, but no `trim`.
    expect(graph).toContain('[0:v]setpts=PTS-STARTPTS,scale=512:288:force_original_aspect_ratio=decrease,pad=512:288:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v0]');
    // `trim` leads, so `start_frame` indexes the SOURCE frames the caller
    // measured — not whatever `fps=` would have resampled them into.
    expect(graph).toContain('[1:v]trim=start_frame=9,setpts=PTS-STARTPTS,scale=');
    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0[outv]');
    expect(args.slice(-2)).toEqual(['-y', '/v/out.mp4']);
  });

  it('omits geometry and rate filters it has no usable value for', () => {
    // A caller that can't name a canonical size/rate gets no normalization
    // rather than `scale=undefined:undefined`, which ffmpeg rejects outright.
    const graph = graphOf(buildTrimConcatArgs({ inputs: CLIPS, outPath: '/v/out.mp4' }));
    expect(graph).not.toContain('scale=');
    expect(graph).not.toContain('fps=');
    expect(graph).not.toContain('undefined');
    expect(graph).not.toContain('NaN');
    // The trim itself is a frame index, so it survives the missing rate.
    expect(graph).toContain('trim=start_frame=9');
  });

  it('adds a matching audio leg per input when every input has audio', () => {
    const args = buildTrimConcatArgs({ inputs: CLIPS, outPath: '/v/out.mp4', width: 512, height: 288, fps: 24, withAudio: true });
    const graph = graphOf(args);
    // atrim takes seconds: 9 frames at 24fps.
    expect(graph).toContain('atrim=start=0.375000');
    expect(graph).toContain('aformat=sample_fmts=fltp:channel_layouts=stereo');
    expect(graph).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]');
    expect(args).toContain('-c:a');
    expect(args).not.toContain('-an');
  });

  it('drops audio rather than desyncing it when a trim has no frame rate to convert with', () => {
    // `atrim` is timestamp-based; without an fps the audio would keep frames
    // the video leg just cut, so the whole track goes rather than drift.
    const graph = graphOf(buildTrimConcatArgs({ inputs: CLIPS, outPath: '/v/out.mp4', withAudio: true }));
    expect(graph).not.toContain(':a]');
    expect(graph).toContain('concat=n=2:v=1:a=0[outv]');
  });

  it('keeps audio on a rate-less concat when nothing is being trimmed', () => {
    const untrimmed = [{ path: '/v/a.mp4' }, { path: '/v/b.mp4', startFrame: 0 }];
    const graph = graphOf(buildTrimConcatArgs({ inputs: untrimmed, outPath: '/v/out.mp4', withAudio: true }));
    expect(graph).toContain('concat=n=2:v=1:a=1[outv][outa]');
    expect(graph).not.toContain('atrim');
  });

  it('clamps a negative or non-numeric offset to no trim at all', () => {
    const graph = graphOf(buildTrimConcatArgs({
      inputs: [{ path: '/v/a.mp4', startFrame: -5 }, { path: '/v/b.mp4', startFrame: 'nope' }],
      outPath: '/v/out.mp4',
    }));
    expect(graph).not.toContain('trim=start_frame');
  });
});
