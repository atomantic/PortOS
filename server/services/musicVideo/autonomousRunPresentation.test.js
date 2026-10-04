/**
 * Project reads present `autonomousRun.interrupted` (#10022) — through the real
 * router and file-backed project store, so a reloaded page can offer Resume.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-auto-present-test-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('../../routes/musicVideo.js');
const projects = await import('./projects.js');
const { __autonomousProcessId } = await import('./autonomousService.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

afterAll(() => cleanupTempDataRoots());

describe('autonomous run restart presentation (#10022)', () => {
  it('project reads mark a run pinned to another process as interrupted — but never store the flag', async () => {
    const project = await projects.createProject({ name: 'Auto Present' });
    const pin = (processId) => projects.mutateProjectRecord(project.id, (record) => ({
      project: { ...record, autonomousRun: { id: 'run-1', status: 'running', processId } },
    }));
    await pin('proc-before-restart');
    const one = await request(app).get(`/api/music-video/${project.id}`);
    expect(one.body.autonomousRun).toMatchObject({ status: 'running', interrupted: true });
    const list = await request(app).get('/api/music-video');
    expect(list.body.find((p) => p.id === project.id).autonomousRun.interrupted).toBe(true);

    await pin(__autonomousProcessId());
    const live = await request(app).get(`/api/music-video/${project.id}`);
    expect(live.body.autonomousRun.interrupted).toBe(false);
    expect((await projects.getProject(project.id)).autonomousRun).not.toHaveProperty('interrupted');
  });
});
