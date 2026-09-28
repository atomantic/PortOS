/**
 * Music Video vocal stem (#8977), through the real router, the real multipart
 * parser, the real file-backed project store and real ffprobe: a stem on the
 * song's timebase is attached, a stem of a different length is refused before
 * it reaches the library, removing it keeps the library file, and changing the
 * song drops the stem that belonged to the old one.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots, sweepStrayTempRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-vocal-stem-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { findFfmpeg } = await import('../lib/ffmpeg.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const RATE = 8000;
// A silent mono 16-bit PCM WAV of an exact length.
const wav = (seconds) => {
  const bytes = Math.round(seconds * RATE) * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
  return buf;
};

const MUSIC = () => join(ROOT(), 'music');
const libraryFiles = () => readdirSync(MUSIC()).sort();

async function uploadStem(projectId, seconds) {
  const form = new FormData();
  form.append('stem', new Blob([wav(seconds)], { type: 'audio/wav' }), 'vocals.wav');
  const encoded = new Request('http://localhost/', { method: 'POST', body: form });
  return request(app).post(`/api/music-video/${projectId}/vocal-stem`)
    .set('content-type', encoded.headers.get('content-type'))
    .send(Buffer.from(await encoded.arrayBuffer()));
}

const ffmpeg = await findFfmpeg();
// Vitest runs no hooks for a file whose every test is skipped, so on a runner
// without ffmpeg the afterAll below never fires — yet importing the router
// above already minted the lazy root (#9045).
if (!ffmpeg) cleanupTempDataRoots();

let project;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(MUSIC(), { recursive: true, force: true });
  mkdirSync(MUSIC(), { recursive: true });
  writeFileSync(join(MUSIC(), 'song.wav'), wav(6));
  writeFileSync(join(MUSIC(), 'other-song.wav'), wav(6));
  project = await projects.createProject({ name: 'Example Video', uploadedAudioFilename: 'song.wav' });
});
afterAll(async () => {
  cleanupTempDataRoots();
  // Real ffprobe/ffmpeg subprocess work (#9032) — see sweepStrayTempRoots's doc.
  await sweepStrayTempRoots('mv-vocal-stem-route-test-');
});

describe.skipIf(!ffmpeg)('music-video vocal stem routes', () => {
  it('attaches a stem on the song timebase, keeps it through removal in the library, and drops it with the song', async () => {
    const res = await uploadStem(project.id, 6);
    expect(res.status).toBe(200);
    const stem = res.body.vocalStemFilename;
    expect(stem).toMatch(/\.wav$/);
    expect(existsSync(join(MUSIC(), stem))).toBe(true);
    expect((await projects.getProject(project.id)).vocalStemFilename).toBe(stem);

    const removed = await request(app).delete(`/api/music-video/${project.id}/vocal-stem`);
    expect(removed.status).toBe(200);
    expect(removed.body.vocalStemFilename).toBeNull();
    // The library is shared, so the file stays.
    expect(existsSync(join(MUSIC(), stem))).toBe(true);

    // A stem is a bounce of one song; relinking the project drops it.
    await uploadStem(project.id, 6);
    const relinked = await request(app).patch(`/api/music-video/${project.id}`).send({ uploadedAudioFilename: 'other-song.wav' });
    expect(relinked.status).toBe(200);
    expect(relinked.body.vocalStemFilename).toBeNull();
  });

  it('refuses a stem whose length does not match the song, before it reaches the library', async () => {
    const before = libraryFiles();
    const res = await uploadStem(project.id, 5);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MUSIC_VIDEO_VOCAL_STEM_TIMEBASE');
    expect(libraryFiles()).toEqual(before);
    expect((await projects.getProject(project.id)).vocalStemFilename).toBeUndefined();
  });

  it('refuses a stem for a project with no song to match it against', async () => {
    const empty = await projects.createProject({ name: 'No Song' });
    const res = await uploadStem(empty.id, 6);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_AUDIO');
  });
});
