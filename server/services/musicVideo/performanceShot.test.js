/**
 * Music Video performance shots (#8977), end to end against real ffmpeg and a
 * synthetic song: submission gate → exact song slice → fal lip-sync payload →
 * measured delivery → edit-point trim on the final timeline. The provider is a
 * stubbed `fetch`; nothing leaves the machine and no money is spent. Mocked
 * durations cannot certify lip-sync QUALITY — this pins the timebase contract.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-performance-'),
}));
const getProject = vi.fn();
vi.mock('./projects.js', () => ({ mutateProjectRecord: async (_id, transform) => { const result = transform(await getProject()); getProject.mockResolvedValue(result.project); return result; }, getProject: (...a) => getProject(...a), listProjects: vi.fn(async () => []), updateProject: vi.fn() }));
vi.mock('../instanceIdentity.js', () => ({ UNKNOWN_INSTANCE_ID: 'unknown', getInstanceId: async () => 'local-inst' }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
// A pre-#9266 take's old master is found through the linked track's renders.
const getTrack = vi.fn(async () => null);
vi.mock('../tracks/index.js', () => ({ getTrack: (...a) => getTrack(...a) }));
// render.js reads clip history through local.js; point it at the real history
// store the fal lane writes, without loading the local runtime.
vi.mock('../videoGen/local.js', async () => {
  const history = await import('../videoGen/history.js');
  return { getHistoryItem: history.getHistoryItem, loadHistory: history.loadHistory, mutateVideoHistory: history.mutateVideoHistory };
});

const { PATHS } = await import('../../lib/fileUtils.js');
const { findFfmpeg, probeVideoStreamInfo } = await import('../../lib/ffmpeg.js');
const { preparePerformanceShot, findStalePerformanceTakes, withDraftPerformanceFallbacks, assertCurrentPerformanceTakes } = await import('./performanceShot.js');
const { setShotLocks } = await import('./productionReview.js');
const fal = await import('../videoGen/fal.js');
const { videoGenEvents } = await import('../videoGen/events.js');
const { buildMusicVideoFfmpegArgs, beatSnapClips, resolveSceneClips } = await import('./render.js');
const { appendSceneTakes } = await import('./takes.js');

const ffmpeg = await findFfmpeg();
const RATE = 48000;
const SONG_SEC = 30;
// One full-scale impulse marks an exact song instant (sample 960000 = 20.000s).
const MARKER_SEC = 20;

// A mono 16-bit PCM WAV built sample-by-sample, so the marker's position is
// known exactly without trusting any encoder.
function songWav({ seconds = SONG_SEC, markerAmp = 30000 } = {}) {
  const samples = seconds * RATE;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  buf.writeInt16LE(markerAmp, 44 + MARKER_SEC * RATE * 2);
  return buf;
}

// PCM samples of a WAV, located by its `data` chunk (ffmpeg may add a LIST chunk).
function pcm(wav) {
  let at = 12;
  while (at < wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'data') return wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const scene = (over = {}) => ({
  sceneId: 'mvs-1', order: 0, shotMode: 'performance', startSec: 20, endSec: 21.5, beatAligned: true,
  prompt: 'singer at the mic', visualIntent: 'sings the held note', referenceImageId: 'frame.png', takes: [], ...over,
});
const project = (sceneOver) => ({
  id: 'mv-1',
  uploadedAudioFilename: 'song.wav',
  lyricCues: [
    // Aligned words carry their text as `w` (lyricAlignCore); the take records it as `text`.
    { id: 'c1', text: 'hold on', startSec: 19, endSec: 20.5,
      words: [{ w: 'hold', startSec: 19, endSec: 20, conf: 'matched' }, { text: 'on', startSec: 20, endSec: 20.5 }] },
    { id: 'c2', text: 'later line', startSec: 40, endSec: 42 },
    { id: 'c3', text: 'untimed', startSec: null, endSec: null },
  ],
  scenes: [scene(sceneOver)],
});

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const waitForTerminal = (jobId) => new Promise((resolve) => {
  const on = (type) => (event) => { if (event.generationId === jobId) resolve({ type, ...event }); };
  videoGenEvents.on('completed', on('completed'));
  videoGenEvents.on('failed', on('failed'));
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  videoGenEvents.removeAllListeners();
  getProject.mockReset();
  getTrack.mockReset();
  // Preparation-only cases leave slices behind; generated takes remove theirs before completion.
  await rm(PATHS.uploads, { recursive: true, force: true });
  await mkdir(PATHS.music, { recursive: true });
  await writeFile(join(PATHS.music, 'song.wav'), songWav());
});

afterAll(() => cleanupTempDataRoots());

it('blocks composition and exposes a repair when supplied audio used an older take of the same track', async () => {
  const { assertCurrentPerformanceTakes } = await import('./performanceShot.js');
  const { resolveMasterAudioPath } = await import('./render.js');
  const { getDependencyImpact } = await import('./revisionService.js');
  const sourceSha256 = createHash('sha256').update(songWav()).digest('hex');
  const supplied = { ...project({ shotMode: 'cutaway' }), trackId: 'same-track', uploadedAudioFilename: null };
  const shot = supplied.scenes[0];
  shot.videoHistoryId = 'supplied-take';
  shot.takes = [{ kind: 'video', assetId: shot.videoHistoryId, shotInstruction: {
    shotMode: 'cutaway', songInterval: { startSec: shot.startSec, endSec: shot.endSec },
    audioConditioning: { sourceSha256, startSample: shot.startSec * RATE },
  } }];
  getProject.mockResolvedValue(supplied);
  getTrack.mockResolvedValue({ audioFilename: 'song.wav' });
  await expect(assertCurrentPerformanceTakes(supplied, await resolveMasterAudioPath(supplied))).resolves.toBeUndefined();
  // A local lip-sync take hears the song the same way: it is lip-synced, not a cutaway import.
  const lipSync = { ...supplied, scenes: [{ ...shot, shotMode: 'performance' }] };
  await expect(assertCurrentPerformanceTakes(lipSync, await resolveMasterAudioPath(lipSync))).resolves.toBeUndefined();
  await writeFile(join(PATHS.music, 'another-take.wav'), songWav({ markerAmp: 10000 }));
  getTrack.mockResolvedValue({ audioFilename: 'another-take.wav' });
  await expect(assertCurrentPerformanceTakes(supplied, await resolveMasterAudioPath(supplied))).rejects.toMatchObject({ code: 'MUSIC_VIDEO_STALE_SOURCE_AUDIO_TAKES' });
  const impact = await getDependencyImpact(supplied.id);
  expect(impact.shots).toEqual(expect.arrayContaining([expect.objectContaining({ sceneId: shot.sceneId, reasons: expect.arrayContaining(['source-audio-changed']) })]));
  for (const visualLayer of ['still', 'card']) {
    shot.visualLayer = visualLayer;
    await expect(assertCurrentPerformanceTakes(supplied, await resolveMasterAudioPath(supplied))).resolves.toBeUndefined();
    expect((await getDependencyImpact(supplied.id)).shots).toEqual([]);
  }
});

describe.skipIf(!ffmpeg)('music-video performance shot through the fal lip-sync lane (#8977)', () => {
  it('slices the exact song window, submits it once, and trims the delivered take at its edit points', async () => {
    getProject.mockResolvedValue(project());
    const prepared = await preparePerformanceShot({
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: join(PATHS.images, 'frame.png'), mode: 'image',
    });

    // A 1.5s shot is padded to the 5s provider minimum (+ margin), centered:
    // window 18.225–23.275, shot at clip time 1.775–3.275.
    const { shotInstruction: si } = prepared;
    expect(si.audioWindow).toEqual({ startSec: 18.225, endSec: 23.275, durationSec: 5.05 });
    expect(si.edit).toEqual({ inSec: 1.775, outSec: 3.275, targetSec: 1.5 });
    expect(si.songInterval).toEqual({ startSec: 20, endSec: 21.5 });
    expect(si.cues).toEqual([{ text: 'hold on', startSec: 0.775, endSec: 2.275, words: [{ text: 'hold', startSec: 0.775, endSec: 1.775 }, { text: 'on', startSec: 1.775, endSec: 2.275 }] }]);
    expect(si.audio.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(si.audio.conditioning).toEqual({ source: 'master', sha256: si.audio.sha256, filename: 'song.wav', selection: 'legacy-default', voiceIsolation: 'unverified' });
    expect(si).toMatchObject({ referenceImageId: 'frame.png', performance: 'sings the held note', generatedCoverageSec: 5.05 });
    // The take's own resolution defaults to 1080P for a music video (fal's own
    // default is 768P) and is recorded on the immutable instruction.
    expect(si.capability).toMatchObject({ provider: 'fal', minAudioSec: 5, maxAudioSec: 30, resolution: '1080P' });
    expect(prepared.resolution).toBe('1080P');

    // Sample-exact window content: exactly 5.05s of samples, the song marker at
    // the in-point, and the slice staged where the queue will clean it up.
    expect(prepared.audioFilePath.startsWith(PATHS.uploads)).toBe(true);
    const sliceWav = await readFile(prepared.audioFilePath);
    const samples = pcm(sliceWav);
    expect(samples.length / 2).toBe(Math.round(5.05 * RATE));
    let peak = 0;
    for (let i = 1; i < samples.length / 2; i++) if (samples.readInt16LE(i * 2) > samples.readInt16LE(peak * 2)) peak = i;
    expect(peak).toBe(Math.round((MARKER_SEC - 18.225) * RATE));

    // Generation payload: the reference frame plus these exact bytes at the
    // take's resolution, with no prompt/duration a lip-sync route would
    // contradict — and no prompt is required to submit one. Submitted once.
    await mkdir(PATHS.images, { recursive: true });
    await writeFile(join(PATHS.images, 'frame.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const deliveredPath = join(PATHS.data, 'delivered.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=5.05', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', deliveredPath]);
    const delivered = await readFile(deliveredPath);
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (opts?.method === 'POST') {
        posts.push({ url, body: JSON.parse(opts.body) });
        return jsonResponse({ request_id: 'r1', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
      }
      if (url === 'https://queue.fal.run/s') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/r') return jsonResponse({ video: { url: 'https://cdn.example.com/out.mp4' } });
      if (url === 'https://cdn.example.com/out.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(delivered).buffer };
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const job = await fal.generateVideo({
      apiKey: 'test-key', modelId: prepared.modelId, resolution: prepared.resolution,
      sourceImagePath: join(PATHS.images, 'frame.png'), audioFilePath: prepared.audioFilePath,
      lipSync: { enableTranscription: prepared.enableTranscription }, shotInstruction: si,
    });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://queue.fal.run/minimax/h3-max/lip-sync/image-to-video');
    expect(Object.keys(posts[0].body).sort()).toEqual(['audio_url', 'enable_transcription', 'image_url', 'resolution']);
    expect(posts[0].body.resolution).toBe('1080P');
    // The history record carries what was rendered and what it should cost:
    // 5.05s at the 1080P list rate of $0.16/s.
    const { loadHistory } = await import('../videoGen/history.js');
    expect((await loadHistory()).find((h) => h.id === job.jobId)).toMatchObject({
      modelId: 'fal:minimax/h3-max/lip-sync/image-to-video', resolution: '1080P', estimatedCostUsd: 0.808, lipSync: true,
    });
    expect(Buffer.from(posts[0].body.audio_url.replace(/^data:audio\/wav;base64,/, ''), 'base64').equals(sliceWav)).toBe(true);

    // Final timeline: the take lands with its instruction, the renderer reads
    // the measured clip, and the edit trims exactly the shot's frames.
    const { scene: withTake } = appendSceneTakes(project({ referenceImageId: 'frame.png' }), 'mvs-1', [{
      kind: 'video', assetId: job.jobId, source: 'generated', shotInstruction: si,
    }]);
    const [clip] = beatSnapClips(await resolveSceneClips({ scenes: [withTake] }), [], { scenes: [withTake] });
    expect(clip).toMatchObject({ inSec: 1.775, loop: false });
    const outPath = join(PATHS.data, 'final.mp4');
    const { args } = buildMusicVideoFfmpegArgs([clip], join(PATHS.music, 'song.wav'), outPath);
    execFileSync(ffmpeg, ['-v', 'error', ...args.filter((a, i) => a !== '-progress' && args[i - 1] !== '-progress')]);
    const out = await probeVideoStreamInfo(outPath);
    // 1.5s at 24fps = 36 frames; covered within one frame.
    const frames = Number(execFileSync(ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', outPath,
    ]).toString().trim());
    expect(out.fps).toBe(24);
    expect(Math.abs(frames - 36)).toBeLessThanOrEqual(1);

    // The take is only valid while it plays its sung audio under the song: a
    // shot stretched at its end, or slid with an Offset that lines the take
    // back up, still sings; a slide without one, or a speed change, does not.
    const songPath = join(PATHS.music, 'song.wav');
    expect(await findStalePerformanceTakes({ scenes: [withTake] }, songPath)).toEqual([]);
    expect(await findStalePerformanceTakes({ scenes: [{ ...withTake, endSec: 22 }] }, songPath)).toEqual([]);
    expect(await findStalePerformanceTakes({ scenes: [{ ...withTake, startSec: 20.5, offsetFrames: 12 }] }, songPath)).toEqual([]);
    expect(await findStalePerformanceTakes({ scenes: [{ ...withTake, startSec: 20.5 }] }, songPath))
      .toEqual([{ sceneId: 'mvs-1', reason: 'retimed' }]);
    expect(await findStalePerformanceTakes({ scenes: [{ ...withTake, speedFps: 2 }] }, songPath))
      .toEqual([{ sceneId: 'mvs-1', reason: 'retimed' }]);
    // #9266: a re-master that changes the song OUTSIDE the take's window
    // (18.225–23.275) keeps the take; one that changes its sung window does not.
    const original = await readFile(songPath);
    const remastered = songWav();
    for (let i = 0; i < RATE; i++) remastered.writeInt16LE(Math.round(20000 * Math.sin(i / 8)), 44 + (5 * RATE + i) * 2);
    await writeFile(songPath, remastered);
    expect(await findStalePerformanceTakes({ scenes: [withTake] }, songPath)).toEqual([]);
    const resung = songWav();
    for (let i = 0; i < RATE; i++) resung.writeInt16LE(Math.round(20000 * Math.sin(i / 8)), 44 + (21 * RATE + i) * 2);
    await writeFile(songPath, resung);
    expect(await findStalePerformanceTakes({ scenes: [withTake] }, songPath))
      .toEqual([{ sceneId: 'mvs-1', reason: 'audio-changed' }]);
    // A read-only caller without host control never starts that decode (#13156):
    // the re-sung window goes unchecked rather than stale.
    expect(await findStalePerformanceTakes({ scenes: [withTake] }, songPath, { decode: false })).toEqual([]);

    // A take made before window fingerprints existed is compared against its
    // old master when the track's render history still holds it, and is stale
    // when that file is gone.
    const legacyInstruction = { ...si, audio: { ...si.audio, windowFingerprint: undefined } };
    const { scene: legacyScene } = appendSceneTakes(project({ referenceImageId: 'frame.png' }), 'mvs-1', [{
      kind: 'video', assetId: job.jobId, source: 'generated', shotInstruction: legacyInstruction,
    }]);
    const legacyProject = { trackId: 'trk-1', scenes: [legacyScene] };
    await writeFile(join(PATHS.music, 'song-v1.wav'), original);
    await writeFile(songPath, remastered);
    getTrack.mockResolvedValue({ id: 'trk-1', audioFilename: 'song.wav', renders: [{ audioFilename: 'song.wav' }, { audioFilename: 'song-v1.wav' }] });
    expect(await findStalePerformanceTakes(legacyProject, songPath)).toEqual([]);
    await writeFile(songPath, resung);
    expect(await findStalePerformanceTakes(legacyProject, songPath))
      .toEqual([{ sceneId: 'mvs-1', reason: 'audio-changed' }]);
    await writeFile(songPath, remastered);
    getTrack.mockResolvedValue({ id: 'trk-1', audioFilename: 'song.wav', renders: [{ audioFilename: 'song.wav' }] });
    expect(await findStalePerformanceTakes(legacyProject, songPath))
      .toEqual([{ sceneId: 'mvs-1', reason: 'audio-changed' }]);
    // A performance scene whose selected clip is not a lip-sync take is refused too.
    expect(await findStalePerformanceTakes({ scenes: [{ ...withTake, takes: [] }] }, songPath))
      .toEqual([{ sceneId: 'mvs-1', reason: 'not-lip-synced' }]);
    // Switched back to a cutaway, the old take is an ordinary clip again.
    expect(await findStalePerformanceTakes({ scenes: [{ ...withTake, shotMode: 'cutaway' }] }, songPath)).toEqual([]);
    const [asCutaway] = await resolveSceneClips({ scenes: [{ ...withTake, shotMode: 'cutaway' }] });
    expect(asCutaway).toMatchObject({ inSec: 0 });
  }, 60_000);

  it('conditions on the vocal stem at the same song times and refuses a stem off the master timebase', async () => {
    const sha = (buf) => createHash('sha256').update(buf).digest('hex');
    const stem = songWav({ markerAmp: 12000 });
    await writeFile(join(PATHS.music, 'vocals.wav'), stem);
    getProject.mockResolvedValue({ ...project(), vocalStemFilename: 'vocals.wav' });
    const args = { musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: '/x/frame.png', mode: 'image' };
    const { audioFilePath, shotInstruction: si } = await preparePerformanceShot(args);

    // Same window and in-point as the master slice, but the stem's bytes.
    expect(si.audioWindow).toEqual({ startSec: 18.225, endSec: 23.275, durationSec: 5.05 });
    const samples = pcm(await readFile(audioFilePath));
    const markerAt = Math.round((MARKER_SEC - 18.225) * RATE);
    expect(samples.readInt16LE(markerAt * 2)).toBe(12000);
    // Staleness still keys on the master; the stem is recorded as what the
    // provider heard.
    expect(si.audio.sha256).toBe(sha(songWav()));
    expect(si.audio.conditioning).toEqual({ source: 'vocal-stem', sha256: sha(stem), filename: 'vocals.wav', selection: 'legacy-default', voiceIsolation: 'unverified' });

    getProject.mockResolvedValue({ ...project({ performanceSpeaker: 'Example Singer' }), vocalStemFilename: 'vocals.wav', performanceConditioningSource: 'clean-singer-stem' });
    const clean = await preparePerformanceShot(args);
    expect(clean.shotInstruction).toMatchObject({ version: 2, speaker: 'Example Singer',
      audio: { conditioning: { source: 'clean-singer-stem', filename: 'vocals.wav', selection: 'user', voiceIsolation: 'unverified' } } });
    getProject.mockResolvedValue({ ...project(), vocalStemFilename: 'vocals.wav' });

    // A trimmed stem would put the syllables on the wrong frames.
    await writeFile(join(PATHS.music, 'vocals.wav'), songWav({ seconds: SONG_SEC - 1 }));
    await rm(PATHS.uploads, { recursive: true, force: true });
    await expect(preparePerformanceShot(args)).rejects.toMatchObject({ status: 400, code: 'MUSIC_VIDEO_VOCAL_STEM_TIMEBASE' });
    // A stem the record names but the disk lacks is not silently replaced by the mix.
    await rm(join(PATHS.music, 'vocals.wav'));
    await expect(preparePerformanceShot(args)).rejects.toMatchObject({ status: 404, code: 'MUSIC_VIDEO_VOCAL_STEM_MISSING' });
    expect(existsSync(PATHS.uploads) ? await readdir(PATHS.uploads) : []).toEqual([]);
  });

  it('a music-driven shot hears the full mix for exactly its span and submits frame + prompt + audio to the audio-to-video model', async () => {
    await writeFile(join(PATHS.music, 'vocals.wav'), songWav({ markerAmp: 12000 }));
    // A vocal stem is attached, but the drums it leaves out are what drive this shot.
    getProject.mockResolvedValue({ ...project({ performanceStyle: 'music', prompt: 'drummer hits on the beat' }), vocalStemFilename: 'vocals.wav',
      videoSettings: { backend: 'fal', falLipSyncTranscription: true, falMusicModelId: 'fal-ai/bytedance/omnihuman/v1.5' } });
    const prepared = await preparePerformanceShot({
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: join(PATHS.images, 'frame.png'), mode: 'image',
    });
    const { shotInstruction: si } = prepared;
    // 1.5s clears the model's 1s minimum: no contextual padding, in-point 0.
    expect(si.audioWindow).toEqual({ startSec: 20, endSec: 21.5, durationSec: 1.5 });
    expect(si.edit).toEqual({ inSec: 0, outSec: 1.5, targetSec: 1.5 });
    expect(si).toMatchObject({ performanceStyle: 'music', transcription: false,
      capability: { style: 'music', modelId: 'fal-ai/bytedance/omnihuman/v1.5', resolution: '1080p' } });
    expect(si.audio.conditioning).toMatchObject({ source: 'master', filename: 'song.wav', selection: 'music-driven' });
    expect(prepared).toMatchObject({ modelId: 'fal-ai/bytedance/omnihuman/v1.5', resolution: '1080p', enableTranscription: false });
    const sliceWav = await readFile(prepared.audioFilePath);
    const samples = pcm(sliceWav);
    expect(samples.readInt16LE(0)).toBe(30000);

    await mkdir(PATHS.images, { recursive: true });
    await writeFile(join(PATHS.images, 'frame.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const deliveredPath = join(PATHS.data, 'delivered-music.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', deliveredPath]);
    const delivered = await readFile(deliveredPath);
    const posts = [];
    // OmniHuman downloads its inputs, so the frame and audio go up to fal's
    // CDN first and the request carries their URLs (#11381).
    const uploads = new Map();
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.startsWith('https://rest.fal.ai/storage/upload/initiate')) {
        const { file_name: name } = JSON.parse(opts.body);
        return jsonResponse({ upload_url: `https://upload.example.com/${name}`, file_url: `https://cdn.example.com/${name}` });
      }
      if (url.startsWith('https://upload.example.com/')) {
        uploads.set(url.replace('https://upload.example.com/', 'https://cdn.example.com/'), Buffer.from(opts.body));
        return { ok: opts.method === 'PUT', status: 200 };
      }
      if (opts?.method === 'POST') {
        posts.push({ url, body: JSON.parse(opts.body) });
        return jsonResponse({ request_id: 'r2', status_url: 'https://queue.fal.run/s2', response_url: 'https://queue.fal.run/r2' });
      }
      if (url === 'https://queue.fal.run/s2') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/r2') return jsonResponse({ video: { url: 'https://cdn.example.com/music.mp4' } });
      if (url === 'https://cdn.example.com/music.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(delivered).buffer };
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const job = await fal.generateVideo({
      apiKey: 'test-key', modelId: prepared.modelId, resolution: prepared.resolution, prompt: 'drummer hits on the beat', width: 1920, height: 1080,
      sourceImagePath: join(PATHS.images, 'frame.png'), audioFilePath: prepared.audioFilePath,
      lipSync: { enableTranscription: prepared.enableTranscription }, shotInstruction: si,
    });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://queue.fal.run/fal-ai/bytedance/omnihuman/v1.5');
    expect(posts[0].body).toMatchObject({
      prompt: 'drummer hits on the beat', resolution: '1080p',
    });
    expect(posts[0].body.image_url).toMatch(/^https:\/\/cdn\.example\.com\/.+-start\.[a-z]+$/);
    expect(posts[0].body.audio_url).toMatch(/^https:\/\/cdn\.example\.com\/.+-audio\.wav$/);
    expect(uploads.get(posts[0].body.audio_url)).toEqual(sliceWav);
    await expect(readFile(prepared.audioFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const { loadHistory } = await import('../videoGen/history.js');
    // 1.5s at $0.16/s.
    expect((await loadHistory()).find((h) => h.id === job.jobId)).toMatchObject({
      modelId: 'fal:fal-ai/bytedance/omnihuman/v1.5', resolution: '1080p', estimatedCostUsd: 0.24, audioDriven: true,
    });

  }, 60_000);

  it.each([
    // The default: H3 Max reference opens on the start frame and hears the song as "Audio 1".
    { musicModelId: null, url: 'minimax/h3-max/reference-to-video', window: { startSec: 18.25, endSec: 23.25, durationSec: 5 },
      body: { duration: 5, resolution: '768P' }, frame: 'image_url', audio: 'reference_audio_urls', costUsd: 0.4 },
    // Picked on the shot card: Seedance has no start-frame field, so the frame is @Image1.
    { musicModelId: 'bytedance/seedance-2.5/reference-to-video', url: 'bytedance/seedance-2.5/reference-to-video',
      window: { startSec: 18.75, endSec: 22.75, durationSec: 4 }, body: { duration: '4', resolution: '720p', generate_audio: false },
      frame: 'image_urls', audio: 'audio_urls', costUsd: 1.892 },
  ])('a music-driven shot on $url sends the start frame, prompt and song slice as an audio reference', async ({ musicModelId, url, window, body, frame, audio, costUsd }) => {
    getProject.mockResolvedValue({ ...project({ performanceStyle: 'music', prompt: 'drummer hits on the beat' }), videoSettings: { backend: 'fal' } });
    const prepared = await preparePerformanceShot({
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: join(PATHS.images, 'frame.png'), mode: 'image', musicModelId,
    });
    // A 1.5s shot pads to exactly the model's shortest billed clip, centered on the shot.
    expect(prepared.shotInstruction.audioWindow).toEqual(window);
    expect(prepared.shotInstruction.edit).toEqual({ inSec: 20 - window.startSec, outSec: 21.5 - window.startSec, targetSec: 1.5 });
    expect(prepared.modelId).toBe(url);
    const sliceWav = await readFile(prepared.audioFilePath);

    await mkdir(PATHS.images, { recursive: true });
    await writeFile(join(PATHS.images, 'frame.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const deliveredPath = join(PATHS.data, 'delivered-reference.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=blue:s=64x64:r=24:d=${window.durationSec}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', deliveredPath]);
    const delivered = await readFile(deliveredPath);
    const posts = [];
    const uploads = new Map();
    vi.stubGlobal('fetch', vi.fn(async (target, opts) => {
      if (target.startsWith('https://rest.fal.ai/storage/upload/initiate')) {
        const { file_name: name } = JSON.parse(opts.body);
        return jsonResponse({ upload_url: `https://upload.example.com/${name}`, file_url: `https://cdn.example.com/${name}` });
      }
      if (target.startsWith('https://upload.example.com/')) {
        uploads.set(target.replace('https://upload.example.com/', 'https://cdn.example.com/'), Buffer.from(opts.body));
        return { ok: opts.method === 'PUT', status: 200 };
      }
      if (opts?.method === 'POST') {
        posts.push({ url: target, body: JSON.parse(opts.body) });
        return jsonResponse({ request_id: 'r3', status_url: 'https://queue.fal.run/s3', response_url: 'https://queue.fal.run/r3' });
      }
      if (target === 'https://queue.fal.run/s3') return jsonResponse({ status: 'COMPLETED' });
      if (target === 'https://queue.fal.run/r3') return jsonResponse({ video: { url: 'https://cdn.example.com/ref.mp4' } });
      if (target === 'https://cdn.example.com/ref.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(delivered).buffer };
      throw new Error(`unexpected fetch: ${target}`);
    }));
    const job = await fal.generateVideo({
      apiKey: 'test-key', modelId: prepared.modelId, resolution: prepared.resolution, prompt: 'drummer hits on the beat', width: 1920, height: 1080,
      sourceImagePath: join(PATHS.images, 'frame.png'), audioFilePath: prepared.audioFilePath, shotInstruction: prepared.shotInstruction,
    });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`https://queue.fal.run/${url}`);
    expect(posts[0].body).toMatchObject({ prompt: 'drummer hits on the beat', ...body });
    expect(posts[0].body).not.toHaveProperty('audio_url');
    const start = frame === 'image_urls' ? posts[0].body.image_urls[0] : posts[0].body.image_url;
    expect(start).toMatch(/^https:\/\/cdn\.example\.com\/.+-start\.[a-z]+$/);
    expect(posts[0].body[audio]).toHaveLength(1);
    expect(uploads.get(posts[0].body[audio][0])).toEqual(sliceWav);
    await expect(readFile(prepared.audioFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const { loadHistory } = await import('../videoGen/history.js');
    expect((await loadHistory()).find((h) => h.id === job.jobId)).toMatchObject({ modelId: `fal:${url}`, estimatedCostUsd: costUsd, audioDriven: true });
  }, 60_000);

  // Review on #11413: a stale card's cutaway model id must not replace the project's music pin.
  it('keeps the project\'s music pin when the request names a model that is not a music lane', async () => {
    getProject.mockResolvedValue({ ...project({ performanceStyle: 'music' }), videoSettings: { backend: 'fal', falMusicModelId: 'fal-ai/bytedance/omnihuman/v1.5' } });
    const prepared = await preparePerformanceShot({
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: '/x/frame.png', mode: 'image',
      musicModelId: 'minimax/h3-max/image-to-video',
    });
    expect(prepared.modelId).toBe('fal-ai/bytedance/omnihuman/v1.5');
  });

  it('uses the full span of a long shot in one take, at the project\'s lip-sync resolution pin', async () => {
    // 26s: past the old 14.8s cap (fal accepts up to 15 minutes; PortOS keeps
    // a take to 30s so it stays one editable phrase).
    getProject.mockResolvedValue({ ...project({ startSec: 2, endSec: 28 }), videoSettings: { backend: 'fal', falLipSyncResolution: '768P' } });
    const args = { musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: '/x/frame.png', mode: 'image' };
    const pinned = await preparePerformanceShot(args);
    expect(pinned.shotInstruction.audioWindow).toEqual({ startSec: 2, endSec: 28, durationSec: 26 });
    expect(pinned.shotInstruction.edit.inSec).toBe(0);
    expect(pinned.resolution).toBe('768P');
    // A request naming a resolution the lip-sync route offers wins over the
    // pin; one it does not (a cutaway model's '720p') falls back to the pin.
    expect((await preparePerformanceShot({ ...args, resolution: '2k' })).resolution).toBe('2K');
    expect((await preparePerformanceShot({ ...args, resolution: '720p' })).resolution).toBe('768P');
  });

  // Catches a Whole sung line render slicing only the shot, or a continuation widening its accepted interval.
  it('slices the whole sung line when the card asks for it, keeping the edit on the shot', async () => {
    getProject.mockResolvedValue({ ...project(), lyricCues: [{ id: 'c1', text: 'the whole line', startSec: 16, endSec: 24 }] });
    const args = { musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1', wholeLine: true }, backend: 'fal', sourceImagePath: '/x/frame.png', mode: 'image' };
    const { shotInstruction: si } = await preparePerformanceShot(args);
    expect(si.audioWindow).toEqual({ startSec: 16, endSec: 24, durationSec: 8, wholeLine: { startSec: 16, endSec: 24 } });
    expect(si.edit).toMatchObject({ inSec: 4, outSec: 5.5, targetSec: 1.5 });
    expect(si.songInterval).toEqual({ startSec: 20, endSec: 21.5 });
    const plain = await preparePerformanceShot({ ...args, musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' } });
    expect(plain.shotInstruction.audioWindow.wholeLine).toBeUndefined();
    expect(plain.shotInstruction.audioWindow.durationSec).toBeCloseTo(5.05, 6);
  });

  it('asks for transcript guidance by default and skips it when the project turns it off', async () => {
    const args = { musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: '/x/frame.png', mode: 'image' };
    getProject.mockResolvedValue(project());
    const guided = await preparePerformanceShot(args);
    expect(guided.enableTranscription).toBe(true);
    expect(guided.shotInstruction.transcription).toBe(true);
    getProject.mockResolvedValue({ ...project(), videoSettings: { backend: 'fal', falLipSyncTranscription: false } });
    const acoustic = await preparePerformanceShot(args);
    expect(acoustic.enableTranscription).toBe(false);
    expect(acoustic.shotInstruction.transcription).toBe(false);
  });

  it('refuses a shot longer than the provider synchronizes instead of letting it truncate', async () => {
    getProject.mockResolvedValue(project({ startSec: 0, endSec: 30 }));
    await expect(preparePerformanceShot({
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: '/x/frame.png',
    })).rejects.toMatchObject({ status: 400, code: 'MUSIC_VIDEO_PERFORMANCE_TOO_LONG' });
  });

  it('refuses a performance shot on a lane without source-audio conditioning, before slicing anything', async () => {
    getProject.mockResolvedValue(project());
    for (const backend of ['grok', 'reactor']) {
      await expect(preparePerformanceShot({
        musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend, sourceImagePath: '/x/frame.png',
      })).rejects.toMatchObject({ status: 400, code: 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED', message: expect.stringMatching(backend === 'grok' ? /cutaway-only/ : /pin fal\.ai/) });
    }
    const staged = existsSync(PATHS.uploads) ? (await readdir(PATHS.uploads)).filter((f) => f.startsWith('mv-performance-')) : [];
    expect(staged).toEqual([]);
  });

  it('leaves a cutaway scene untouched', async () => {
    getProject.mockResolvedValue(project({ shotMode: undefined }));
    await expect(preparePerformanceShot({
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'grok', sourceImagePath: '/x/frame.png',
    })).resolves.toBeNull();
    // A performance is sung footage: a still/card-layer scene (#8985) is never lip-synced.
    getProject.mockResolvedValue(project({ visualLayer: 'still' }));
    await expect(preparePerformanceShot({
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'grok', sourceImagePath: '/x/frame.png',
    })).resolves.toBeNull();
  });

  it('never submits a paid request when cancelled while its inputs are still being read', async () => {
    getProject.mockResolvedValue(project());
    const prepared = await preparePerformanceShot({
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: join(PATHS.images, 'frame.png'),
    });
    await mkdir(PATHS.images, { recursive: true });
    await writeFile(join(PATHS.images, 'frame.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const job = await fal.generateVideo({
      apiKey: 'test-key', modelId: prepared.modelId, prompt: 'x', sourceImagePath: join(PATHS.images, 'frame.png'),
      audioFilePath: prepared.audioFilePath, lipSync: { enableTranscription: true },
    });
    const terminal = waitForTerminal(job.jobId);
    expect(fal.cancel(job.jobId)).toBe(true);
    expect(await terminal).toMatchObject({ type: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Real sample slicing and ffmpeg render: this uniquely catches regeneration of
// accepted audio or movement/replacement of the original prefix picture.
describe.skipIf(!ffmpeg)('accepted-prefix continuation render (#9348)', () => {
  it('submits only the remaining source interval and renders the original accepted frames', async () => {
    const original = project({ startSec: 10, endSec: 24, videoHistoryId: 'accepted', referenceImageId: 'frame.png', beatAligned: true });
    getProject.mockResolvedValue(original);
    const full = await preparePerformanceShot({ musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: join(PATHS.images, 'frame.png'), mode: 'image' });
    const instruction = { ...full.shotInstruction, cues: [{ startSec: 0, endSec: 14, words: [
      { text: 'one', startSec: 0, endSec: 3.8 }, { text: 'two', startSec: 4.2, endSec: 14 },
    ] }] };
    original.scenes[0].takes = [{ takeId: 'accepted-take', kind: 'video', assetId: 'accepted', shotInstruction: instruction }];
    original.videoSettings = { backend: 'fal' };
    original.excerpts = [{ id: 'draft', status: 'complete', startSec: 8, endSec: 24, notes: [], sections: [
      { sceneId: 'mvs-1', startSec: 10, endSec: 24, layer: 'footage', performance: { takeId: 'accepted' } },
    ] }];
    original.autoReviews = [{ status: 'needs-human', attempts: [{ excerptId: 'draft', review: { evidence: { excerptStartSec: 8, temporal: {
      status: 'verified', analyzer: { id: 'synthetic' }, shots: [{ sceneId: 'mvs-1', takeId: 'accepted', spans: [
        { startSec: 2, endSec: 6, status: 'verified', offsetSec: 0.01, confidence: 0.9 },
        { startSec: 6, endSec: 16, status: 'verified', offsetSec: 0.3, confidence: 0.9 },
      ] }],
    } } } }] }];
    const { captureMusicVideoEvidence } = await import('../../lib/musicVideoDependencies.js');
    const dependencies = captureMusicVideoEvidence(original, { startSec: 8, endSec: 24 });
    original.excerpts[0].dependencies = dependencies;
    original.autoReviews[0].attempts[0].review.dependencies = dependencies;
    const acceptedPath = join(PATHS.videos, 'accepted.mp4');
    await mkdir(PATHS.videos, { recursive: true });
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=24:d=14', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', acceptedPath]);
    const { mutateVideoHistory } = await import('../videoGen/history.js');
    await mutateVideoHistory((items) => [{ id: 'accepted', filename: 'accepted.mp4', numFrames: 336, fps: 24, width: 64, height: 64 }, ...items.filter((i) => i.id !== 'accepted')]);
    const { startPerformanceRepair } = await import('./performanceRepair.js');
    const repair = await startPerformanceRepair('mv-1', 'mvs-1', { excerptId: 'draft', sourceAssetId: 'accepted', boundarySec: 14 });
    const [prefix, suffix] = repair.project.scenes;
    // The boundary frame names this machine as owner, so deleting it reaches peers.
    const frameSidecar = JSON.parse(await readFile(join(PATHS.images, suffix.referenceImageId.replace(/\.png$/, '.metadata.json')), 'utf8'));
    expect(frameSidecar.originInstanceId).toBe('local-inst');
    getProject.mockResolvedValue(repair.project);
    const prepared = await preparePerformanceShot({ musicVideo: { projectId: 'mv-1', sceneId: suffix.sceneId, revisionId: repair.revision.id },
      backend: 'fal', sourceImagePath: join(PATHS.images, suffix.referenceImageId), mode: 'image' });
    expect(prepared.shotInstruction.audioWindow).toEqual({ startSec: 14, endSec: 24, durationSec: 10 });
    expect(prepared.shotInstruction.edit).toEqual({ inSec: 0, outSec: 10, targetSec: 10 });
    expect(prepared.shotInstruction.repair).toMatchObject({ sourceAssetId: 'accepted', sourceTakeId: 'accepted-take', role: 'continuation' });
    const sliceWav = await readFile(prepared.audioFilePath);
    const sliced = pcm(sliceWav);
    expect(sliced.length / 2).toBe(10 * RATE);
    expect(sliced.readInt16LE((20 - 14) * RATE * 2)).toBe(30000);
    // A source edit to a short interval cannot make preparation pad backwards
    // across the accepted prefix or choose a different source frame.
    await expect(preparePerformanceShot({ musicVideo: { projectId: 'mv-1', sceneId: suffix.sceneId }, backend: 'fal', sourceImagePath: join(PATHS.images, suffix.referenceImageId) }))
      .rejects.toMatchObject({ code: 'PERFORMANCE_REPAIR_REVISION_REQUIRED' });

    const suffixPath = join(PATHS.videos, 'suffix.mp4');
    await mkdir(PATHS.videos, { recursive: true });
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', suffixPath]);
    await mkdir(PATHS.images, { recursive: true });
    const delivered = await readFile(suffixPath);
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (options?.method === 'POST') { posts.push(JSON.parse(options.body)); return jsonResponse({ request_id: 'suffix-request', status_url: 'https://queue.fal.run/suffix-s', response_url: 'https://queue.fal.run/suffix-r' }); }
      if (url === 'https://queue.fal.run/suffix-s') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/suffix-r') return jsonResponse({ video: { url: 'https://cdn.example.com/suffix.mp4' } });
      if (url === 'https://cdn.example.com/suffix.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(delivered).buffer };
      throw new Error('Unexpected synthetic provider request');
    }));
    const generated = await fal.generateVideo({ apiKey: 'test-key', modelId: prepared.modelId, resolution: prepared.resolution,
      sourceImagePath: join(PATHS.images, suffix.referenceImageId), audioFilePath: prepared.audioFilePath,
      lipSync: { enableTranscription: prepared.enableTranscription }, shotInstruction: prepared.shotInstruction });
    expect(await waitForTerminal(generated.jobId)).toMatchObject({ type: 'completed' });
    expect(posts).toHaveLength(1);
    expect(Buffer.from(posts[0].audio_url.replace(/^data:audio\/wav;base64,/, ''), 'base64')).toEqual(sliceWav);
    await expect(readFile(prepared.audioFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const landed = appendSceneTakes(repair.project, suffix.sceneId, [{ kind: 'video', assetId: generated.jobId, shotInstruction: prepared.shotInstruction }]).project;
    const clips = beatSnapClips(await resolveSceneClips(landed), [], { scenes: landed.scenes });
    expect(clips[0]).toMatchObject({ videoPath: acceptedPath, inSec: 0, outSec: 4, duration: 4, loop: false });
    expect(clips[1]).toMatchObject({ inSec: 0, outSec: 10, duration: 10 });
    expect(await findStalePerformanceTakes(landed, join(PATHS.music, 'song.wav'))).toEqual([]);
    const encode = (selected, filename) => {
      const { args } = buildMusicVideoFfmpegArgs(selected, join(PATHS.music, 'song.wav'), filename);
      execFileSync(ffmpeg, ['-v', 'error', ...args.filter((a, i) => a !== '-progress' && args[i - 1] !== '-progress')]);
    };
    const baseline = join(PATHS.videos, 'prefix-baseline.mp4');
    const output = join(PATHS.videos, 'repaired.mp4');
    encode([clips[0]], baseline);
    encode(clips, output);
    const pixels = (path) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-t', '4', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 4 * 1024 * 1024 });
    // H.264 quantization depends on following frames; compare the unchanged
    // source selection and allow only normal codec rounding in rendered pixels.
    const before = pixels(baseline), after = pixels(output);
    expect(after.length).toBe(before.length);
    let error = 0;
    for (let i = 0; i < before.length; i++) error += Math.abs(before[i] - after[i]);
    expect(error / before.length).toBeLessThan(2);
    expect(prefix.videoHistoryId).toBe('accepted');
  }, 60_000);
});

// Uniquely catches a draft standing a stale lip-sync shot in with another lip-sync take, or dropping a cutaway clip it has.
describe('draft fallbacks for stale performance shots', () => {
  it('draws a stale performance shot as its newest cutaway clip, else its still', async () => {
    const takes = [{ kind: 'video', assetId: 'cut-1' }, { kind: 'video', assetId: 'cut-2', shotInstruction: { shotMode: 'cutaway' } },
      { kind: 'video', assetId: 'sync-1', shotInstruction: { shotMode: 'performance' } }];
    const project = { scenes: [
      { sceneId: 'a', shotMode: 'performance', startSec: 0, endSec: 2, videoHistoryId: 'sync-1', takes },
      { sceneId: 'b', shotMode: 'performance', startSec: 2, endSec: 4, videoHistoryId: 'sync-2', referenceImageId: 'b.png',
        takes: [{ kind: 'video', assetId: 'sync-2', shotInstruction: { shotMode: 'performance' } }] },
      { sceneId: 'c', shotMode: 'cutaway', startSec: 4, endSec: 6, videoHistoryId: 'cut-3', takes: [] },
    ] };
    const drawn = await withDraftPerformanceFallbacks(project, '/no/master.wav');
    expect(drawn.scenes.map(({ sceneId, shotMode, videoHistoryId }) => [sceneId, shotMode, videoHistoryId])).toEqual([
      ['a', 'cutaway', 'cut-2'], ['b', 'cutaway', null], ['c', 'cutaway', 'cut-3'],
    ]);
    expect(project.scenes[0].videoHistoryId).toBe('sync-1');
  });
});

describe('the final render lip-sync gate', () => {
  // Uniquely catches a refusal that does not name its shots, or a locked clip still blocking.
  it('names the shots in song order with each reason, and lets a locked clip render as it plays', async () => {
    const shot = (sceneId, startSec) => ({ sceneId, startSec, endSec: startSec + 2, shotMode: 'performance', prompt: 'a singer',
      referenceImageId: `${sceneId}.png`, videoHistoryId: `${sceneId}-clip`,
      takes: [{ takeId: `${sceneId}-t`, kind: 'video', assetId: `${sceneId}-clip`, sourceImageId: `${sceneId}.png`, status: 'selected' }] });
    const project = { id: 'mv-1', scenes: [shot('late', 6), shot('early', 0), { ...shot('cut', 3), shotMode: 'cutaway' }] };
    await expect(assertCurrentPerformanceTakes(project, 'unread.wav')).rejects.toMatchObject({
      status: 422, code: 'STALE_PERFORMANCE_TAKES',
      message: 'Shots 1 (no lip-sync record), 3 (no lip-sync record): the selected take may not sing in sync with the song. Regenerate them or switch them to Cutaway',
      context: { stale: [{ sceneId: 'late', reason: 'not-lip-synced', cutaway: true }, { sceneId: 'early', reason: 'not-lip-synced', cutaway: true }] },
    });
    const stillLocked = setShotLocks(project, { sceneIds: ['late'], locked: true });
    const clipLocked = setShotLocks(stillLocked, { sceneIds: ['late'], locked: true, stage: 'video' });
    await expect(assertCurrentPerformanceTakes(clipLocked, 'unread.wav')).rejects.toThrow(/^Shot 1 \(no lip-sync record\): .* switch it to Cutaway$/);
    const allLocked = setShotLocks(setShotLocks(clipLocked, { sceneIds: ['early'], locked: true }), { sceneIds: ['early'], locked: true, stage: 'video' });
    await expect(assertCurrentPerformanceTakes(allLocked, 'unread.wav')).resolves.toBeUndefined();
  });
});
