import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CANCEL_ALREADY_TERMINAL } from '../../lib/cancelResponse.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { execFile } from '../../lib/childProcess.js';
import { runFfmpegProcess } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/paths.js';
import { dcpSourceDigest, inspectDcpReadiness, probeDcpSource } from './dcpPreflight.js';
import { activeDcp, attachDcp, cancelDcp, dcpArtifactPaths, startDcp } from './dcp.js';
import { getProject, mutateProjectRecord } from './projects.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-dcp-lifecycle-'),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal(),
  statfs: async () => ({ bavail: 1_000_000, bsize: 4096 }),
}));
vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: vi.fn() }),
}));
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...await importOriginal(),
  findFfprobe: async () => 'ffprobe',
  runFfmpegProcess: vi.fn(),
}));
vi.mock('./dcpPreflight.js', async (importOriginal) => ({
  ...await importOriginal(),
  inspectDcpReadiness: vi.fn(),
  locateDcpTool: async (name) => name,
  probeDcpSource: vi.fn(),
}));
vi.mock('./projects.js', () => ({ getProject: vi.fn(), mutateProjectRecord: vi.fn() }));
vi.mock('../videoGen/history.js', () => ({ getHistoryItem: async () => ({ filename: 'master.mp4' }) }));
vi.mock('../../lib/backupSnapshotBoundary.js', async (importOriginal) => ({
  ...await importOriginal(),
  withBackupAssetPublication: vi.fn(),
}));

const id = 'project';
const renderHistoryId = 'render';
const grade = 'rec709';
const source = {
  videoStreams: 1, fieldOrder: 'progressive', width: 1920, height: 1080, frameRate: '24/1',
  nominalFrameRate: '24/1', sampleAspectRatio: '1:1', colorRange: 'tv', colorSpace: 'bt709',
  colorTransfer: 'bt709', colorPrimaries: 'bt709', audioChannels: 2, audioLayout: 'stereo',
  audioStreams: 1, durationSec: 1,
};

const xml = (values) => Object.entries(values).map(([key, value]) => `<${key}>${value}</${key}>`).join('');
function filmMetadata(contentOverrides) {
  const mapping = xml({ InputChannels: 2, OutputChannels: 16 })
    + [0, 1].flatMap(input => Array.from({ length: 16 }, (_, output) =>
      `<Gain input="${input}" output="${output}">${Number(input === output)}</Gain>`)).join('');
  const content = xml({
    VideoWidth: 1920, VideoHeight: 1080, VideoLength: 24, VideoFrameRate: 24, VideoFrameType: '2d',
    SampleAspectRatio: 1, LeftCrop: 0, RightCrop: 0, TopCrop: 0, BottomCrop: 0, TrimStart: 0, TrimEnd: 0,
    Position: 0, Use: 1, Range: 'video', VideoFadeIn: 0, VideoFadeOut: 0, AudioFadeIn: 0, AudioFadeOut: 0,
    AudioDelay: 0, AudioGain: 0,
    ColourConversion: xml({
      YUVToRGB: 1, RedX: 0.64, RedY: 0.33, GreenX: 0.3, GreenY: 0.6, BlueX: 0.15, BlueY: 0.06,
      WhiteX: 0.3127, WhiteY: 0.329, OutputGamma: 2.6, InputTransferFunction: xml({ Type: 'Gamma', Gamma: 2.2 }),
    }),
    AudioStream: xml({ Mapping: mapping }),
    ...contentOverrides,
  });
  return xml({ Metadata: xml({
    Container: 185, Resolution: '2K', VideoFrameRate: 24, AudioChannels: 6, ThreeD: 0, Interop: 0,
    Encrypted: 0, EncryptPicture: 0, EncryptSound: 0, EncryptText: 0, AudioFrameRate: 48000,
    VideoEncoding: 'jpeg2000', Playlist: xml({ Content: content }),
  }) });
}

function nextTerminalFrame(jobId) {
  const { promise, resolve } = Promise.withResolvers();
  const res = {
    req: new EventEmitter(), writeHead: vi.fn(), end: vi.fn(),
    write: (data) => {
      const frame = JSON.parse(data.slice('data: '.length));
      if (frame.type !== 'progress') {
        res.req.emit('close');
        resolve(frame);
      }
    },
  };
  expect(attachDcp(jobId, res)).toBe(true);
  return promise;
}

let options;
let project;
let contentOverrides;
let frameTimes;
beforeEach(async () => {
  vi.resetAllMocks();
  await rm(PATHS.videos, { recursive: true, force: true });
  await mkdir(PATHS.videos, { recursive: true });
  const master = join(PATHS.videos, 'master.mp4');
  await writeFile(master, 'fixture master video');
  options = { grade, renderHistoryId, sourceSha256: await dcpSourceDigest(master) };
  project = { id, renderHistoryId };
  contentOverrides = {};
  frameTimes = Array.from({ length: 24 }, (_, index) => index / 24);
  inspectDcpReadiness.mockResolvedValue({
    renderHistoryId, sourceSha256: options.sourceSha256, source, sourceError: null,
    tools: { create: true, encoder: true, verifier: true, ffprobe: true },
  });
  getProject.mockImplementation(async () => project);
  probeDcpSource.mockResolvedValue(source);
  vi.mocked(promisify(execFile)).mockImplementation(async () => ({ stdout: frameTimes.join('\n') }));
  runFfmpegProcess.mockImplementation(async ({ bin, args }) => {
    if (bin === 'dcpomatic2_create') {
      const film = args[args.indexOf('-o') + 1];
      await mkdir(film);
      await writeFile(join(film, 'metadata.xml'), filmMetadata(contentOverrides));
    } else if (bin === 'dcpomatic2_cli') {
      const encoded = join(args.at(-1), 'encoded');
      await mkdir(encoded);
      await writeFile(join(encoded, 'ASSETMAP'), 'fixture package');
    } else if (bin === 'dcpomatic2_verify_cli') {
      await writeFile(args[args.indexOf('-o') + 1], 'fixture verification report');
    } else {
      throw new Error(`Unexpected command: ${bin}`);
    }
    return { ok: true };
  });
  withBackupAssetPublication.mockImplementation(async (publish) => publish());
  mutateProjectRecord.mockImplementation(async (_id, transform) => {
    ({ project } = transform(project));
  });
});

