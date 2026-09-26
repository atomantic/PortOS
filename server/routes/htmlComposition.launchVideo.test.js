import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { PATHS } from '../lib/fileUtils.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { enqueueJob } from '../services/mediaJobQueue/index.js';
import { cdpRequest } from '../services/browserService.js';
import { renderComposition } from '../services/htmlComposition/index.js';
import router from './htmlComposition.js';

vi.mock('../lib/fileUtils.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-launch-admission-'),
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(async () => ({ jobId: 'example-job', status: 'queued' })),
  attachSseClient: vi.fn(), cancelJob: vi.fn(),
}));
vi.mock('../services/browserService.js', () => ({ cdpRequest: vi.fn() }));
const app = express();
app.use(express.json());
app.use('/api/html-composition', router);
app.use(errorMiddleware);
const storyboard = () => ({ posterSec: 5, scenes: [{ durationSec: 20,
  lines: [{ text: 'Plan your next great project', wordCount: 5, holdSec: 2 }],
}] });
let directory;
const put = (name, text) => writeFile(join(PATHS.data, directory, name), text);
const submit = (extra = {}) => request(app).post('/api/html-composition/render').send({
  directory, launchVideo: { targetDurationSec: 20 }, ...extra,
});
beforeEach(async () => {
  vi.clearAllMocks();
  directory = `launch-videos/example/${randomUUID()}`;
  await mkdir(join(PATHS.data, directory), { recursive: true });
  await put('index.html', '<html><body>A fictional product demo</body></html>');
  await put('plan.md', 'Show entry, action, then result with fictional stand-ins.');
  await put('caption.txt', 'Turn a project into a clear plan.');
  await put('storyboard.json', JSON.stringify(storyboard()));
});
afterAll(cleanupTempDataRoots);

describe('launch-video render admission', () => {
  it.each([
    ['index.html', 'alice@example.com', 'email-address'],
    ['caption.txt', `ghp_${'a'.repeat(25)}`, 'secret-token'],
    ['plan.md', 'host-example.local', 'network-host'],
    ['notes.txt', '192.0.2.10', 'ip-literal'],
  ])('refuses detected private text in %s without echoing it, and accepts correction', async (file, value, code) => {
    await put(file, value);
    const denied = await submit();
    expect(denied.status).toBe(400);
    expect(JSON.stringify(denied.body)).toContain(`${code} in /${file}`);
    expect(JSON.stringify(denied.body)).not.toContain(value);
    expect(enqueueJob).not.toHaveBeenCalled();
    await put(file, 'Fictional product content');
    expect((await submit()).status).toBe(202);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });
  it('rejects the five-word 0.9s line and a fabricated word count', async () => {
    const plan = storyboard();
    plan.scenes[0].lines[0].holdSec = 0.9;
    await put('storyboard.json', JSON.stringify(plan));
    const denied = await submit();
    expect(denied.status).toBe(400);
    expect(JSON.stringify(denied.body)).toContain('scene 1 line 1');
    plan.scenes[0].lines[0].wordCount = 1;
    await put('storyboard.json', JSON.stringify(plan));
    expect(JSON.stringify((await submit()).body)).toContain('wordCount');
    expect(enqueueJob).not.toHaveBeenCalled();
  });
  it.each([
    plan => { plan.scenes[0].durationSec = 14; },
    plan => { plan.scenes[0].durationSec = 23; },
    plan => { plan.posterSec = 20; },
    plan => { plan.scenes[0].lines[0].holdSec = 21; },
  ])('refuses invalid timeline bounds', async change => {
    const plan = storyboard();
    change(plan);
    await put('storyboard.json', JSON.stringify(plan));
    expect((await submit()).status).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
  it('cannot omit the gate for a launch-videos directory', async () => {
    expect((await submit({ launchVideo: undefined })).status).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
  it('fails closed on uninspectable raster assets', async () => {
    await put('screen.png', Buffer.from([0, 1, 2]));
    expect((await submit()).status).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
  it('rechecks files changed after admission before opening the browser', async () => {
    expect((await submit()).status).toBe(202);
    const { params } = enqueueJob.mock.calls[0][0];
    await put('caption.txt', 'alice@example.com');
    await expect(renderComposition({ ...params, jobId: randomUUID() })).rejects.toThrow('email-address in /caption.txt');
    expect(cdpRequest).not.toHaveBeenCalled();
  });
});
