vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: { run: (_kind, _resource, fn) => fn() } }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PATHS, sha256Text } from '../../lib/fileUtils.js';
import { federatedMediaVideoJobSubmissionSchema } from '../../lib/validation.js';
import { storeFederatedMediaAsset, findFederatedMediaAsset } from './assetStore.js';
import { assertCurrentSourceAudioWindow, pcmAudioInfo, prepareSourceAudioWindow, resolveSourceAudioPath } from './sourceAudio.js';
import { applyRemoteInputAssets } from './inputAssets.js';

const mocks = vi.hoisted(() => ({ master: '', run: vi.fn() }));
vi.mock('../musicVideo/render.js', () => ({ resolveMasterAudioPath: async () => mocks.master }));
vi.mock('../../lib/ffmpeg.js', () => ({ findFfmpeg: async () => 'fixture-ffmpeg', runFfmpegProcess: mocks.run }));

function wav(samples = 48000) {
  const bytes = Buffer.alloc(44 + samples * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 4, 40);
  return bytes;
}
const saved = { uploads: PATHS.uploads, federatedMediaInbox: PATHS.federatedMediaInbox };
let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'source-audio-test-'));
  PATHS.uploads = root; PATHS.federatedMediaInbox = root;
  mocks.master = join(root, 'master.wav');
  await writeFile(mocks.master, wav());
  mocks.run.mockImplementation(async ({ args }) => { await writeFile(args.at(-1), wav()); return { ok: true }; });
});
afterEach(async () => { Object.assign(PATHS, saved); await rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });

const provenance = (bytes) => ({ sourceSha256: 'a'.repeat(64), clipSha256: sha256Text(bytes), sampleRate: 48000,
  channels: 2, startSample: 96000, endSample: 144000, sampleCount: 48000 });
const request = (bytes, assetId) => ({ kind: 'video', engine: 'local', modelId: 'example-model', prompt: 'Moving light',
  fps: 24, numFrames: 25, audioConditioning: provenance(bytes), sourceAudio: { assetId } });

describe('supplied-audio transport boundary', () => {
  it('stages exact PCM with caller-scoped replay, rejects cross-peer, expired, traversal and symlink references', async () => {
    const body = wav();
    const upload = () => storeFederatedMediaAsset({ callerId: 'example-peer', body, mimeType: 'audio/wav', declaredSha256: sha256Text(body) });
    const receipt = await upload();
    expect((await upload()).assetId).toBe(receipt.assetId);
    expect(federatedMediaVideoJobSubmissionSchema.parse(request(body, receipt.assetId)).audioConditioning.sampleCount).toBe(48000);
    expect(await findFederatedMediaAsset('another-peer', receipt.assetId)).toBeNull();
    expect(await findFederatedMediaAsset('example-peer', `../${receipt.assetId}`)).toBeNull();
    const path = (await findFederatedMediaAsset('example-peer', receipt.assetId)).path;
    await utimes(path, new Date(0), new Date(0));
    expect(await findFederatedMediaAsset('example-peer', receipt.assetId)).toBeNull();
    await rm(path); await symlink(mocks.master, path);
    expect(await findFederatedMediaAsset('example-peer', receipt.assetId)).toBeNull();
  });

  it('refuses truncated or disguised PCM, mismatched hashes and unpaired provenance', async () => {
    const body = wav();
    expect(pcmAudioInfo(body.subarray(0, body.length - 1))).toBeNull();
    const wrongRate = Buffer.from(body); wrongRate.writeUInt32LE(44100, 24);
    expect(pcmAudioInfo(wrongRate)).toBeNull();
    await expect(storeFederatedMediaAsset({ callerId: 'p', body, mimeType: 'audio/wav', declaredSha256: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_ASSET_INTEGRITY' });
    const value = request(body, `${'b'.repeat(16)}-${sha256Text(body)}`);
    expect(federatedMediaVideoJobSubmissionSchema.safeParse({ ...value, audioConditioning: undefined }).success).toBe(false);
    expect(federatedMediaVideoJobSubmissionSchema.safeParse({ ...value, fps: undefined }).success).toBe(false);
    expect(federatedMediaVideoJobSubmissionSchema.safeParse({ ...value, numFrames: undefined }).success).toBe(false);
    expect(federatedMediaVideoJobSubmissionSchema.safeParse({ ...value, audioConditioning: { ...value.audioConditioning, endSample: 144001 } }).success).toBe(false);
    expect(federatedMediaVideoJobSubmissionSchema.safeParse({ ...value, sourceAudio: { assetId: `${'b'.repeat(16)}-${'f'.repeat(64)}` } }).success).toBe(false);
  });

  it('cuts the requested sample window and refuses a short decode before enqueue', async () => {
    const audio = await prepareSourceAudioWindow({ project: {}, scene: { startSec: 2 }, numFrames: 25, fps: 24 });
    expect(mocks.run.mock.calls[0][0].args).toContain('aresample=48000,atrim=start_sample=96000:end_sample=144000,asetpts=PTS-STARTPTS');
    expect(audio.audioConditioning).toEqual({ ...provenance(await readFile(audio.audioFilePath)), sourceSha256: sha256Text(wav()) });
    // The recording fixture hashes to the same bytes as the one-second slice.
    expect(audio.audioConditioning.sourceSha256).toBe(sha256Text(wav()));
    mocks.run.mockImplementation(async ({ args }) => { await writeFile(args.at(-1), wav(24000)); return { ok: true }; });
    await expect(prepareSourceAudioWindow({ project: {}, scene: { startSec: 2 }, numFrames: 25, fps: 24 }))
      .rejects.toMatchObject({ code: 'MUSIC_VIDEO_AUDIO_WINDOW_INVALID' });
  });

  it('never uploads an audio path outside the approved root, including a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-audio-test-'));
    try {
      const path = join(outside, 'other.wav'); await writeFile(path, wav());
      const link = join(root, 'escape.wav'); await symlink(path, link);
      expect(resolveSourceAudioPath(link)).toBeNull();
      const requestJson = vi.fn();
      await expect(applyRemoteInputAssets({}, [{ role: 'sourceAudio', path: link }], { requestJson, emitStatus: vi.fn() }))
        .rejects.toMatchObject({ code: 'MEDIA_PROVIDER_INPUT_UNREADABLE' });
      expect(requestJson).not.toHaveBeenCalled();
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it('refuses a different selected recording even when the linked track id is unchanged', async () => {
    const project = { trackId: 'same-track' };
    const audio = await prepareSourceAudioWindow({ project, scene: { startSec: 0, endSec: 1 }, numFrames: 25, fps: 24 });
    await expect(assertCurrentSourceAudioWindow(project, audio.audioConditioning)).resolves.toBeUndefined();
    mocks.master = join(root, 'another-take.wav');
    await writeFile(mocks.master, wav(96000));
    await expect(assertCurrentSourceAudioWindow(project, audio.audioConditioning)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_AUDIO_SOURCE_CHANGED' });
  });
});
