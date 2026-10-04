import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const musicDir = await mkdtemp(join(tmpdir(), 'portos-take-publication-test-'));

vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...(await importOriginal()),
  PATHS: { ...(await importOriginal()).PATHS, music: musicDir },
}));
vi.mock('../lib/wavAudioFile.js', () => ({
  writeWavAudioFile: vi.fn(async (wav, dir, base) => {
    const filename = `${base}.wav`;
    await writeFile(join(dir, filename), wav);
    return filename;
  }),
}));
vi.mock('./tracks/index.js', () => ({
  appendActiveTake: vi.fn(async (id, take) => ({ id, ...take })),
}));

const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { writeWavAudioFile } = await import('../lib/wavAudioFile.js');
const { appendActiveTake } = await import('./tracks/index.js');
const { publishMusicTake } = await import('./musicTakePublication.js');

afterAll(async () => { await rm(musicDir, { recursive: true, force: true }); });
beforeEach(() => vi.clearAllMocks());

it('stages encoding outside the cut and publishes bytes with the track row after release', async () => {
  const release = await acquireBackupSnapshotCut();
  const pending = publishMusicTake({
    trackId: 'track-1', wav: Buffer.from('synthetic audio'),
    take: { engine: 'code', durationSec: 1 },
  });
  try {
    await vi.waitFor(() => expect(writeWavAudioFile).toHaveBeenCalledOnce());
    expect(await readdir(musicDir)).toEqual([]);
    expect(appendActiveTake).not.toHaveBeenCalled();
  } finally {
    release();
  }
  const { track, filename } = await pending;
  expect(track.audioFilename).toBe(filename);
  expect(await readFile(join(musicDir, filename), 'utf8')).toBe('synthetic audio');
});
