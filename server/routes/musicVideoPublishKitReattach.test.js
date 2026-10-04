/**
 * Publishing kit reattach (#9942), through the real router: a second build
 * request answers 409 carrying the running job's id, and the project read
 * exposes that in-flight build so a reloaded page can reattach.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('mv-publish-kit-reattach-') }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const ffmpegLib = await import('../lib/ffmpeg.js');
const { saveHistory } = await import('../services/videoGen/history.js');
const { PATHS } = await import('../lib/paths.js');
const { mkdir, writeFile } = await import('node:fs/promises');
const { join } = await import('node:path');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

afterAll(() => cleanupTempDataRoots());

describe('publishing kit build reattach (#9942)', () => {
  it('returns the running jobId on a second build and on the project read', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'reattach-master.mp4'), 'placeholder; never encoded');
    await saveHistory([{ id: 'reattach-render', filename: 'reattach-master.mp4', durationSec: 30 }]);
    await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, renderHistoryId: 'reattach-render' } }));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const probe = vi.spyOn(ffmpegLib, 'findFfmpeg').mockReturnValue(gate);
    try {
      const first = request(app).post(`/api/music-video/${id}/publish-kit/build`).then((r) => r);
      await vi.waitFor(() => expect(probe).toHaveBeenCalled());
      const second = await request(app).post(`/api/music-video/${id}/publish-kit/build`);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('PUBLISH_KIT_BUILD_IN_PROGRESS');
      expect(second.body.context).toMatchObject({ status: 'running', jobId: expect.stringMatching(/^mvpk-/) });
      const read = await request(app).get(`/api/music-video/${id}`);
      expect(read.body.activePublishKitBuild).toEqual(second.body.context);
      release(null);
      await first;
      const after = await request(app).get(`/api/music-video/${id}`);
      expect(after.body.activePublishKitBuild).toBeUndefined();
    } finally {
      release(null);
      probe.mockRestore();
    }
  });
});
