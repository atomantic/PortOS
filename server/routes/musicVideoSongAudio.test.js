/**
 * A linked track whose audio is replaced in place (#14793): the project's beat
 * grid and lyric timing record the file they came from, the read response
 * reports the mismatch, and "keep old timing" adopts the new file explicitly.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { rmSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-song-audio-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../services/tracks/index.js', () => ({ getTrack: vi.fn() }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { getTrack } = await import('../services/tracks/index.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const analysis = (masterFilename) => ({ bpm: 120, beats: [0.5, 1], downbeats: [0.5], sections: [], durationSec: 10, ...(masterFilename ? { masterFilename } : {}) });

let project;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  getTrack.mockReset();
  getTrack.mockResolvedValue({ id: 'trk-1', audioFilename: 'take-2.wav' });
  project = await projects.createProject({ name: 'Example Video', trackId: 'trk-1' });
});
afterAll(cleanupTempDataRoots);

const read = async () => (await request(app).get(`/api/music-video/${project.id}`)).body;

describe('song audio replaced in place', () => {
  it('reports a beat grid made from an earlier file, and says nothing about a current or unrecorded one', async () => {
    await projects.setProjectAnalysis(project.id, analysis('take-1.wav'), project);
    expect((await read()).songAudioChange).toMatchObject({ masterFilename: 'take-2.wav', analysisStale: true, lyricsStale: false, analysisFrom: 'take-1.wav' });

    await projects.setProjectAnalysis(project.id, analysis('take-2.wav'), await projects.getProject(project.id));
    expect((await read()).songAudioChange).toBeNull();

    await projects.setProjectAnalysis(project.id, analysis(null), await projects.getProject(project.id));
    expect((await read()).songAudioChange).toBeNull();
  });

  it('keeps the old timing only when the director asks, moving the recorded basis to the current file', async () => {
    await projects.setProjectAnalysis(project.id, analysis('take-1.wav'), project);
    await projects.updateProject(project.id, {
      lyricTimingMasterFilename: 'take-1.wav',
      lyricCues: [{ id: 'c1', text: 'la la', startSec: 1, endSec: 2 }],
    });
    expect((await read()).songAudioChange).toMatchObject({ analysisStale: true, lyricsStale: true });

    const kept = await request(app).post(`/api/music-video/${project.id}/song/keep-timing`);
    expect(kept.status).toBe(200);
    expect(kept.body.songAudioChange).toBeNull();
    expect(kept.body.audioAnalysis).toMatchObject({ masterFilename: 'take-2.wav', beats: [0.5, 1] });
    expect(kept.body.lyricTimingMasterFilename).toBe('take-2.wav');
    expect(kept.body.lyricCues[0]).toMatchObject({ startSec: 1, endSec: 2 });
  });

  it('refuses a malformed prepare body instead of ignoring it', async () => {
    const r = await request(app).post(`/api/music-video/${project.id}/song/prepare`).send({ refresh: 'yes' });
    expect(r.status).toBe(400);
  });
});
