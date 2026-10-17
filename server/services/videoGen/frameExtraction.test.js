import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ID = '11111111-1111-4111-8111-111111111111';
const root = mkdtempSync(join(tmpdir(), 'frameext-test-'));
const videos = join(root, 'videos');
const images = join(root, 'images');
mkdirSync(videos, { recursive: true });
writeFileSync(join(videos, 'clip.mp4'), 'x');

const scanDirs = [];
let release;

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, videos, images } };
});
vi.mock('./history.js', () => ({ loadHistory: async () => [{ id: ID, filename: 'clip.mp4' }] }));
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findFfmpeg: async () => '/bin/ffmpeg',
  vfrSyncArgs: async () => [],
  runFfmpegProcess: vi.fn(async ({ args }) => {
    const out = args[args.length - 1];
    scanDirs.push(out.replace(/\/cand-%03d\.png$/, ''));
    await new Promise((r) => { release = r; });
    writeFileSync(out.replace('%03d', '001'), 'frame');
    return { ok: true };
  }),
}));
vi.mock('../../lib/frameQuality.js', async (importOriginal) => ({
  ...(await importOriginal()),
  pickBestFrame: async (paths) => ({ path: paths[0], index: 0, focus: 1 }),
}));

const { extractLastFrame } = await import('./frameExtraction.js');
const { runFfmpegProcess } = await import('../../lib/ffmpeg.js');

describe('extractLastFrame concurrency', () => {
  beforeEach(() => {
    scanDirs.length = 0;
    runFfmpegProcess.mockClear();
    rmSync(images, { recursive: true, force: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('coalesces concurrent calls into one scan with a per-run candidate dir, then hits cache', async () => {
    const a = extractLastFrame(ID);
    const b = extractLastFrame(ID);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(runFfmpegProcess).toHaveBeenCalledTimes(1);
    expect(rb).toEqual(ra);
    expect(ra.filename).toBe(`anchor-${ID}.png`);
    expect(scanDirs[0]).toMatch(new RegExp(`anchorcand-${ID}-[0-9a-f-]{36}$`));

    await extractLastFrame(ID);
    expect(runFfmpegProcess).toHaveBeenCalledTimes(1);
  });
});
