/**
 * Music Video timeline audio layers, through the real router, the real
 * multipart parser, the real file-backed project store and real ffmpeg: an
 * uploaded file lands as a layer at the requested song time, a PATCH moves,
 * re-levels, mutes and removes layers by id but cannot add a file, and the
 * render's song mix places the layer's sound at its time without changing the
 * song's length.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots, sweepStrayTempRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-audio-layer-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { resolveSoundBedPath } = await import('../services/musicVideo/render.js');
const { buildSongAudioMix } = await import('../services/musicVideo/clipSoundMix.js');
const { findFfmpeg, probeVideoDuration, runFfmpegProcess } = await import('../lib/ffmpeg.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const RATE = 8000;
// A mono 16-bit PCM WAV of an exact length: silent, or a full-scale square wave.
const wav = (seconds, { tone = false } = {}) => {
  const samples = Math.round(seconds * RATE);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  if (tone) for (let i = 0; i < samples; i += 1) buf.writeInt16LE((Math.floor(i / 20) % 2 ? 1 : -1) * 12000, 44 + i * 2);
  return buf;
};

const MUSIC = () => join(ROOT(), 'music');

async function uploadLayer(projectId, buffer, { name = 'sky line.wav', startSec } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), name);
  const encoded = new Request('http://localhost/', { method: 'POST', body: form });
  const query = startSec == null ? '' : `?startSec=${startSec}`;
  return request(app).post(`/api/music-video/${projectId}/audio-layers${query}`)
    .set('content-type', encoded.headers.get('content-type'))
    .send(Buffer.from(await encoded.arrayBuffer()));
}

// Peak level (dBFS) of `path` between `from` and `to` seconds.
async function peakDb(bin, path, from, to) {
  const { stderr } = await runFfmpegProcess({
    bin, returnStderr: true, stderrTailBytes: 20000,
    args: ['-hide_banner', '-i', path, '-af', `atrim=start=${from}:end=${to},volumedetect`, '-f', 'null', '-'],
  });
  const match = /max_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
  return match ? Number(match[1]) : -Infinity;
}

const ffmpeg = await findFfmpeg();
if (!ffmpeg) cleanupTempDataRoots();

let project;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(MUSIC(), { recursive: true, force: true });
  mkdirSync(MUSIC(), { recursive: true });
  writeFileSync(join(MUSIC(), 'song.wav'), wav(6));
  project = await projects.createProject({ name: 'Example Video', uploadedAudioFilename: 'song.wav' });
});
afterAll(async () => {
  cleanupTempDataRoots();
  await sweepStrayTempRoots('mv-audio-layer-route-test-');
});

describe.skipIf(!ffmpeg)('music-video audio layer routes', () => {
  it('adds an uploaded file as a layer at the requested time, then moves, re-levels, mutes and removes it by PATCH', async () => {
    const res = await uploadLayer(project.id, wav(2, { tone: true }), { startSec: 1.5 });
    expect(res.status).toBe(200);
    const { layer } = res.body;
    expect(layer).toMatchObject({ label: 'sky line', startSec: 1.5, volume: 1, muted: false });
    expect(layer.durationSec).toBeCloseTo(2, 1);
    expect(existsSync(join(MUSIC(), layer.filename))).toBe(true);
    expect(res.body.project.audioLayers).toEqual([layer]);

    const moved = await request(app).patch(`/api/music-video/${project.id}`)
      .send({ audioLayers: [{ id: layer.id, startSec: 3.25, volume: 1.6, muted: true, label: 'Kid: sky line' }, { id: 'not-a-layer', startSec: 0 }] });
    expect(moved.status).toBe(200);
    expect(moved.body.audioLayers).toEqual([{ ...layer, startSec: 3.25, volume: 1.6, muted: true, label: 'Kid: sky line' }]);

    const removed = await request(app).patch(`/api/music-video/${project.id}`).send({ audioLayers: [] });
    expect(removed.status).toBe(200);
    expect(removed.body.audioLayers).toEqual([]);
    // The library is shared, so the file stays.
    expect(existsSync(join(MUSIC(), layer.filename))).toBe(true);
  });

  it('refuses a PATCH that names a file, and an upload with a bad start or no sound, leaving no file behind', async () => {
    const forged = await request(app).patch(`/api/music-video/${project.id}`)
      .send({ audioLayers: [{ id: 'x', filename: 'song.wav' }] });
    expect(forged.status).toBe(400);

    const before = readdirSync(MUSIC()).sort();
    expect((await uploadLayer(project.id, wav(1), { startSec: -2 })).status).toBe(400);
    const unreadable = await uploadLayer(project.id, Buffer.from('not audio at all'));
    expect(unreadable.status).toBe(400);
    expect(unreadable.body.code).toBe('AUDIO_LAYER_UNREADABLE');
    expect(readdirSync(MUSIC()).sort()).toEqual(before);
    expect((await projects.getProject(project.id)).audioLayers ?? []).toEqual([]);
  });

  it('mixes an unmuted layer at its time over the song, cut at the song end, and leaves a muted one out', async () => {
    const tone = (await uploadLayer(project.id, wav(3, { tone: true }), { startSec: 2 })).body.layer;
    const quiet = (await uploadLayer(project.id, wav(1, { tone: true }), { startSec: 0.2 })).body.layer;
    await request(app).patch(`/api/music-video/${project.id}`).send({ audioLayers: [{ id: tone.id }, { id: quiet.id, muted: true }] });
    const extras = await resolveSoundBedPath(await projects.getProject(project.id));
    expect(extras.path).toBeNull();
    expect(extras.layers.map((bed) => bed.layerId)).toEqual([tone.id]);

    const songPath = join(MUSIC(), 'song.wav');
    const outPath = join(ROOT(), 'mixed.wav');
    const mix = buildSongAudioMix({ mainLabel: '[0:a]', soundBed: extras, voices: [], firstInputIdx: 1, durationSec: 6, outLabel: '[mixa]' });
    await runFfmpegProcess({ bin: ffmpeg, args: ['-hide_banner', '-loglevel', 'error', '-i', songPath, ...mix.inputs,
      '-filter_complex', mix.filters.join(';'), '-map', '[mixa]', '-y', outPath] });

    expect(await probeVideoDuration(outPath)).toBeCloseTo(6, 1);
    // Silent before the layer (the muted one would have sounded at 0.2s), loud while it plays.
    expect(await peakDb(ffmpeg, outPath, 0, 1.9)).toBeLessThan(-60);
    expect(await peakDb(ffmpeg, outPath, 2.2, 4.8)).toBeGreaterThan(-12);
  });
});
