import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import viteTlsRoutes from './viteTls.js';

// Real viteAllowedHosts / fileUtils / certPaths run against temp dirs; only the
// apps registry and the CoS task queue are mocked.
vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
  updateApp: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

vi.mock('../../services/cos.js', () => ({
  isRunning: vi.fn().mockReturnValue(true),
  addTask: vi.fn().mockResolvedValue({ id: 'task-vite-1' })
}));

import * as appsService from '../../services/apps.js';
import * as cos from '../../services/cos.js';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Apps Vite Dev-UI host guard', () => {
  let app;
  let repoDir;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', viteTlsRoutes);
    vi.clearAllMocks();
    cos.isRunning.mockReturnValue(true);
    cos.addTask.mockResolvedValue({ id: 'task-vite-1' });
    repoDir = join(tmpdir(), `vite-host-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repoDir, { recursive: true });
  });

  const writeViteConfig = (content) =>
    writeFileSync(join(repoDir, 'vite.config.js'), content);

  describe('GET /:id/vite-host-check', () => {
    it('reports hostAllowed=false + canAutoFix for a Vite app missing the host', async () => {
      writeViteConfig("export default { server: { port: 5173 } };");
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .get('/api/apps/app-001/vite-host-check?host=null.taile8179.ts.net');

      expect(response.status).toBe(200);
      expect(response.body.hasViteConfig).toBe(true);
      expect(response.body.hostAllowed).toBe(false);
      expect(response.body.canAutoFix).toBe(true);
      rmSync(repoDir, { recursive: true, force: true });
    });

    it('reports hostAllowed=true when the config already allows the tailnet', async () => {
      writeViteConfig("export default { server: { allowedHosts: ['.ts.net'] } };");
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .get('/api/apps/app-001/vite-host-check?host=box.taile8179.ts.net');

      expect(response.status).toBe(200);
      expect(response.body.hostAllowed).toBe(true);
      rmSync(repoDir, { recursive: true, force: true });
    });

    it('reports hasViteConfig=false when the app has no vite config', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .get('/api/apps/app-001/vite-host-check?host=box.taile8179.ts.net');

      expect(response.status).toBe(200);
      expect(response.body.hasViteConfig).toBe(false);
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  describe('POST /:id/fix-vite-hosts', () => {
    it('allow-all rewrites the config to allowedHosts: true', async () => {
      writeViteConfig("export default { server: { port: 5173 } };");
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .post('/api/apps/app-001/fix-vite-hosts')
        .send({ mode: 'allow-all', host: 'null.taile8179.ts.net' });

      expect(response.status).toBe(200);
      expect(response.body.strategy).toBe('inject-into-server');
      const written = readFileSync(join(repoDir, 'vite.config.js'), 'utf-8');
      expect(written).toContain('allowedHosts: true');
      rmSync(repoDir, { recursive: true, force: true });
    });

    it('allow-all returns 422 when no vite config exists', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .post('/api/apps/app-001/fix-vite-hosts')
        .send({ mode: 'allow-all' });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('NO_VITE_CONFIG');
      rmSync(repoDir, { recursive: true, force: true });
    });

    it('ai mode queues a CoS task targeting the app', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });
      cos.isRunning.mockReturnValue(true);

      const response = await request(app)
        .post('/api/apps/app-001/fix-vite-hosts')
        .send({ mode: 'ai', host: 'null.taile8179.ts.net' });

      expect(response.status).toBe(200);
      expect(response.body.taskId).toBe('task-vite-1');
      expect(cos.addTask).toHaveBeenCalledWith(
        expect.objectContaining({ app: 'app-001', approvalRequired: true }),
        'internal'
      );
      rmSync(repoDir, { recursive: true, force: true });
    });

    it('ai mode returns 409 when CoS is not running', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });
      cos.isRunning.mockReturnValue(false);

      const response = await request(app)
        .post('/api/apps/app-001/fix-vite-hosts')
        .send({ mode: 'ai' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('COS_NOT_RUNNING');
      rmSync(repoDir, { recursive: true, force: true });
    });
  });
});
