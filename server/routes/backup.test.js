import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/backup.js', () => ({
  getState: vi.fn(),
  getNextRunTime: vi.fn(),
  runBackup: vi.fn(),
  listSnapshots: vi.fn(),
  restoreSnapshot: vi.fn()
}));

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn()
}));

import * as backup from '../services/backup.js';
import { getSettings } from '../services/settings.js';
import backupRoutes from './backup.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/backup', backupRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('backup routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/backup/status', () => {
    it('returns merged state, configured destPath, and nextRun', async () => {
      backup.getState.mockResolvedValue({ lastRun: '2026-04-01T00:00:00Z', success: true });
      backup.getNextRunTime.mockReturnValue('2026-04-08T00:00:00Z');
      getSettings.mockResolvedValue({ backup: { destPath: '/backup/target' } });

      const res = await request(buildApp()).get('/api/backup/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        lastRun: '2026-04-01T00:00:00Z',
        success: true,
        destPath: '/backup/target',
        nextRun: '2026-04-08T00:00:00Z'
      });
    });

    it('returns null destPath when backup is not configured', async () => {
      backup.getState.mockResolvedValue({});
      backup.getNextRunTime.mockReturnValue(null);
      getSettings.mockResolvedValue({});
      const res = await request(buildApp()).get('/api/backup/status');
      expect(res.status).toBe(200);
      expect(res.body.destPath).toBeNull();
    });
  });

  describe('POST /api/backup/run', () => {
    it('returns 400 when no destination is configured', async () => {
      getSettings.mockResolvedValue({ backup: {} });
      const res = await request(buildApp()).post('/api/backup/run');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BACKUP_NOT_CONFIGURED');
      expect(backup.runBackup).not.toHaveBeenCalled();
    });

    it('runs the backup and forwards excludePaths', async () => {
      getSettings.mockResolvedValue({
        backup: { destPath: '/dest', excludePaths: ['node_modules', '.git'] }
      });
      backup.runBackup.mockResolvedValue({ success: true, files: 100 });
      const res = await request(buildApp()).post('/api/backup/run');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, files: 100 });
      expect(backup.runBackup).toHaveBeenCalledWith(
        '/dest',
        undefined,
        { excludePaths: ['node_modules', '.git'] }
      );
    });

    it('passes empty excludePaths when not configured', async () => {
      getSettings.mockResolvedValue({ backup: { destPath: '/dest' } });
      backup.runBackup.mockResolvedValue({ success: true });
      await request(buildApp()).post('/api/backup/run');
      expect(backup.runBackup).toHaveBeenCalledWith(
        '/dest',
        undefined,
        { excludePaths: [] }
      );
    });
  });

  describe('GET /api/backup/snapshots', () => {
    it('returns the list of snapshots from the configured destPath', async () => {
      getSettings.mockResolvedValue({ backup: { destPath: '/dest' } });
      backup.listSnapshots.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      const res = await request(buildApp()).get('/api/backup/snapshots');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(backup.listSnapshots).toHaveBeenCalledWith('/dest');
    });
  });

  describe('POST /api/backup/restore', () => {
    it('returns 400 when snapshotId is missing', async () => {
      getSettings.mockResolvedValue({ backup: { destPath: '/dest' } });
      const res = await request(buildApp()).post('/api/backup/restore').send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(backup.restoreSnapshot).not.toHaveBeenCalled();
    });

    it('forwards a valid restore request to the service', async () => {
      getSettings.mockResolvedValue({ backup: { destPath: '/dest' } });
      backup.restoreSnapshot.mockResolvedValue({ success: true, restored: 42 });
      const res = await request(buildApp())
        .post('/api/backup/restore')
        .send({ snapshotId: 'snap-1', subdirFilter: 'data', dryRun: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, restored: 42 });
      expect(backup.restoreSnapshot).toHaveBeenCalledWith(
        '/dest',
        'snap-1',
        { dryRun: false, subdirFilter: 'data' }
      );
    });

    it('defaults dryRun to true when omitted', async () => {
      getSettings.mockResolvedValue({ backup: { destPath: '/dest' } });
      backup.restoreSnapshot.mockResolvedValue({ success: true });
      await request(buildApp())
        .post('/api/backup/restore')
        .send({ snapshotId: 'snap-2' });
      expect(backup.restoreSnapshot).toHaveBeenCalledWith(
        '/dest',
        'snap-2',
        expect.objectContaining({ dryRun: true })
      );
    });
  });
});
