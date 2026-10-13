import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const state = vi.hoisted(() => ({ root: null, board: null }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const original = await importOriginal();
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  state.root = await mkdtemp(join(tmpdir(), 'board-frames-test-'));
  return { ...original, PATHS: { ...original.PATHS, data: state.root, videos: join(state.root, 'videos'), images: join(state.root, 'images') } };
});
vi.mock('./db.js', () => ({
  getBoard: async () => state.board,
  appendImportedItems: async (_id, imported) => {
    const seen = new Set(state.board.items.map((it) => it.source));
    const fresh = imported.filter((it) => !seen.has(it.source));
    state.board = { ...state.board, items: [...state.board.items, ...fresh] };
    return { board: state.board, added: fresh.length };
  },
}));
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated: vi.fn() }));

const { extractItemFrames } = await import('./collage.js');
const { findFfmpeg } = await import('../../lib/ffmpeg.js');
const exec = promisify(execFile);
let ffmpeg = null;

beforeAll(async () => {
  ffmpeg = await findFfmpeg();
  if (!ffmpeg) return;
  await mkdir(join(state.root, 'videos'), { recursive: true });
  await exec(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', join(state.root, 'videos', 'clip.mp4')]);
}, 30000);
afterAll(() => rm(state.root, { recursive: true, force: true }));
beforeEach(() => {
  state.board = { id: 'mb-1', items: [{ id: 'v1', type: 'video', mediaKey: 'video:clip.mp4', caption: null }] };
});

describe('extractItemFrames', () => {
  it('adds the picked moments once each, in timeline order, at source resolution', async (context) => {
    if (!ffmpeg) context.skip();
    const res = await extractItemFrames('mb-1', 'v1', { times: [1.5, 0.25, 0.25] });
    expect(res.added).toBe(2);
    const frames = state.board.items.filter((it) => it.type === 'image');
    expect(frames.map((it) => it.source)).toEqual(['frame:clip.mp4@250ms', 'frame:clip.mp4@1500ms']);
    expect(frames[0].caption).toBe('Frame at 0:00.25 of clip.mp4');
    const meta = await sharp(join(state.root, 'images', frames[1].imageUrl.split('/').pop())).metadata();
    expect([meta.width, meta.height]).toEqual([640, 360]);
    // Picking the same moment again adds nothing; a new pick adds one more.
    expect((await extractItemFrames('mb-1', 'v1', { times: [1.5, 1] })).added).toBe(1);
  });

  it('still samples evenly spaced frames from a count', async (context) => {
    if (!ffmpeg) context.skip();
    const res = await extractItemFrames('mb-1', 'v1', { count: 3 });
    expect(res.added).toBe(3);
    expect(state.board.items.at(-1).source).toBe('frame:clip.mp4#3of3');
  });
});
