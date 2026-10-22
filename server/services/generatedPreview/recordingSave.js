/**
 * Saves a real-time preview recording into Media History.
 *
 * The page's MediaRecorder WebM is read out of the preview browser in slices
 * into a private temp file, re-encoded to H.264/AAC MP4 (faststart, even
 * dimensions) so it plays and downloads everywhere, then committed through the
 * gallery upload path, which writes the history entry and thumbnail. Without
 * ffmpeg the WebM itself is saved.
 */
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { AAC_ENCODE_ARGS, H264_ENCODE_ARGS, findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';

// The page already holds the whole blob in memory; this bounds the disk copy.
const RECORDING_CAP = 1024 * 1024 * 1024;
const SLICE_BYTES = 4 * 1024 * 1024;
const MAX_TITLE = 190;

const BLOB_INFO = `(() => {
  const blob = window.__portosLastBlob;
  return blob instanceof Blob ? { bytes: blob.size } : null;
})()`;

// FileReader encodes natively; a JS byte loop over megabytes stalls the page.
const sliceScript = (start, end) => `new Promise((resolve, reject) => {
  const blob = window.__portosLastBlob;
  if (!(blob instanceof Blob)) { resolve(null); return; }
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(reader.error || new Error('read failed'));
  reader.readAsDataURL(blob.slice(${start}, ${end}));
})`;

const mp4Args = (input, output) => [
  '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  ...H264_ENCODE_ARGS, ...AAC_ENCODE_ARGS,
  '-movflags', '+faststart', '-y', output,
];

/**
 * Returns the Media History entry, or null when the page holds no recording.
 * `deps` replaces ffmpeg discovery, the encoder and the gallery save in tests.
 */
export async function saveRecordingToMediaHistory(page, { title = '', deps = {} } = {}) {
  const info = await page.evaluate(BLOB_INFO);
  if (!info) return null;
  if (!info.bytes) throw new ServerError('The recording was empty.', { status: 422, code: 'RECORDING_EMPTY' });
  if (info.bytes > RECORDING_CAP) throw new ServerError('The recording is too large to save.', { status: 413, code: 'RECORDING_TOO_LARGE' });
  const {
    ffmpeg = await findFfmpeg(),
    run = runFfmpegProcess,
    save = (await import('../videoUpload.js')).saveUploadedGalleryVideoFile,
  } = deps;
  const dir = await mkdtemp(join(tmpdir(), 'portos-recording-'));
  try {
    const webm = join(dir, 'recording.webm');
    const file = await open(webm, 'w');
    try {
      for (let start = 0; start < info.bytes; start += SLICE_BYTES) {
        const data = await page.evaluate(sliceScript(start, Math.min(info.bytes, start + SLICE_BYTES)));
        if (data == null) throw new Error('the recording was released before it was saved');
        await file.write(Buffer.from(data, 'base64'));
      }
    } finally {
      await file.close();
    }
    await page.evaluate('window.__portosLastBlob = null').catch(() => {});
    const name = String(title || '').trim().slice(0, MAX_TITLE) || 'Code animation recording';
    if (!ffmpeg) return await save(webm, `${name}.webm`);
    const mp4 = join(dir, 'recording.mp4');
    const encoded = await run({ bin: ffmpeg, args: mp4Args(webm, mp4) });
    if (!encoded.ok) throw new Error(`MP4 encode failed: ${encoded.reason}`);
    return await save(mp4, `${name}.mp4`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
