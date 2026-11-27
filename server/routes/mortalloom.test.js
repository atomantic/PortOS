import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/mortalLoomStore.js', () => ({
  getStatus: vi.fn(),
  importToPortOS: vi.fn(),
  previewMortalLoomRecoveryCopy: vi.fn(),
  MORTALLOOM_APP_STORE_URL: 'https://apps.apple.com/app/id0000000000',
}));

import { getStatus, importToPortOS, previewMortalLoomRecoveryCopy } from '../services/mortalLoomStore.js';
import mortalloomRoutes from './mortalloom.js';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  // Model the authority authGate would derive, not an authorization bypass
  // in the route under test.
  if (req.get('X-Test-Session')) req.portosAuthContext = { enabled: true, authenticated: true, method: 'session' };
  next();
});
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

  it('requires an operator and opaque ID before previewing a recovery copy', async () => {
    const url = '/api/mortalloom/recovery/preview';
    const id = 'a'.repeat(64);
    expect((await request(app).post(url).send({ id })).status).toBe(403);
    expect((await request(app).post(url).set('X-Test-Session', 'operator').send({ id: '../private.json' })).status).toBe(400);
    expect(previewMortalLoomRecoveryCopy).not.toHaveBeenCalled();

    previewMortalLoomRecoveryCopy.mockResolvedValue({ goals: 2, healthMetrics: 31 });
    const response = await request(app).post(url).set('X-Test-Session', 'operator').send({ id });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ goals: 2, healthMetrics: 31 });
    expect(previewMortalLoomRecoveryCopy).toHaveBeenCalledExactlyOnceWith(id);
  });

  it('serves status without importing', async () => {
    getStatus.mockResolvedValue({ available: false });
    expect((await request(app).get('/api/mortalloom/status')).body).toEqual({ available: false });
    expect(importToPortOS).not.toHaveBeenCalled();
  });
});
