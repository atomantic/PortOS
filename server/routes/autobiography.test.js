import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real autobiography service (file-backed) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-autobiography-routes-') }));
afterAll(cleanupTempDataRoots);

const { default: autobiographyRoutes } = await import('./autobiography.js');

const app = express();
app.use(express.json());
app.use('/api/digital-twin/autobiography', autobiographyRoutes);
app.use(errorMiddleware);
const BASE = '/api/digital-twin/autobiography';
const api = (method, path, body) => request(app)[method](`${BASE}${path}`).send(body);

describe('/api/digital-twin/autobiography', () => {
  it('saves a story to a custom question only when the question text is present, and reads it back', async () => {
    const missing = await api('post', '/stories', { promptId: 'custom', content: 'Once' });
    expect(missing.status).toBe(400);
    expect((await api('get', '/stories')).body).toEqual([]);

    const ok = await api('post', '/stories', { promptId: 'custom', content: 'Once', customPromptText: 'What was your first job?' });
    expect(ok.status).toBe(200);
    const stories = (await api('get', '/stories')).body;
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ id: ok.body.id, content: 'Once' });

    const updated = await api('put', `/stories/${ok.body.id}`, { content: 'Twice' });
    expect(updated.status).toBe(200);
    expect((await api('get', '/stories')).body[0].content).toBe('Twice');

    expect((await api('delete', `/stories/${ok.body.id}`)).status).toBe(200);
    expect((await api('get', '/stories')).body).toEqual([]);
  });

  it('persists a valid reminder time and refuses one the scheduler could not register', async () => {
    const bad = await api('put', '/config', { reminder: { enabled: true, time: '9am' } });
    expect(bad.status).toBe(400);
    expect((await api('get', '/config')).body.reminder?.time).not.toBe('9am');

    const good = await api('put', '/config', { reminder: { enabled: true, time: '09:30' } });
    expect(good.status).toBe(200);
    expect((await api('get', '/config')).body.reminder).toMatchObject({ enabled: true, time: '09:30' });
  });

  it('answers 404 for an unknown prompt or story', async () => {
    expect((await api('get', '/prompt/nope')).status).toBe(404);
    expect((await api('put', '/stories/nope', { content: 'x' })).status).toBe(404);
  });

  it('filters stories by theme and rejects a repeated theme parameter', async () => {
    const { body: themes } = await api('get', '/themes');
    const prompt = (await api('get', '/prompt')).body;
    const theme = prompt.themeId ?? themes[0].id;
    const saved = await api('post', '/stories', { promptId: prompt.id, content: 'Themed' });
    expect(saved.status).toBe(200);

    expect((await api('get', `/stories?theme=${theme}`)).body.map((s) => s.id)).toContain(saved.body.id);
    expect((await api('get', '/stories?theme=no-such-theme')).body).toEqual([]);
    expect((await api('get', '/stories?theme=a&theme=b')).status).toBe(400);
  });

  it('excludes the named prompt from the next-prompt pick', async () => {
    const first = (await api('get', '/prompt')).body;
    for (let i = 0; i < 5; i++) {
      expect((await api('get', `/prompt?exclude=${first.id}`)).body.id).not.toBe(first.id);
    }
  });
});
