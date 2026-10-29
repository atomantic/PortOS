import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './433-quarantine-media-manifests.js';

let rootDir;
afterEach(async () => {
  vi.restoreAllMocks();
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

async function fixture(dir, name, bytes) {
  const path = join(rootDir, 'data', dir, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

// A short, valid PCM WAV: media bytes must survive the scan unchanged.
const audio = Buffer.alloc(46);
audio.write('RIFF'); audio.writeUInt32LE(38, 4); audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
audio.write('data', 36); audio.writeUInt32LE(2, 40);
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nlocal.wav\n';

describe('migration 433 — persisted media manifests', () => {
  it('quarantines recursively across all stores, preserves audio and skips symlinks and reruns', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'migration-433-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const paths = [];
    for (const dir of ['music', 'uploads', 'videos', 'audio', 'images', 'image-refs']) {
      paths.push(await fixture(dir, 'private-user/nested/disguised.mp3', playlist));
    }
    const valid = await fixture('music', 'valid.wav', audio);
    const outside = join(rootDir, 'outside.mp3');
    await writeFile(outside, playlist);
    await symlink(outside, join(rootDir, 'data', 'music', 'linked.mp3'));
    await expect(migration.up({ rootDir })).resolves.toEqual({ quarantined: 6 });
    for (const path of paths) {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(`${path}.quarantined`, 'utf8')).toBe(playlist);
    }
    expect(await readFile(valid)).toEqual(audio);
    expect(await readFile(outside, 'utf8')).toBe(playlist);
    expect(log.mock.calls).toEqual(Array.from({ length: 6 }, () => ['📦 Quarantined hls media manifest']));
    log.mockClear();
    await expect(migration.up({ rootDir })).resolves.toEqual({ quarantined: 0 });
    expect(log).not.toHaveBeenCalled();
  });

  it('checks a full post-ID3 probe when the tag ends at the leading window boundary', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'migration-433-'));
    const tagLength = (1 << 20) - 1;
    const tag = Buffer.alloc(tagLength);
    tag.write('ID3'); tag[3] = 4;
    const size = tagLength - 10;
    for (let i = 0; i < 4; i++) tag[9 - i] = (size >>> (i * 7)) & 0x7f;
    const bytes = Buffer.concat([tag, Buffer.from(playlist)]);
    const path = await fixture('audio', 'tagged.mp3', bytes);
    await expect(migration.up({ rootDir })).resolves.toEqual({ quarantined: 1 });
    // Buffer#equals, not toEqual: deep-equality over a 1 MiB buffer costs seconds.
    expect((await readFile(`${path}.quarantined`)).equals(bytes)).toBe(true);
  });

  it('never overwrites an existing quarantine: takes the next free numbered name and tolerates missing stores', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'migration-433-'));
    await expect(migration.up({ rootDir })).resolves.toEqual({ quarantined: 0 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = await fixture('uploads', 'disguised.mp4', playlist);
    await writeFile(`${path}.quarantined`, 'previous evidence');
    await expect(migration.up({ rootDir })).resolves.toEqual({ quarantined: 1 });
    expect(await readFile(`${path}.quarantined`, 'utf8')).toBe('previous evidence');
    expect(await readFile(`${path}.1.quarantined`, 'utf8')).toBe(playlist);
    expect((await readdir(join(rootDir, 'data', 'uploads'))).sort()).toEqual(['disguised.mp4.1.quarantined', 'disguised.mp4.quarantined']);
    await expect(migration.up({ rootDir })).resolves.toEqual({ quarantined: 0 });
  });

  it('survives the restore shape: same bytes present as both the original and its quarantine', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'migration-433-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = await fixture('music', 'clip.mp3', playlist);
    await writeFile(`${path}.quarantined`, playlist);
    await writeFile(`${path}.1.quarantined`, 'earlier');
    await expect(migration.up({ rootDir })).resolves.toEqual({ quarantined: 1 });
    expect(await readFile(`${path}.2.quarantined`, 'utf8')).toBe(playlist);
    expect(await readFile(`${path}.1.quarantined`, 'utf8')).toBe('earlier');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
