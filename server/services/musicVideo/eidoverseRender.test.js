import { beforeEach, expect, it, vi } from 'vitest';
import { writeFile, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
vi.mock('../../lib/processEnv.js', async load => ({ ...await load(), whichFirst: vi.fn(async () => '/usr/bin/docker') }));
vi.mock('../../lib/bufferedSpawn.js', () => ({ bufferedSpawn: vi.fn(async () => ({ success: true, stdout: `sha256:${'a'.repeat(64)}` })) }));
vi.mock('../../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn() }));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'), runFfmpegProcess: vi.fn(async () => ({ ok: true })),
  probeVideoDuration: vi.fn(async () => 10), probeVideoGeometry: vi.fn(async () => ({ width: 1280, height: 720, fps: 24 })), edgeFadeFilter: () => ',afade=t=in:d=0.1',
}));
const { bufferedSpawn } = await import('../../lib/bufferedSpawn.js');
const { runStreamingCommand } = await import('../../lib/streamingSpawn.js');
const { runFfmpegProcess, probeVideoDuration } = await import('../../lib/ffmpeg.js');
const { normalizeComposition } = await import('./composition.js');
const { musicVideoCompositionSchema } = await import('../../lib/musicVideoValidation.js');
const { prepareEidoverseRender, encodeEidoverseComposition } = await import('./eidoverseRender.js');
const project = { id: 'example', audioAnalysis: { durationSec: 10 }, scenes: [{ startSec: 2, endSec: 6 }],
  composition: { mode: 'eidoverse', eidoverseScene: { inlineScript: 'globalThis.setup = async () => {};', assets: { prop: 'eidoverse/assets/models/example.glb' } } } };
const outputRoot = args => args.find(arg => arg.startsWith('type=bind,src=') && arg.endsWith('dst=/output')).split(',')[1].slice(4);
beforeEach(() => {
  vi.clearAllMocks();
  bufferedSpawn.mockResolvedValue({ success: true, stdout: `sha256:${'a'.repeat(64)}` });
  probeVideoDuration.mockResolvedValue(10);
  runStreamingCommand.mockImplementation(async (bin, args) => { await writeFile(join(outputRoot(args), 'scene.mp4'), 'synthetic fixture'); return { success: true }; });
});
it('preserves the new source through schema validation, normalization and renderer switches; refuses path/URL/command overrides', () => {
  const stored = normalizeComposition(musicVideoCompositionSchema.parse(project.composition));
  expect(stored).toMatchObject(project.composition);
  expect(normalizeComposition({ ...stored, mode: 'code' }).eidoverseScene).toEqual(project.composition.eidoverseScene);
  for (const scene of [
    { inlineScript: 'x', assets: { prop: 'eidoverse/assets/../../private.json' } },
    { inlineScript: 'x', assets: { prop: 'https://example.com/model.glb' } },
    { inlineScript: 'x', outputVideo: '/tmp/other.mp4' },
    { inlineScript: 'x', script: '/tmp/other.js' },
  ]) expect(musicVideoCompositionSchema.safeParse({ mode: 'eidoverse', eidoverseScene: scene }).success).toBe(false);
});
it('renders in the isolated image, checks output and muxes only the matching master-song window', async () => {
  const plan = await prepareEidoverseRender(project);
  const result = await encodeEidoverseComposition({ plan, project, audioPath: '/example/song.wav', outputPath: '/example/final.mp4', windowStart: 2, windowEnd: 6 });
  const args = runStreamingCommand.mock.calls[0][1];
  expect(args).toEqual(expect.arrayContaining(['--network=none', '--read-only', '--cap-drop=ALL', '--pull=never', '--user=1000:1000', '--cached-only', plan.imageId]));
  expect(args.some(arg => arg.includes('/example/song.wav'))).toBe(false);
  expect(args.some(arg => arg.includes('docker.sock'))).toBe(false);
  expect(bufferedSpawn.mock.calls.at(-1)[1]).toEqual(['rm', '--force', expect.stringMatching(/^portos-mv-eido-/)]);
  expect(runFfmpegProcess.mock.calls[0][0].args).toEqual(expect.arrayContaining(['-ss', '2', '-t', '4', '-map', '1:a:0', '/example/song.wav']));
  expect(result).toMatchObject({ durationSec: 4, boundaryTimes: [0] });
  await expect(access(outputRoot(args))).rejects.toThrow();
});
it('refuses a missing runtime during preparation, before rendering anything', async () => {
  bufferedSpawn.mockResolvedValue({ success: false, stdout: '' });
  await expect(prepareEidoverseRender(project)).rejects.toMatchObject({ code: 'EIDOVERSE_RUNTIME_MISSING' });
  expect(runStreamingCommand).not.toHaveBeenCalled();
});
it('stops and cleans the actual container on cancel without muxing a partial result', async () => {
  const plan = await prepareEidoverseRender(project);
  const controller = new AbortController();
  runStreamingCommand.mockImplementation(async (bin, args, hook, options) => {
    controller.abort();
    expect(options.isCancelled()).toBe(true);
    return { success: false, error: 'cancelled' };
  });
  await expect(encodeEidoverseComposition({ plan, project, audioPath: '/example/song.wav', outputPath: '/example/final.mp4', signal: controller.signal })).rejects.toThrow();
  expect(bufferedSpawn.mock.calls.at(-1)[1][0]).toBe('rm');
  expect(runFfmpegProcess).not.toHaveBeenCalled();
});
it('rejects symlink or short output instead of marking an unusable film complete', async () => {
  const plan = await prepareEidoverseRender(project);
  runStreamingCommand.mockImplementation(async (bin, args) => { await symlink('/example/private', join(outputRoot(args), 'scene.mp4')); return { success: true }; });
  await expect(encodeEidoverseComposition({ plan, project, audioPath: '/example/song.wav', outputPath: '/example/final.mp4' })).rejects.toMatchObject({ code: 'EIDOVERSE_OUTPUT_INVALID' });
  runStreamingCommand.mockImplementation(async (bin, args) => { await writeFile(join(outputRoot(args), 'scene.mp4'), 'short fixture'); return { success: true }; });
  probeVideoDuration.mockResolvedValue(1);
  await expect(encodeEidoverseComposition({ plan, project, audioPath: '/example/song.wav', outputPath: '/example/final.mp4' })).rejects.toMatchObject({ code: 'EIDOVERSE_OUTPUT_INVALID' });
  expect(runFfmpegProcess).not.toHaveBeenCalled();
});
