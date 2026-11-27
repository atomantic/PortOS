/**
 * Real-ESRGAN upscale end to end with real ffmpeg (#19985): the explicit
 * install (download → SHA-256 → unpack → per-weight GPU check), then the queue
 * worker over a synthetic clip, checking that cadence, frame count and the
 * source audio survive and that the published history row is measured.
 *
 * The runtime binary is a stand-in: a Node script that speaks the
 * realesrgan-ncnn-vulkan CLI and writes frames at the network's scale, so the
 * suite needs ffmpeg but no GPU. The real binary is verified on a supported
 * host by hand (see the PR for #19985).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserSuiteCanRun } from '../../lib/browserSuiteGate.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const state = vi.hoisted(() => ({ home: null, history: [], queued: [] }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => state.home ?? actual.homedir() };
});
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-realesrgan-'),
}));
vi.mock('./history.js', () => ({
  loadHistory: async () => structuredClone(state.history),
  getHistoryItem: async (id) => structuredClone(state.history.find((item) => item.id === id) ?? null),
  mutateVideoHistory: async (fn) => { state.history = await fn(structuredClone(state.history)); return state.history; },
}));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: async (job) => { state.queued.push(job); return { jobId: `job-${state.queued.length}`, status: 'queued' }; },
}));

const { PATHS } = await import('../../lib/paths.js');
const { findFfmpeg, findFfprobe, runFfmpegProcess } = await import('../../lib/ffmpeg.js');
const { execFileAsync } = await import('../../lib/fileCore.js');
const { createZip } = await import('../../lib/zipWriter.js');
const { videoGenEvents } = await import('./events.js');
const runtime = await import('./realesrganRuntime.js');
const { planUpscaleHistoryItem } = await import('./upscaleVideo.js');
const { enqueueRealesrganUpscale, runVideoUpscale, cancel } = await import('./realesrganUpscaleJob.js');
const { REALESRGAN_MODELS } = await import('./upscalePlan.js');

const ffmpeg = await findFfmpeg();
// Resolved once the throwaway HOME exists: the install target lives under it.
let target = runtime.realesrganInstallTarget();
const canRun = browserSuiteCanRun('Real-ESRGAN upscale ffmpeg integration', {
  ffmpeg,
  // The stand-in runtime is an executable script, which only POSIX hosts run directly.
  'POSIX executable scripts': process.platform !== 'win32' ? true : undefined,
  'a supported Real-ESRGAN host': target.supported ? true : undefined,
});

// Speaks the realesrgan-ncnn-vulkan CLI: refuses missing weights, prints the
// GPU line the install check records, and writes one PNG per input at the
// network's scale. A `SLOW` marker beside the install holds it so a cancel can land.
const fakeRuntime = () => `#!${process.execPath}
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
const argv = process.argv.slice(2);
const opt = (flag) => argv[argv.indexOf(flag) + 1];
const [input, output, network, scale, modelDir] = [opt('-i'), opt('-o'), opt('-n'), Number(opt('-s')), opt('-m')];
process.stderr.write('[0 Example Vulkan GPU]  queueC=0[1]  queueG=0[1]  queueT=0[1]\\n');
const weights = network === 'realesr-animevideov3' ? network + '-x' + scale + '.param' : network + '.param';
if (!existsSync(join(modelDir, weights))) { process.stderr.write('missing ' + weights + '\\n'); process.exit(1); }
if (existsSync(join(modelDir, '..', 'SLOW'))) await new Promise((resolve) => setTimeout(resolve, 60000));
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
const png = (w, h) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 128)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
};
const upscale = (from, to) => { const b = readFileSync(from); writeFileSync(to, png(b.readUInt32BE(16) * scale, b.readUInt32BE(20) * scale)); };
if (statSync(input).isDirectory()) for (const name of readdirSync(input)) upscale(join(input, name), join(output, name));
else upscale(input, output);
`;

const archive = () => createZip([
  { name: target.asset.binary, data: fakeRuntime() },
  { name: 'README_example.md', data: 'not unpacked' },
  ...Object.values(REALESRGAN_MODELS).flatMap((model) => model.files.map((file) => ({ name: `models/${file}`, data: 'weights' }))),
]);

const probe = async (file) => {
  const { stdout } = await execFileAsync(await findFfprobe(), [
    '-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,nb_read_frames,duration_ts',
    '-of', 'json', file,
  ]);
  const streams = JSON.parse(stdout).streams;
  return { video: streams.find((s) => s.codec_type === 'video'), audio: streams.find((s) => s.codec_type === 'audio') };
};

const SOURCE_ID = randomUUID();
let installEvents = [];

describe.skipIf(!canRun)('Real-ESRGAN local upscale lane', () => {
  beforeAll(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'portos-realesrgan-home-'));
    target = runtime.realesrganInstallTarget();
    expect(target.installDir.startsWith(state.home)).toBe(true);
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.videoThumbnails, { recursive: true });
    // 59 frames at 24000/1001 (several Real-ESRGAN batches) with an audio
    // track that outlasts the video, the case a frame-count bound used to cut.
    const made = await runFfmpegProcess({
      bin: ffmpeg,
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=24000/1001:duration=2.5',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.5',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
        '-y', join(PATHS.videos, `${SOURCE_ID}.mp4`),
      ],
    });
    expect(made).toEqual({ ok: true });
    state.history = [{ id: SOURCE_ID, filename: `${SOURCE_ID}.mp4`, prompt: 'Example clip', width: 64, height: 36, musicVideo: { projectId: 'mv-old' } }];
  });

  afterAll(async () => {
    await rm(state.home, { recursive: true, force: true });
    await cleanupTempDataRoots();
  });

  it('plans readiness and dimensions read-only, then installs only on the explicit action', async () => {
    const before = await planUpscaleHistoryItem(SOURCE_ID, { method: 'realesrgan' });
    expect(before).toMatchObject({
      method: 'realesrgan',
      target: { width: 128, height: 72, frameCount: 59 },
      runtime: { installed: false, installTarget: { archive: target.archive, version: target.version }, model: { id: 'realesrgan-x4plus' } },
    });
    expect(existsSync(join(state.home, '.portos'))).toBe(false);
    await expect(enqueueRealesrganUpscale(SOURCE_ID)).rejects.toMatchObject({ code: 'REALESRGAN_NOT_READY' });

    const bytes = archive();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }));
    installEvents = [];
    const receipt = await runtime.installRealesrganRuntime({
      fetchImpl, target: { ...target, sha256 }, onEvent: (event) => installEvents.push(event),
    });
    expect(receipt).toMatchObject({ verifiedModels: ['realesrgan-x4plus', 'realesr-animevideov3'], gpu: 'Example Vulkan GPU' });
    expect(installEvents.filter((event) => event.type === 'stage').map((event) => event.stage)).toEqual(['download', 'unpack', 'verify']);
    expect((await readdir(target.installDir)).sort()).toEqual(['models', 'portos-install.json', target.asset.binary].sort());
    expect(await readdir(join(state.home, '.portos', 'realesrgan-ncnn-vulkan', 'downloads'))).toEqual([]);

    // The stand-in is not the pinned release, so its receipt names the stand-in's
    // digest; restamp it as the release the readiness check expects.
    const receiptPath = join(target.installDir, 'portos-install.json');
    await writeFile(receiptPath, JSON.stringify({ ...JSON.parse(await readFile(receiptPath, 'utf8')), sha256: target.sha256 }));
    const after = await planUpscaleHistoryItem(SOURCE_ID, { method: 'realesrgan', realesrganModel: 'realesr-animevideov3' });
    expect(after.runtime).toMatchObject({ installed: true, verified: true, gpu: 'Example Vulkan GPU', model: { id: 'realesr-animevideov3', nativeScale: 2 } });
  });

  it.each(['realesrgan-x4plus', 'realesr-animevideov3'])('keeps cadence, frame count and source audio with %s and publishes a measured row', async (model) => {
    const { jobId } = await enqueueRealesrganUpscale(SOURCE_ID, { realesrganModel: model, musicVideoProjectId: 'mv-1', sceneId: 'mvs-1' });
    const { params } = state.queued.at(-1);
    const completed = new Promise((resolve) => {
      const onDone = (payload) => { if (payload.generationId === jobId) { videoGenEvents.off('completed', onDone); resolve(payload); } };
      videoGenEvents.on('completed', onDone);
    });
    const entry = await runVideoUpscale({ jobId, ...params });
    await completed;
    expect(entry).toMatchObject({
      upscaledFrom: SOURCE_ID, upscaleMethod: 'realesrgan', upscaleRuntime: 'realesrgan-ncnn-vulkan', upscaleModel: model,
      width: 128, height: 72, numFrames: 59, musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, hidden: false,
    });
    expect(entry.fps).toBeCloseTo(24000 / 1001, 6);
    expect(state.history[0].id).toBe(entry.id);
    expect(state.history.find((item) => item.id === SOURCE_ID)).toBeTruthy();

    const [source, output] = await Promise.all([probe(join(PATHS.videos, `${SOURCE_ID}.mp4`)), probe(join(PATHS.videos, entry.filename))]);
    expect(output.video).toMatchObject({ width: 128, height: 72, r_frame_rate: source.video.r_frame_rate, nb_read_frames: source.video.nb_read_frames });
    expect(output.video.duration_ts).toBe(source.video.duration_ts);
    // The source audio is carried over whole, including the tail past the last frame.
    expect(output.audio.duration_ts).toBe(source.audio.duration_ts);
    expect(existsSync(join(tmpdir(), `portos-realesrgan-${jobId}`))).toBe(false);
  });

  it('cancels mid-run without publishing a row or leaving output behind', async () => {
    await writeFile(join(target.installDir, 'SLOW'), '');
    try {
      const { jobId } = await enqueueRealesrganUpscale(SOURCE_ID);
      const { params } = state.queued.at(-1);
      const rows = state.history.length;
      const videos = await readdir(PATHS.videos);
      const failed = new Promise((resolve) => {
        const onFail = (payload) => { if (payload.generationId === jobId) { videoGenEvents.off('failed', onFail); resolve(payload); } };
        videoGenEvents.on('failed', onFail);
      });
      const enhancing = new Promise((resolve) => {
        const onProgress = (payload) => { if (payload.generationId === jobId) { videoGenEvents.off('progress', onProgress); resolve(); } };
        videoGenEvents.on('progress', onProgress);
      });
      const run = runVideoUpscale({ jobId, ...params });
      await enhancing;
      await vi.waitFor(() => expect(existsSync(join(tmpdir(), `portos-realesrgan-${jobId}`, 'batch-in'))).toBe(true), { timeout: 10000 });
      expect(cancel(jobId)).toBe(true);
      await expect(run).resolves.toBeNull();
      expect(await failed).toMatchObject({ error: 'Canceled while running' });
      expect(state.history).toHaveLength(rows);
      expect(await readdir(PATHS.videos)).toEqual(videos);
      expect(existsSync(join(tmpdir(), `portos-realesrgan-${jobId}`))).toBe(false);
    } finally {
      await rm(join(target.installDir, 'SLOW'), { force: true });
    }
  }, 30000);
});
