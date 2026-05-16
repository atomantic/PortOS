import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = join(tmpdir(), `portos-music-test-${process.pid}-${Date.now()}`);
const FAKE_MUSIC_DIR = join(TEST_HOME, 'music');

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, music: FAKE_MUSIC_DIR },
    ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })),
  };
});

const {
  listMusicLibrary,
  importUploadedTrack,
  deleteMusicTrack,
  statMusicTrack,
  isSupportedMusicUpload,
  buildStoredFilename,
  deriveDefaultLabel,
  assertSafeMusicFilename,
  MUSIC_SOURCE,
  SUPPORTED_AUDIO_EXTENSIONS,
} = await import('./musicLibrary.js');

beforeEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
  await mkdir(FAKE_MUSIC_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('isSupportedMusicUpload', () => {
  it('accepts MP3/WAV/M4A/OGG/FLAC by extension when MIME is audio/*', () => {
    for (const ext of SUPPORTED_AUDIO_EXTENSIONS) {
      expect(isSupportedMusicUpload({ originalname: `track${ext}`, mimetype: 'audio/mpeg' })).toBe(true);
    }
  });

  it('accepts application/octet-stream when extension is known (drag-drop browsers)', () => {
    expect(isSupportedMusicUpload({ originalname: 'track.mp3', mimetype: 'application/octet-stream' })).toBe(true);
  });

  it('accepts video/mp4 only when extension is .m4a (Safari quirk)', () => {
    expect(isSupportedMusicUpload({ originalname: 'audio.m4a', mimetype: 'video/mp4' })).toBe(true);
    expect(isSupportedMusicUpload({ originalname: 'movie.mp4', mimetype: 'video/mp4' })).toBe(false);
  });

  it('rejects unknown extensions even with audio/* MIME', () => {
    expect(isSupportedMusicUpload({ originalname: 'track.aiff', mimetype: 'audio/aiff' })).toBe(false);
  });

  it('rejects null/empty input', () => {
    expect(isSupportedMusicUpload(null)).toBe(false);
    expect(isSupportedMusicUpload({})).toBe(false);
  });
});

describe('buildStoredFilename', () => {
  it('preserves a known extension', () => {
    expect(buildStoredFilename('My Song.wav')).toMatch(/^music-[0-9a-f-]+\.wav$/);
  });

  it('falls back to .mp3 for unknown/missing extension', () => {
    expect(buildStoredFilename('untitled')).toMatch(/^music-[0-9a-f-]+\.mp3$/);
    expect(buildStoredFilename('audio.xyz')).toMatch(/^music-[0-9a-f-]+\.mp3$/);
  });

  it('generates distinct filenames per call', () => {
    const a = buildStoredFilename('track.mp3');
    const b = buildStoredFilename('track.mp3');
    expect(a).not.toBe(b);
  });
});

describe('deriveDefaultLabel', () => {
  it('strips the extension', () => {
    expect(deriveDefaultLabel('My Song.wav')).toBe('My Song');
  });

  it('leaves names without extension untouched', () => {
    expect(deriveDefaultLabel('untitled')).toBe('untitled');
  });
});

describe('assertSafeMusicFilename', () => {
  it('accepts well-formed library filenames', () => {
    expect(() => assertSafeMusicFilename('music-abc.mp3')).not.toThrow();
    expect(() => assertSafeMusicFilename('music-abc.wav')).not.toThrow();
  });

  it('rejects path traversal', () => {
    expect(() => assertSafeMusicFilename('../etc/passwd')).toThrow();
    expect(() => assertSafeMusicFilename('foo/bar.mp3')).toThrow();
    expect(() => assertSafeMusicFilename('..')).toThrow();
  });

  it('rejects unsupported extensions', () => {
    expect(() => assertSafeMusicFilename('foo.aiff')).toThrow();
  });
});

describe('listMusicLibrary', () => {
  it('returns an empty list on a fresh install (no dir yet)', async () => {
    await rm(FAKE_MUSIC_DIR, { recursive: true, force: true });
    const tracks = await listMusicLibrary();
    expect(tracks).toEqual([]);
    // ensureDir should have created the directory by the time we return
    expect(existsSync(FAKE_MUSIC_DIR)).toBe(true);
  });

  it('lists only known audio extensions and skips other files', async () => {
    await writeFile(join(FAKE_MUSIC_DIR, 'a.mp3'), Buffer.from('a'));
    await writeFile(join(FAKE_MUSIC_DIR, 'b.wav'), Buffer.from('bb'));
    await writeFile(join(FAKE_MUSIC_DIR, 'cover.png'), Buffer.from('ccc'));
    await writeFile(join(FAKE_MUSIC_DIR, 'notes.txt'), Buffer.from('dddd'));
    const tracks = await listMusicLibrary();
    const names = tracks.map((t) => t.filename).sort();
    expect(names).toEqual(['a.mp3', 'b.wav']);
  });

  it('sorts newest-first', async () => {
    // Stagger mtimes by writing then touching forward in time
    await writeFile(join(FAKE_MUSIC_DIR, 'older.mp3'), Buffer.from('o'));
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(FAKE_MUSIC_DIR, 'newer.mp3'), Buffer.from('n'));
    const tracks = await listMusicLibrary();
    expect(tracks[0].filename).toBe('newer.mp3');
    expect(tracks[1].filename).toBe('older.mp3');
  });

  it('exposes label + sizeBytes + updatedAt on each entry', async () => {
    await writeFile(join(FAKE_MUSIC_DIR, 'theme.mp3'), Buffer.from('hello'));
    const [track] = await listMusicLibrary();
    expect(track).toMatchObject({
      filename: 'theme.mp3',
      label: 'theme',
      sizeBytes: 5,
    });
    expect(typeof track.updatedAt).toBe('string');
    expect(track.updatedAt.endsWith('Z')).toBe(true);
  });
});

