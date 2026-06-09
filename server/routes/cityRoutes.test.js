import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the service layer — these route tests verify routing + query validation,
// not the capture/store logic (covered in citysnapshots.test.js).
const captureSnapshot = vi.fn();
const getSnapshots = vi.fn();
const getSnapshotConfig = vi.fn();
const getNextSnapshotTime = vi.fn();
const getCityIntrospection = vi.fn();

vi.mock('../services/citysnapshots.js', () => ({
  captureSnapshot: (...a) => captureSnapshot(...a),
  getSnapshots: (...a) => getSnapshots(...a),
  getSnapshotConfig: (...a) => getSnapshotConfig(...a),
}));
vi.mock('../services/citySnapshotScheduler.js', () => ({
  getNextSnapshotTime: (...a) => getNextSnapshotTime(...a),
}));
vi.mock('../services/cityIntrospection.js', () => ({
  getCityIntrospection: (...a) => getCityIntrospection(...a),
}));

const { default: cityRoutes } = await import('./cityRoutes.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/city', cityRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('city snapshot routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSnapshots.mockResolvedValue({ total: 0, snapshots: [] });
    getSnapshotConfig.mockResolvedValue({ enabled: true, intervalMinutes: 5, maxSnapshots: 1000 });
    getNextSnapshotTime.mockReturnValue('2026-06-05T12:00:00.000Z');
    captureSnapshot.mockResolvedValue({ ts: '2026-06-05T11:55:00.000Z', schemaVersion: 1, counts: {} });
  });

  describe('GET /api/city/snapshots', () => {
    it('returns the series with no query params', async () => {
      getSnapshots.mockResolvedValue({ total: 2, snapshots: [{ ts: 'a' }, { ts: 'b' }] });
      const res = await request(makeApp()).get('/api/city/snapshots');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(getSnapshots).toHaveBeenCalledWith({ since: undefined, limit: undefined });
    });

    it('coerces limit and passes a valid since through', async () => {
      const res = await request(makeApp()).get('/api/city/snapshots?limit=10&since=2026-06-01T00:00:00.000Z');
      expect(res.status).toBe(200);
      expect(getSnapshots).toHaveBeenCalledWith({ since: '2026-06-01T00:00:00.000Z', limit: 10 });
    });

    it('rejects a non-numeric limit', async () => {
      const res = await request(makeApp()).get('/api/city/snapshots?limit=abc');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a malformed since timestamp', async () => {
      const res = await request(makeApp()).get('/api/city/snapshots?since=not-a-date');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/city/snapshots/capture', () => {
    it('captures a frame on demand', async () => {
      const res = await request(makeApp()).post('/api/city/snapshots/capture');
      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe(1);
      expect(captureSnapshot).toHaveBeenCalledOnce();
    });
  });

  describe('GET /api/city/introspection', () => {
    it('passes the introspection payload through, including db: null', async () => {
      const payload = { ts: '2026-06-09T00:00:00.000Z', db: null, fs: { domains: [], totalBytes: 0, totalFiles: 0 } };
      getCityIntrospection.mockResolvedValue(payload);
      const res = await request(makeApp()).get('/api/city/introspection');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(payload);
      expect(getCityIntrospection).toHaveBeenCalledOnce();
    });
  });

  describe('GET /api/city/snapshots/config', () => {
    it('returns effective config plus the next run time', async () => {
      const res = await request(makeApp()).get('/api/city/snapshots/config');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enabled: true, intervalMinutes: 5, maxSnapshots: 1000,
        nextRun: '2026-06-05T12:00:00.000Z',
      });
    });
  });
});
