/**
 * Music Video vocal stem (#8977), through the real router, the real multipart
 * parser, the real file-backed project store and real ffprobe: a stem on the
 * song's timebase is attached, a stem of a different length is refused before
 * it reaches the library, removing it keeps the library file, and changing the
 * song drops the stem that belonged to the old one.
 *
 * "Separate vocals" runs the same attach path from a demucs job. Only the
 * child processes are stubbed (venv creation, pip, the import probe and
 * demucs itself, which writes a vocals.wav the way demucs lays it out).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots, sweepStrayTempRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-vocal-stem-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn() }));
vi.mock('../lib/pythonSetup.js', async (importOriginal) => ({
  ...(await importOriginal()),
  classifyVenvBases: vi.fn(async () => ({ supported: ['/opt/python3.12/bin/python3'], rejected: [] })),
}));
vi.mock('../lib/cudaCapability.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getCudaCapability: vi.fn(async () => ({ status: 'available' })),
}));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { runStreamingCommand } = await import('../lib/streamingSpawn.js');
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

describe.skipIf(!ffmpeg)('music-video vocal separation', () => {
  const VENV = () => join(ROOT(), 'venvs', 'demucs');
  const PYTHON = () => join(VENV(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

  // A demucs double: builds the venv, installs, answers the import probe, and
  // separates by writing `<out>/htdemucs_ft/<song>/vocals.wav` of the given length.
  function demucsDouble({ stemSeconds = 6, failDevices = [] } = {}) {
    const calls = [];
    runStreamingCommand.mockImplementation(async (bin, args, onLine) => {
      calls.push([bin, ...args]);
      if (args[0] === '-m' && args[1] === 'venv') {
        mkdirSync(dirname(PYTHON()), { recursive: true });
        writeFileSync(PYTHON(), '');
        return { success: true };
      }
      if (args[0] === '-m' && args[1] === 'pip') {
        onLine?.('Collecting demucs');
        onLine?.('Successfully installed demucs soundfile');
        return { success: true };
      }
      if (args[0] === '-c') return { success: true };
      if (args[0] === '-m' && args[1] === 'demucs') {
        const device = args[args.indexOf('-d') + 1];
        if (failDevices.includes(device)) return { success: false, error: `exit 1: ${device} backend failed` };
        const outDir = args[args.indexOf('-o') + 1];
        onLine?.(' 50%|█████     | 5.0/10.0 [00:01<00:01]');
        mkdirSync(join(outDir, 'htdemucs_ft', 'song'), { recursive: true });
        writeFileSync(join(outDir, 'htdemucs_ft', 'song', 'vocals.wav'), wav(stemSeconds));
        return { success: true };
      }
      return { success: false, error: 'unexpected command' };
    });
    return calls;
  }

  beforeEach(() => {
    process.env.PORTOS_DEMUCS_VENV_DIR = VENV();
    rmSync(VENV(), { recursive: true, force: true });
    runStreamingCommand.mockReset();
  });
  afterAll(() => { delete process.env.PORTOS_DEMUCS_VENV_DIR; });

  it('installs demucs on first use, separates on the accelerator, falls back to the CPU, and attaches the stem', async () => {
    const calls = demucsDouble({ failDevices: ['mps', 'cuda'] });
    const res = await request(app).post(`/api/music-video/${project.id}/vocal-stem/separate`).send({});
    expect(res.status).toBe(202);
    expect(res.body.jobId).toEqual(expect.any(String));

    await vi.waitFor(async () => {
      expect((await projects.getProject(project.id)).vocalStemFilename).toMatch(/\.wav$/);
    }, { timeout: 10000 });
    const stem = (await projects.getProject(project.id)).vocalStemFilename;
    expect(existsSync(join(MUSIC(), stem))).toBe(true);

    const kinds = calls.map((argv) => argv.slice(1, 3).join(' '));
    expect(kinds[0]).toBe('-m venv');
    expect(kinds[1]).toBe('-m pip');
    const demucsRuns = calls.filter((argv) => argv[2] === 'demucs');
    expect(demucsRuns[0]).toEqual(expect.arrayContaining(['--two-stems=vocals', '-n', 'htdemucs_ft']));
    expect(demucsRuns.at(-1)[demucsRuns.at(-1).indexOf('-d') + 1]).toBe('cpu');
    expect(demucsRuns.length).toBe(2);
  }, 20000);

  it('reuses a working venv, and refuses a separated stem that does not match the song', async () => {
    mkdirSync(dirname(PYTHON()), { recursive: true });
    writeFileSync(PYTHON(), '');
    const calls = demucsDouble({ stemSeconds: 5 });
    const before = libraryFiles();
    const res = await request(app).post(`/api/music-video/${project.id}/vocal-stem/separate`).send({});
    expect(res.status).toBe(202);
    // The stream ends once the job is cleaned up; its last frame is the verdict.
    const events = await request(app).get(`/api/music-video/vocal-stem/separate/${res.body.jobId}/events`);
    expect(events.status).toBe(200);
    expect(events.text).toContain('"type":"error"');
    expect(events.text).toContain('MUSIC_VIDEO_VOCAL_STEM_TIMEBASE');
    expect(calls.some((argv) => argv[2] === 'venv' || argv[2] === 'pip')).toBe(false);
    expect((await projects.getProject(project.id)).vocalStemFilename).toBeUndefined();
    expect(libraryFiles()).toEqual(before);
  }, 20000);

  it('404s for a missing project and 400s for a project with no song, before any job starts', async () => {
    demucsDouble();
    const missing = await request(app).post('/api/music-video/mv-missing/vocal-stem/separate').send({});
    expect(missing.status).toBe(404);
    const empty = await projects.createProject({ name: 'No Song' });
    const noSong = await request(app).post(`/api/music-video/${empty.id}/vocal-stem/separate`).send({});
    expect(noSong.status).toBe(400);
    expect(noSong.body.code).toBe('NO_AUDIO');
    expect(runStreamingCommand).not.toHaveBeenCalled();
  });
});
