import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/mortalLoomStore.js', () => ({
  getStatus: vi.fn(),
  importToPortOS: vi.fn(),
  MORTALLOOM_APP_STORE_URL: 'https://apps.apple.com/app/id0000000000',
}));

import { getStatus, importToPortOS } from '../services/mortalLoomStore.js';
import mortalloomRoutes from './mortalloom.js';

const app = express();
app.use(express.json());
app.use('/api/mortalloom', mortalloomRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.clearAllMocks());

describe('/api/mortalloom', () => {
  it('imports the MortalLoom store into PortOS on POST /import', async () => {
    importToPortOS.mockResolvedValue({ imported: { alcohol: 2 } });
    const res = await request(app).post('/api/mortalloom/import');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: { alcohol: 2 } });
  });

  it('reports a failed import through the error envelope', async () => {
    importToPortOS.mockRejectedValue(new Error('iCloud store unreadable'));
    const res = await request(app).post('/api/mortalloom/import');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual(expect.any(String));
  });

  it('serves status and the App Store link without importing', async () => {
    getStatus.mockResolvedValue({ available: false });
    expect((await request(app).get('/api/mortalloom/status')).body).toEqual({ available: false });
    expect((await request(app).get('/api/mortalloom/app-store')).body).toEqual({ url: 'https://apps.apple.com/app/id0000000000' });
    expect(importToPortOS).not.toHaveBeenCalled();
  });
});
