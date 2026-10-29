import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('mv-dcp-route-') }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../services/musicVideo/dcpPreflight.js', () => ({
  inspectDcpReadiness: vi.fn(), dcpSourceProblems: () => [], locateDcpTool: vi.fn(), probeDcpSource: vi.fn(), dcpSourceDigest: vi.fn(),
}));
const { default: router } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const preflight = await import('../services/musicVideo/dcpPreflight.js');
const app = express(); app.use(express.json()); app.use('/api/music-video', router); app.use(errorMiddleware);
const body = { grade: 'rec709', renderHistoryId: 'render-1', sourceSha256: 'a'.repeat(64) };
const readiness = { renderHistoryId: 'render-1', sourceSha256: body.sourceSha256, source: {}, tools: { create: false, encoder: false, verifier: false, ffprobe: true } };

describe('cinema package job admission', () => {
  it('surfaces missing tools through the job without creating an artifact', async () => {
    preflight.inspectDcpReadiness.mockResolvedValueOnce(readiness);
    const project = await projects.createProject({ name: 'Missing tools' });
    const started = await request(app).post(`/api/music-video/${project.id}/dcp/build`).send(body);
    expect(started.status).toBe(200);
    const events = await request(app).get(`/api/music-video/dcp/${started.body.jobId}/events`);
    expect(events.text).toContain('Install DCP-o-matic');
    expect((await projects.getProject(project.id)).dcpExports).toBeUndefined();
  }, 15000);
  it('reattaches and cancels a job during preparation', async () => {
    let release;
    preflight.inspectDcpReadiness.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(readiness); }));
    const project = await projects.createProject({ name: 'Cancel preparation' });
    const started = await request(app).post(`/api/music-video/${project.id}/dcp/build`).send(body);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const current = await request(app).get(`/api/music-video/${project.id}`);
    expect(current.body.activeDcpBuild.jobId).toBe(started.body.jobId);
    expect((await request(app).post(`/api/music-video/dcp/${started.body.jobId}/cancel`)).body.ok).toBe(true);
    release();
    const events = await request(app).get(`/api/music-video/dcp/${started.body.jobId}/events`);
    expect(events.text).toContain('"type":"canceled"');
    expect((await projects.getProject(project.id)).dcpExports).toBeUndefined();
  }, 15000);
});
afterAll(() => cleanupTempDataRoots());