describe('importUploadedTrack', () => {
  it('copies the temp upload into PATHS.music and returns a uuid filename', async () => {
    const tmp = join(TEST_HOME, 'upload-tmp.mp3');
    await writeFile(tmp, Buffer.from('audio bytes'));
    const { filename, sizeBytes } = await importUploadedTrack(tmp, 'My Theme.mp3');
    expect(filename).toMatch(/^music-[0-9a-f-]+\.mp3$/);
    expect(sizeBytes).toBe(11);
    // Destination written
    const written = await readFile(join(FAKE_MUSIC_DIR, filename));
    expect(written.toString()).toBe('audio bytes');
    // Temp source cleaned up
    expect(existsSync(tmp)).toBe(false);
  });

  it('is robust when the temp file lives on a different fs (copy not rename)', async () => {
    // We can't easily simulate EXDEV here, but verify the copy-then-unlink
    // order succeeds when both paths are local.
    const tmp = join(TEST_HOME, 'upload-tmp.wav');
    await writeFile(tmp, Buffer.from('wav'));
    const { filename } = await importUploadedTrack(tmp, 'a.wav');
    expect(existsSync(join(FAKE_MUSIC_DIR, filename))).toBe(true);
  });
});

describe('statMusicTrack', () => {
  it('returns shape when the file exists', async () => {
    await writeFile(join(FAKE_MUSIC_DIR, 'theme.mp3'), Buffer.from('hi'));
    const result = await statMusicTrack('theme.mp3');
    expect(result).toMatchObject({ filename: 'theme.mp3', label: 'theme', sizeBytes: 2 });
  });

  it('returns null when missing — one syscall, not a list-and-find', async () => {
    expect(await statMusicTrack('ghost.mp3')).toBeNull();
  });

  it('throws on path-traversal attempts', async () => {
    await expect(statMusicTrack('../etc/passwd')).rejects.toThrow();
  });
});

describe('MUSIC_SOURCE', () => {
  it('matches the sanitizer source allowlist in issues.js', () => {
    expect(MUSIC_SOURCE).toMatchObject({
      UPLOAD: 'upload',
      LIBRARY: 'library',
      GEN: 'gen',
    });
  });
});

describe('deleteMusicTrack', () => {
  it('removes the file and returns true when it existed', async () => {
    await writeFile(join(FAKE_MUSIC_DIR, 'doomed.mp3'), Buffer.from('x'));
    const result = await deleteMusicTrack('doomed.mp3');
    expect(result).toBe(true);
    expect(existsSync(join(FAKE_MUSIC_DIR, 'doomed.mp3'))).toBe(false);
  });

  it('returns false when the file was already gone', async () => {
    const result = await deleteMusicTrack('missing.mp3');
    expect(result).toBe(false);
  });

  it('throws on path-traversal attempts (never touches the FS)', async () => {
    await expect(deleteMusicTrack('../../etc/passwd')).rejects.toThrow();
  });
});
