import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Only the services these cases reach are stubbed; the barrel's other
// sub-routers import their real services, as their own suites do.
vi.mock('../services/meatspace.js', async (importOriginal) => ({
  ...await importOriginal(),
  getOverview: vi.fn(),
  updateBirthDate: vi.fn(),
}));
vi.mock('../services/meatspaceAlcohol.js', async (importOriginal) => ({
  ...await importOriginal(),
  getDailyAlcohol: vi.fn(),
}));
vi.mock('../services/meatspaceNicotine.js', async (importOriginal) => ({
  ...await importOriginal(),
  getDailyNicotine: vi.fn(),
}));

import * as meatspace from '../services/meatspace.js';
import * as alcohol from '../services/meatspaceAlcohol.js';
import * as nicotine from '../services/meatspaceNicotine.js';
import meatspaceRoutes from './meatspace.js';

const app = express();
app.use(express.json());
app.use('/api/meatspace', meatspaceRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.clearAllMocks());

describe('/api/meatspace (barrel over the per-domain routers)', () => {
  it('serves the overview from the core router', async () => {
    meatspace.getOverview.mockResolvedValue({ deathClock: null });
    expect((await request(app).get('/api/meatspace')).body).toEqual({ deathClock: null });
  });

  it('sets a past birth date and refuses a malformed one', async () => {
    meatspace.updateBirthDate.mockResolvedValue({ birthDate: '1980-02-03' });
    expect((await request(app).put('/api/meatspace/birth-date').send({ birthDate: '1980-02-03' })).status).toBe(200);
    expect(meatspace.updateBirthDate).toHaveBeenCalledWith('1980-02-03');

    meatspace.updateBirthDate.mockClear();
    expect((await request(app).put('/api/meatspace/birth-date').send({ birthDate: 'Feb 3' })).status).toBe(400);
    expect(meatspace.updateBirthDate).not.toHaveBeenCalled();
  });

  it('reads daily substance entries for a date window and refuses a non-date bound', async () => {
    alcohol.getDailyAlcohol.mockResolvedValue([]);
    nicotine.getDailyNicotine.mockResolvedValue([]);
    await request(app).get('/api/meatspace/alcohol/daily?from=2026-01-01&to=2026-01-31');
    expect(alcohol.getDailyAlcohol).toHaveBeenCalledWith('2026-01-01', '2026-01-31');
    await request(app).get('/api/meatspace/nicotine/daily');
    expect(nicotine.getDailyNicotine).toHaveBeenCalledWith(undefined, undefined);

    expect((await request(app).get('/api/meatspace/alcohol/daily?from=yesterday')).status).toBe(400);
    expect((await request(app).get('/api/meatspace/nicotine/daily?to=2026-1-5')).status).toBe(400);
  });
});
