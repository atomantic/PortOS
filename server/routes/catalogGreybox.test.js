import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

vi.mock('../services/catalogGreybox.js', () => ({
  captureGreyboxShot: vi.fn(), draftGreybox: vi.fn(), previewGreyboxPrompt: vi.fn(), saveGreybox: vi.fn(), saveTown: vi.fn(), renderGreyboxShot: vi.fn(),
}));
const { renderGreyboxShot } = await import('../services/catalogGreybox.js');
const router = (await import('./catalog.js')).default;
const app = express();
app.use(express.json());
app.use('/api/catalog', router);
app.use(errorMiddleware);
const url = '/api/catalog/ingredients/example-place/greybox/shots/wide/render';

describe('POST greybox shot render', () => {
  it('accepts an empty command and returns the attached reference, refusing caller-supplied scenes', async () => {
    renderGreyboxShot.mockResolvedValue({ mediaKey: 'example.png', role: 'greybox-shot:wide' });
    const rendered = await request(app).post(url).send({});
    expect(rendered.status).toBe(201);
    expect(rendered.body).toMatchObject({ mediaKey: 'example.png' });
    expect(renderGreyboxShot).toHaveBeenCalledWith('example-place', 'wide');
    const refused = await request(app).post(url).send({ scene: {}, path: '/data/private' });
    expect(refused.status).toBe(400);
    expect(renderGreyboxShot).toHaveBeenCalledTimes(1);
  });

  it('keeps isolated-browser failures visible through the central error handler', async () => {
    renderGreyboxShot.mockRejectedValue(new ServerError('Isolation unavailable', { status: 503, code: 'PREVIEW_ISOLATION_UNAVAILABLE' }));
    const response = await request(app).post(url).send({});
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PREVIEW_ISOLATION_UNAVAILABLE');
  });
});

describe('PUT town map', () => {
  const town = { version: 1, seed: 7, sets: [{ id: 'set-a', ingredientId: 'example-street', position: [0, 0], rotationDegrees: 90 }], streets: [{ id: 'road-a', kind: 'road', sides: 'houses', width: 9, points: [[0, 0], [120, 0]] }] };

  it('saves a valid town and refuses a malformed one before the service', async () => {
    const { saveTown } = await import('../services/catalogGreybox.js');
    saveTown.mockResolvedValue({ id: 'example-town', payload: { town } });
    const saved = await request(app).put('/api/catalog/ingredients/example-town/town').send({ town });
    expect(saved.status).toBe(200);
    expect(saveTown).toHaveBeenCalledWith('example-town', town, { source: undefined });
    const dup = { ...town, streets: [{ ...town.streets[0], id: 'set-a' }] };
    const refused = await request(app).put('/api/catalog/ingredients/example-town/town').send({ town: dup });
    expect(refused.status).toBe(400);
    expect(saveTown).toHaveBeenCalledTimes(1);
  });
});
