import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { browserSuiteCanRun } from '../../lib/browserSuiteGate.js';
import { pcmAudioInfo, prepareSourceAudioWindow } from './sourceAudio.js';

const mocks = vi.hoisted(() => ({ master: '' }));
vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: { run: (_kind, _resource, fn) => fn() } }));
vi.mock('../musicVideo/render.js', () => ({ resolveMasterAudioPath: async () => mocks.master }));
const bin = await findFfmpeg();
const canRun = browserSuiteCanRun('Source audio ffmpeg integration', { ffmpeg: bin });

function wav(samples = 48000) {
  const bytes = Buffer.alloc(44 + samples * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 4, 40);
  return bytes;
}
const savedUploads = PATHS.uploads;
let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'source-audio-ffmpeg-'));
  PATHS.uploads = root;
  mocks.master = join(root, 'master.wav');
});
afterEach(async () => { PATHS.uploads = savedUploads; await rm(root, { recursive: true, force: true }); });

describe.skipIf(!canRun)('real ffmpeg source audio windows', () => {
  it('pads a frame window past the song end with silence using real ffmpeg', async () => {
    const recording = wav();
    recording.fill(0x12, 44);
    await writeFile(mocks.master, recording);
    const audio = await prepareSourceAudioWindow({ project: {}, scene: { startSec: 0.5, endSec: 1 }, numFrames: 14, fps: 24 });
    const clip = await readFile(audio.audioFilePath);
    expect(pcmAudioInfo(clip)?.sampleCount).toBe(26000);
    expect(audio.audioConditioning.endSample - audio.audioConditioning.startSample).toBe(26000);
    const dataAt = clip.indexOf(Buffer.from('data')) + 8;
    expect(clip.subarray(dataAt, dataAt + 24000 * 4)).toEqual(recording.subarray(44 + 24000 * 4));
    expect(clip.subarray(dataAt + 24000 * 4)).toEqual(Buffer.alloc(2000 * 4));
  });

  it('refuses broken input with real ffmpeg and removes the failed slice', async () => {
    await writeFile(mocks.master, 'not an audio recording');
    await expect(prepareSourceAudioWindow({ project: {}, scene: { startSec: 0, endSec: 1 }, numFrames: 25, fps: 24 }))
      .rejects.toMatchObject({ code: 'MUSIC_VIDEO_AUDIO_WINDOW_INVALID' });
    expect(await readdir(root)).toEqual(['master.wav']);
  });

});
