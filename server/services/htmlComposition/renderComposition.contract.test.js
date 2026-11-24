import { afterAll, describe, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { htmlCompositionContractSchema, htmlCompositionContractSchemaFor } from '../../lib/htmlCompositionValidation.js';

const { seen } = vi.hoisted(() => ({ seen: { contract: null } }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-composition-contract-'),
}));
vi.mock('./browser.js', () => ({
  openComposition: async () => {
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
const { renderComposition, stageMusicVideoComposition } = await import('./index.js');
const { encodeComposition } = await import('./encode.js');
const { videoGenEvents } = await import('../videoGen/events.js');

const frame = { fps: 12, width: 1280, height: 720 };

async function sourceDir() {
  const directory = `compositions/${randomUUID()}`;
  await mkdir(join(PATHS.data, directory), { recursive: true });
  await writeFile(join(PATHS.data, directory, 'index.html'), '<html></html>');
  return directory;
}

afterAll(() => cleanupTempDataRoots());

describe('renderComposition contract', () => {
  it('keeps the public contract at 120s and a music-video document at its song length', () => {
    expect(htmlCompositionContractSchema.safeParse({ ...frame, durationSec: 120 }).success).toBe(true);
    expect(htmlCompositionContractSchema.safeParse({ ...frame, durationSec: 121 }).success).toBe(false);
    expect(htmlCompositionContractSchemaFor(180).safeParse({ ...frame, durationSec: 180 }).success).toBe(true);
    expect(htmlCompositionContractSchemaFor(180).safeParse({ ...frame, durationSec: 181 }).success).toBe(false);
  });

  it('rejects a song-length page on the public path before capture', async () => {
    encodeComposition.mockClear();
    seen.contract = { ...frame, durationSec: 180 };
    const directory = await sourceDir();
    await expect(renderComposition({ jobId: randomUUID(), directory })).rejects.toThrow('durationSec');
    expect(encodeComposition).not.toHaveBeenCalled();
  });

  it('renders the extra frames the page declares in formats, and refuses one it does not', async () => {
    encodeComposition.mockClear();
    seen.contract = { fps: 12, width: 1920, height: 1080, durationSec: 10, formats: ['1080x1920'], layout: true };
    await expect(renderComposition({ jobId: randomUUID(), directory: await sourceDir(), formats: ['landscape', 'vertical'] }))
      .rejects.toThrow('thumbnail skipped');
    expect(encodeComposition.mock.calls.map(([, contract]) => `${contract.width}x${contract.height}`)).toEqual(['1920x1080', '1080x1920']);
    encodeComposition.mockClear();
    await expect(renderComposition({ jobId: randomUUID(), directory: await sourceDir(), formats: ['square'] }))
      .rejects.toThrow('portosComposition.formats must include 1080x1080');
    expect(encodeComposition).not.toHaveBeenCalled();
  });

  it('reports frame progress with a remaining-time estimate', async () => {
    videoGenEvents.emit.mockClear();
    seen.contract = { ...frame, durationSec: 10 };
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(2000);
    encodeComposition.mockImplementationOnce(async (_page, _contract, _path, { onProgress }) => { onProgress(0.5, { frame: 60 }); return {}; });
    const jobId = randomUUID();
    await expect(renderComposition({ jobId, directory: await sourceDir() })).rejects.toThrow('thumbnail skipped');
    now.mockRestore();
    expect(videoGenEvents.emit).toHaveBeenCalledWith('progress', expect.objectContaining({
      generationId: jobId, step: 60, totalSteps: 120, etaMs: 1000, message: 'Rendering frame 60/120',
    }));
  });
});

describe('stageMusicVideoComposition', () => {
  it('writes song.json into a private copy and leaves the source untouched', async () => {
    const directory = await sourceDir();
    const jobId = randomUUID();
    const staged = await stageMusicVideoComposition(directory, jobId, {
      beats: [0, 1], downbeats: [0], sections: [{ label: 'verse', startSec: 0, endSec: 8 }], features: [], words: [{ w: 'go', startSec: 1, endSec: 1.2, conf: 'matched' }],
    });
    expect(staged.directory).toBe(`music-video-song-renders/${jobId}/composition`);
    expect(JSON.parse(await readFile(join(PATHS.data, staged.directory, 'song.json'), 'utf8'))).toEqual({
      beats: [0, 1], downbeats: [0], sections: [{ label: 'verse', startSec: 0, endSec: 8 }],
      features: null, words: [{ w: 'go', startSec: 1, endSec: 1.2, conf: 'matched' }],
    });
    await expect(access(join(PATHS.data, directory, 'song.json'))).rejects.toThrow();
  });
});
