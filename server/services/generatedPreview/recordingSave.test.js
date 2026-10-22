import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { saveRecordingToMediaHistory } from './recordingSave.js';

// A page whose recording blob is `bytes`, read back through the same slice
// script the preview browser runs.
const pageWith = (bytes) => {
  const window = { __portosLastBlob: new Blob([bytes], { type: 'video/webm' }) };
  class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = `data:video/webm;base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload();
      });
    }
  }
  return { window, evaluate: async (source) => new Function('window', 'FileReader', 'Blob', `return ${source}`)(window, FileReader, Blob) };
};

// Uniquely catches a slice boundary dropping or duplicating bytes, and the
// saved file not being the H.264 MP4 the viewer downloads.
describe('saveRecordingToMediaHistory', () => {
  it('copies every slice of the WebM, encodes an MP4, and saves it under the animation title', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 123);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    const page = pageWith(bytes);
    let input = null;
    const run = vi.fn(async ({ args }) => {
      input = await readFile(args[args.indexOf('-i') + 1]);
      return { ok: true };
    });
    const save = vi.fn(async (path, name) => ({ id: 'upload-1', filename: 'upload-1.mp4', path, name }));
    const entry = await saveRecordingToMediaHistory(page, { title: 'Station boot', deps: { ffmpeg: '/bin/ffmpeg', run, save } });

    expect(Buffer.compare(input, bytes)).toBe(0);
    const { args } = run.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(['libx264', 'aac', '+faststart']));
    expect(args.at(-1)).toMatch(/recording\.mp4$/);
    expect(save).toHaveBeenCalledWith(args.at(-1), 'Station boot.mp4');
    expect(entry.id).toBe('upload-1');
    expect(page.window.__portosLastBlob).toBeNull();
  });

  it('keeps the WebM without ffmpeg, and refuses an empty or missing recording', async () => {
    const save = vi.fn(async () => ({ id: 'upload-2', filename: 'upload-2.webm' }));
    await saveRecordingToMediaHistory(pageWith(Buffer.from('webm')), { deps: { ffmpeg: null, save } });
    expect(save).toHaveBeenCalledWith(expect.stringMatching(/recording\.webm$/), 'Code animation recording.webm');

    await expect(saveRecordingToMediaHistory(pageWith(Buffer.alloc(0)), { deps: { ffmpeg: null, save } }))
      .rejects.toMatchObject({ code: 'RECORDING_EMPTY' });
    const none = { evaluate: async () => null };
    await expect(saveRecordingToMediaHistory(none, { deps: { ffmpeg: null, save } })).resolves.toBeNull();
  });
});
