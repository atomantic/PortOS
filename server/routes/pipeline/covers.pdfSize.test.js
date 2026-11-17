import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

const pdf = vi.hoisted(() => ({ buildComicPdf: vi.fn(), buildVolumePdf: vi.fn() }));
vi.mock('../../services/pipeline/comicPdf.js', async (importOriginal) => ({
  ...(await importOriginal()),
  buildComicPdf: pdf.buildComicPdf,
}));
vi.mock('../../services/pipeline/volumePdf.js', async (importOriginal) => ({
  ...(await importOriginal()),
  buildVolumePdf: pdf.buildVolumePdf,
}));

const { default: router } = await import('./covers.js');

const app = express();
app.use('/api/pipeline', router);
app.use(errorMiddleware);

const ROUTES = {
  comic: ['/api/pipeline/issues/i1/comic.pdf', pdf.buildComicPdf],
  volume: ['/api/pipeline/series/s1/seasons/n1/volume.pdf', pdf.buildVolumePdf],
};

describe.each(Object.entries(ROUTES))('%s.pdf ?size=', (_name, [path, build]) => {
  beforeEach(() => {
    vi.clearAllMocks();
    build.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), filename: 'x.pdf' });
  });

  it.each(['us-letter', 'a4', 'tabloid'])('passes the real size %s through', async (size) => {
    const res = await request(app).get(`${path}?size=${size}`);
    expect(res.status).toBe(200);
    expect(build.mock.calls[0][build.mock.calls[0].length - 1].size).toBe(size);
  });

  it('defaults to us-letter when size is omitted', async () => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(build.mock.calls[0][build.mock.calls[0].length - 1].size).toBe('us-letter');
  });

  it.each(['letter', 'A4', ''])('400s on an unknown size %j and never builds', async (size) => {
    const res = await request(app).get(`${path}?size=${size}`);
    expect(res.status).toBe(400);
    expect(build).not.toHaveBeenCalled();
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    '400s on the Object.prototype key %s and never builds', async (size) => {
      const res = await request(app).get(`${path}?size=${size}`);
      expect(res.status).toBe(400);
      expect(build).not.toHaveBeenCalled();
    });
});
