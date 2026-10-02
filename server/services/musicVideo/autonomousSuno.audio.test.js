import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import { execFile } from '../../lib/childProcess.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { generateSunoSong } from './autonomousSuno.js';

const ffmpeg = await findFfmpeg();
const execFileAsync = promisify(execFile);
const SONG = '22222222-2222-2222-2222-222222222222';

// Exercise the default decoder through the import boundary, with synthetic
// bytes delivered by a completed browser export. No live Suno or provider calls.
function completedExport(bytes) {
  const page = new EventEmitter();
  let path;
  page.goto = async () => {};
  page.url = () => `https://suno.com/song/${SONG}`;
  page.close = async () => {};
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
    importAudio: vi.fn(async (target, name) => {
      expect(await readFile(target)).toEqual(bytes);
      expect(name).toBe('song.m4a');
      return { filename: 'example.m4a', sizeBytes: bytes.length };
    }),
    savedPath: () => path,
  };
}

describe.skipIf(!ffmpeg)('Suno real M4A decoder', () => {
  it.each(['aac', 'libopus'])('imports completed %s M4A unchanged and rejects a truncated faststart body', async (codec) => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-suno-fixture-'));
    try {
      const fixture = join(dir, 'example.m4a');
      await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', codec, '-movflags', '+faststart', '-f', 'mp4', fixture], { timeout: 15_000 });
      const bytes = await readFile(fixture);
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

  it.each(['html', 'malformed-container'])('rejects %s without importing and removes the staged download', async (kind) => {
    const bytes = Buffer.alloc(200 * 1024, kind === 'html' ? '<html>private-body' : 0);
    if (kind !== 'html') bytes.write('ftyp', 4);
    const w = completedExport(bytes);
    await expect(generateSunoSong({}, w)).rejects.toMatchObject({ code: 'SUNO_AUDIO_INVALID' });
    expect(w.importAudio).not.toHaveBeenCalled();
    await expect(stat(w.savedPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
