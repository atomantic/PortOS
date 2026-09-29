import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { htmlCompositionContractSchema, htmlCompositionContractSchemaFor } from '../../lib/validation.js';

const { seen } = vi.hoisted(() => ({ seen: [] }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-song-render-'),
}));
vi.mock('./browser.js', () => ({
  openComposition: async (directory) => {
    const { readFile } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');
    const { PATHS } = await import('../../lib/fileUtils.js');
    try { seen.push(JSON.parse(await readFile(joinPath(PATHS.data, directory, 'song.json'), 'utf8'))); } catch { seen.push(null); }
    return { evaluate: async () => seen.contract, check() {}, close: async () => {} };
  },
}));
vi.mock('./encode.js', () => ({
  encodeComposition: vi.fn(async () => ({})),
  encodeContactSheet: vi.fn(),
  proofTimes: vi.fn(),
  synthesizeCompositionMusic: vi.fn(),
}));
vi.mock('../../lib/ffmpeg.js', () => ({ generateThumbnail: vi.fn(async () => { throw new Error('thumbnail skipped'); }) }));
vi.mock('../videoGen/history.js', () => ({ mutateVideoHistory: vi.fn() }));
vi.mock('../videoGen/events.js', () => ({ videoGenEvents: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock('../pipeline/audioMux.js', () => ({ resolveMusicTrackPath: vi.fn(async () => null) }));

const { PATHS } = await import('../../lib/fileUtils.js');
const { renderComposition } = await import('./index.js');
const { encodeComposition } = await import('./encode.js');

const frame = { fps: 12, width: 1280, height: 720 };

async function sourceDir() {
  const directory = `compositions/${randomUUID()}`;
  await mkdir(join(PATHS.data, directory), { recursive: true });
  await writeFile(join(PATHS.data, directory, 'index.html'), '<html></html>');
  return directory;
}

describe('music-video composition owner', () => {
  afterAll(() => cleanupTempDataRoots());

  it('keeps the public contract at 120s and the owner ceiling at the song, hard-capped at 900s', () => {
    expect(htmlCompositionContractSchema.safeParse({ ...frame, durationSec: 120 }).success).toBe(true);
    expect(htmlCompositionContractSchema.safeParse({ ...frame, durationSec: 121 }).success).toBe(false);
    expect(htmlCompositionContractSchemaFor(180).safeParse({ ...frame, durationSec: 180 }).success).toBe(true);
    expect(htmlCompositionContractSchemaFor(180).safeParse({ ...frame, durationSec: 181 }).success).toBe(false);
    expect(htmlCompositionContractSchemaFor(900).safeParse({ ...frame, durationSec: 900 }).success).toBe(true);
    expect(htmlCompositionContractSchemaFor(900).safeParse({ ...frame, durationSec: 901 }).success).toBe(false);
  });

  it('writes song.json before the snapshot and removes the scratch copy afterwards', async () => {
    seen.length = 0;
    encodeComposition.mockClear();
    seen.contract = { ...frame, durationSec: 180 };
    const directory = await sourceDir();
    const jobId = randomUUID();
    const master = join(PATHS.data, 'master.wav');
    await writeFile(master, Buffer.alloc(16));
    await expect(renderComposition({
      jobId, directory, owner: 'music-video', audio: { path: master, startSec: 60 }, maxDurationSec: 180,
      song: { beats: [0, 1], downbeats: [0], sections: [{ label: 'verse', startSec: 0, endSec: 8 }], features: [], words: [{ w: 'go', startSec: 1, endSec: 1.2, conf: 'matched' }] },
    })).rejects.toThrow('thumbnail skipped');
    expect(seen[0]).toEqual({
      beats: [0, 1], downbeats: [0], sections: [{ label: 'verse', startSec: 0, endSec: 8 }],
      features: null, words: [{ w: 'go', startSec: 1, endSec: 1.2, conf: 'matched' }],
    });
    expect(encodeComposition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ durationSec: 180 }), expect.any(String), expect.objectContaining({
      audio: { path: master, startSec: 60 }, musicPath: null,
    }));
    await expect(access(join(PATHS.data, directory, 'song.json'))).rejects.toThrow();
    await expect(access(join(PATHS.data, 'music-video-song-renders', jobId))).rejects.toThrow();
  });

  it('rejects a song-length page on the public path before capture', async () => {
    seen.length = 0;
    encodeComposition.mockClear();
    seen.contract = { ...frame, durationSec: 180 };
    const directory = await sourceDir();
    await expect(renderComposition({ jobId: randomUUID(), directory })).rejects.toThrow('durationSec');
    expect(seen[0]).toBeNull();
    expect(encodeComposition).not.toHaveBeenCalled();
  });

  it('rejects a composition longer than the 900s ceiling', async () => {
    encodeComposition.mockClear();
    seen.contract = { ...frame, durationSec: 901 };
    const directory = await sourceDir();
    const master = join(PATHS.data, 'master-long.wav');
    await writeFile(master, Buffer.alloc(8));
    await expect(renderComposition({
      jobId: randomUUID(), directory, owner: 'music-video', audio: { path: master, startSec: 0 }, maxDurationSec: 2000, song: {},
    })).rejects.toThrow('durationSec');
    expect(encodeComposition).not.toHaveBeenCalled();
  });

  it('does not let the owner option carry launch-video delivery', async () => {
    const directory = await sourceDir();
    const master = join(PATHS.data, 'master-launch.wav');
    await writeFile(master, Buffer.alloc(8));
    await expect(renderComposition({
      jobId: randomUUID(), directory, owner: 'music-video', audio: { path: master }, maxDurationSec: 30,
      launchVideo: { targetDurationSec: 15, appId: 'example', runId: 'run' },
    })).rejects.toThrow(/launch-video/);
  });
});
