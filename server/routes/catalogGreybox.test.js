import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

vi.mock('../services/catalogGreybox.js', () => ({
  captureGreyboxShot: vi.fn(), draftGreybox: vi.fn(), previewGreyboxPrompt: vi.fn(), saveGreybox: vi.fn(), renderGreyboxShot: vi.fn(),
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
