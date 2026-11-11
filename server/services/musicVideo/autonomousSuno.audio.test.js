import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import { execFile } from '../../lib/childProcess.js';
import { findFfmpeg, findFfprobe } from '../../lib/ffmpeg.js';
import { generateSunoSong, __testing } from './autonomousSuno.js';

const { SUNO_RENDER_PROBE } = __testing;

const ffmpeg = await findFfmpeg();
const ffprobe = await findFfprobe();
const execFileAsync = promisify(execFile);
const SONG = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';
// The container comment Suno stamps on an export of `songId`.
const sunoComment = (songId) => `made with suno; created=2026-01-01T00:00:00Z; id=${songId}`;

// Exercise the default decoder and the default song-id reader through the
// import boundary, with synthetic bytes delivered by a completed browser
// export. No live Suno or provider calls.
function completedExport(bytes) {
  const page = new EventEmitter();
  let path;
  page.goto = async () => {};
  page.url = () => `https://suno.com/song/${SONG}`;
  page.close = async () => {};
  // The song page already shows a finished render, so the readiness wait
  // returns at once and the export under test starts.
  page.evaluate = async (_fn, arg) => (arg?.probe === SUNO_RENDER_PROBE
    ? { onSongPage: true, hasSongLink: true, clocks: ['0:02'], busyLabels: [], status: 'complete' }
    : undefined);
  // The page song's own menu is found and opens on the first click.
  page.waitForFunction = async () => true;
  page.locator = () => ({ click: async () => {}, waitFor: async () => {} });
  const download = {
    saveAs: async (target) => { path = target; await writeFile(target, bytes); },
    failure: async () => null, cancel: async () => {}, delete: async () => {},
  };
  page.getByRole = (_role, { name }) => {
    const button = {
      evaluate: async () => name === 'M4A',
      click: async () => { if (name instanceof RegExp) page.emit('download', download); },
    };
    return { ...button, first: () => button };
  };
  return {
    songIds: [SONG],
    connect: async () => ({ browser: { close: async () => {} }, context: { newPage: async () => page } }),
    // The fake page emits the browser download event; do not scan the install's
    // real download directory while testing decoder and import behavior.
    listDownloads: async () => ({ files: [] }),
    importAudio: vi.fn(async (target, name) => {
      expect(await readFile(target)).toEqual(bytes);
      expect(name).toBe('song.m4a');
      return { filename: 'example.m4a', sizeBytes: bytes.length };
    }),
    savedPath: () => path,
  };
}

// The bytes of a two-second M4A, stamped with `comment` when one is given.
async function m4aFixture(dir, codec, comment = null) {
  const fixture = join(dir, 'example.m4a');
  await execFileAsync(ffmpeg, [
    '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', codec,
    ...(comment ? ['-metadata', `comment=${comment}`] : []), '-movflags', '+faststart', '-f', 'mp4', fixture,
  ], { timeout: 15_000 });
  return readFile(fixture);
}

describe.skipIf(!ffmpeg || !ffprobe)('Suno real M4A decoder', () => {
  it.each(['aac', 'libopus'])('imports completed %s M4A unchanged and rejects a truncated faststart body', async (codec) => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-suno-fixture-'));
    try {
      const bytes = await m4aFixture(dir, codec, sunoComment(SONG));
      const good = completedExport(bytes);
      await expect(generateSunoSong({}, good)).resolves.toMatchObject({ filename: 'example.m4a' });
      expect(good.importAudio).toHaveBeenCalledOnce();
      await expect(stat(good.savedPath())).rejects.toMatchObject({ code: 'ENOENT' });

      const bad = completedExport(bytes.subarray(0, Math.floor(bytes.length * 0.6)));
      const error = await generateSunoSong({}, bad).catch(err => err);
      expect(error).toMatchObject({ code: 'SUNO_AUDIO_INVALID', context: { reason: 'decode_failed' } });
      expect(JSON.stringify({ message: error.message, context: error.context })).not.toMatch(/example\.m4a|portos-suno|Invalid|Error/);
      expect(bad.importAudio).not.toHaveBeenCalled();
      await expect(stat(bad.savedPath())).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Uniquely catches the real container comment being misread: a decodable
  // export of another song, or one that names no song, reaching the library.
  it("refuses a decodable M4A stamped with another song's id, or with none", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-suno-fixture-'));
    try {
      const other = completedExport(await m4aFixture(dir, 'aac', sunoComment(OTHER)));
      const wrong = await generateSunoSong({}, other).catch(err => err);
      expect(wrong).toMatchObject({ code: 'SUNO_AUDIO_WRONG_SONG', context: { stage: 'identify-audio', reason: 'song-id-mismatch' } });
      expect(JSON.stringify({ message: wrong.message, context: wrong.context })).not.toMatch(/song\.m4a|portos-suno|3333/);
      expect(other.importAudio).not.toHaveBeenCalled();
      await expect(stat(other.savedPath())).rejects.toMatchObject({ code: 'ENOENT' });

      const plain = completedExport(await m4aFixture(dir, 'aac'));
      await expect(generateSunoSong({}, plain)).rejects.toMatchObject({ code: 'SUNO_AUDIO_UNVERIFIED', context: { reason: 'song-id-missing' } });
      expect(plain.importAudio).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['html', 'malformed-container'])('rejects %s without importing and removes the staged download', async (kind) => {
    const bytes = Buffer.alloc(200 * 1024, kind === 'html' ? '<html>private-body' : 0);
    if (kind !== 'html') bytes.write('ftyp', 4);
    const w = completedExport(bytes);
    await expect(generateSunoSong({}, w)).rejects.toMatchObject({ code: 'SUNO_AUDIO_INVALID' });
    expect(w.importAudio).not.toHaveBeenCalled();
    await expect(stat(w.savedPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