afterAll(() => cleanupTempDataRoots());

describe('cinema package export lifecycle', () => {
  it('tracks the active job and registers the verified package', async () => {
    const { jobId } = await startDcp(id, options);
    expect(activeDcp(id)).toEqual({ jobId });
    await expect(startDcp(id, options)).rejects.toMatchObject({ code: 'DCP_IN_PROGRESS' });

    const terminal = await nextTerminalFrame(jobId);
    expect(terminal).toMatchObject({ type: 'complete', result: { status: 'verified', sourceSha256: options.sourceSha256 } });
    expect(project.dcpExports).toEqual([terminal.result]);
    const { packagePath, reportPath } = await dcpArtifactPaths(id, terminal.result.id);
    await expect(readFile(join(packagePath, 'ASSETMAP'), 'utf8')).resolves.toBe('fixture package');
    await expect(readFile(reportPath, 'utf8')).resolves.toBe('fixture verification report');
    expect(activeDcp(id)).toBeNull();
    expect(cancelDcp(jobId)).toBe(CANCEL_ALREADY_TERMINAL);
  });

  it('aborts an in-flight encode and removes the partial build', async () => {
    const encoding = Promise.withResolvers();
    const runTool = runFfmpegProcess.getMockImplementation();
    runFfmpegProcess.mockImplementation((args) => {
      if (args.bin !== 'dcpomatic2_cli') return runTool(args);
      return new Promise((resolve) => {
        args.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }), { once: true });
        encoding.resolve();
      });
    });
    const { jobId } = await startDcp(id, options);
    const terminal = nextTerminalFrame(jobId);
    await encoding.promise;
    expect(cancelDcp(jobId)).toBe(true);

    await expect(terminal).resolves.toMatchObject({ type: 'canceled' });
    expect(activeDcp(id)).toBeNull();
    expect(withBackupAssetPublication).not.toHaveBeenCalled();
    await expect(readdir(PATHS.videos)).resolves.toEqual(['master.mp4']);
  });

  it('rejects uneven source timing before creating a cinema project', async () => {
    frameTimes[12] += 0.02;
    const { jobId } = await startDcp(id, options);

    await expect(nextTerminalFrame(jobId)).resolves.toMatchObject({ type: 'error', error: expect.stringContaining('stable 24 fps') });
    expect(runFfmpegProcess).not.toHaveBeenCalled();
    expect(withBackupAssetPublication).not.toHaveBeenCalled();
    await expect(readdir(PATHS.videos)).resolves.toEqual(['master.mp4']);
  });

  it('rejects a source without the required BT.709 metadata before staging it', async () => {
    const readiness = await inspectDcpReadiness(id);
    inspectDcpReadiness.mockResolvedValue({ ...readiness, source: { ...source, colorPrimaries: 'unknown' } });
    const { jobId } = await startDcp(id, options);

    await expect(nextTerminalFrame(jobId)).resolves.toMatchObject({ type: 'error', error: expect.stringContaining('BT.709') });
    expect(probeDcpSource).not.toHaveBeenCalled();
    expect(runFfmpegProcess).not.toHaveBeenCalled();
    await expect(readdir(PATHS.videos)).resolves.toEqual(['master.mp4']);
  });

  it('rejects film metadata with a length that differs from the measured timing', async () => {
    contentOverrides = { VideoLength: 23 };
    const { jobId } = await startDcp(id, options);

    await expect(nextTerminalFrame(jobId)).resolves.toMatchObject({ type: 'error', error: expect.stringContaining('VideoLength') });
    expect(runFfmpegProcess.mock.calls.map(([{ bin }]) => bin)).toEqual(['dcpomatic2_create']);
    expect(withBackupAssetPublication).not.toHaveBeenCalled();
    await expect(readdir(PATHS.videos)).resolves.toEqual(['master.mp4']);
  });

  it('retains the finished package when backup admission fails before recording it', async () => {
    withBackupAssetPublication.mockRejectedValue(new Error('fixture admission timeout'));
    const { jobId } = await startDcp(id, options);

    const terminal = await nextTerminalFrame(jobId);
    expect(terminal).toMatchObject({ type: 'error', error: expect.stringContaining('The output was retained') });
    expect(mutateProjectRecord).not.toHaveBeenCalled();
    expect(project.dcpExports).toBeUndefined();
    expect(activeDcp(id)).toBeNull();
    const retained = (await readdir(PATHS.videos)).find((name) => name.startsWith('dcp-'));
    expect(retained).toBeTruthy();
    const root = join(PATHS.videos, retained);
    expect(terminal.error).toContain(root);
    expect((await readdir(root)).sort()).toEqual(['package', 'verification.txt']);
    await expect(readFile(join(root, 'package', 'ASSETMAP'), 'utf8')).resolves.toBe('fixture package');
  });
});
