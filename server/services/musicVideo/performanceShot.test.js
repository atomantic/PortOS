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
vi.mock('./projects.js', () => ({ getProject: (...a) => getProject(...a), listProjects: vi.fn(async () => []), updateProject: vi.fn() }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
// A pre-#9266 take's old master is found through the linked track's renders.
const getTrack = vi.fn(async () => null);
vi.mock('../tracks/index.js', () => ({ getTrack: (...a) => getTrack(...a) }));
// render.js reads clip history through local.js; point it at the real history
// store the fal lane writes, without loading the local runtime.
vi.mock('../videoGen/local.js', async () => {
  const history = await import('../videoGen/history.js');
  return { loadHistory: history.loadHistory, mutateVideoHistory: history.mutateVideoHistory };
});

const { PATHS } = await import('../../lib/fileUtils.js');
const { findFfmpeg, probeVideoStreamInfo } = await import('../../lib/ffmpeg.js');
const { preparePerformanceShot, findStalePerformanceTakes } = await import('./performanceShot.js');
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
    { id: 'c1', text: 'hold on', startSec: 19, endSec: 20.5 },
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
  // Queue-owned slices are deleted by the media-job queue, which these tests bypass.
  await rm(PATHS.uploads, { recursive: true, force: true });
  await mkdir(PATHS.music, { recursive: true });
  await writeFile(join(PATHS.music, 'song.wav'), songWav());
});

afterAll(() => cleanupTempDataRoots());

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
    expect(si.cues).toEqual([{ text: 'hold on', startSec: 0.775, endSec: 2.275 }]);
    expect(si.audio.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(si.audio.conditioning).toEqual({ source: 'master', sha256: si.audio.sha256 });
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

    // The take is only valid for the interval and recording it sang: a
    // re-timed scene or a replaced song must be regenerated, not rendered.
    const songPath = join(PATHS.music, 'song.wav');
    expect(await findStalePerformanceTakes({ scenes: [withTake] }, songPath)).toEqual([]);
    expect(await findStalePerformanceTakes({ scenes: [{ ...withTake, endSec: 22 }] }, songPath))
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
    expect(si.audio.conditioning).toEqual({ source: 'vocal-stem', sha256: sha(stem) });

    // A trimmed stem would put the syllables on the wrong frames.
    await writeFile(join(PATHS.music, 'vocals.wav'), songWav({ seconds: SONG_SEC - 1 }));
    await rm(PATHS.uploads, { recursive: true, force: true });
    await expect(preparePerformanceShot(args)).rejects.toMatchObject({ status: 400, code: 'MUSIC_VIDEO_VOCAL_STEM_TIMEBASE' });
    // A stem the record names but the disk lacks is not silently replaced by the mix.
    await rm(join(PATHS.music, 'vocals.wav'));
    await expect(preparePerformanceShot(args)).rejects.toMatchObject({ status: 404, code: 'MUSIC_VIDEO_VOCAL_STEM_MISSING' });
    expect(existsSync(PATHS.uploads) ? await readdir(PATHS.uploads) : []).toEqual([]);
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

  it('refuses a shot longer than the provider synchronizes instead of letting it truncate', async () => {
    getProject.mockResolvedValue(project({ startSec: 0, endSec: 30 }));
    await expect(preparePerformanceShot({
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend: 'fal', sourceImagePath: '/x/frame.png',
    })).rejects.toMatchObject({ status: 400, code: 'MUSIC_VIDEO_PERFORMANCE_TOO_LONG' });
  });

  it('refuses a performance shot on a lane without source-audio conditioning, before slicing anything', async () => {
    getProject.mockResolvedValue(project());
    for (const backend of ['grok', 'local']) {
      await expect(preparePerformanceShot({
        musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' }, backend, sourceImagePath: '/x/frame.png',
      })).rejects.toMatchObject({ status: 400, code: 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED', message: expect.stringMatching(backend === 'grok' ? /cutaway-only/ : /cannot lip-sync/) });
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
