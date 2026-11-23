import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

vi.mock('../../services/cos/cos.js', () => ({
  isRunning: vi.fn().mockReturnValue(true)
}));
vi.mock('../../services/cos/cosTaskStore.js', () => ({
  addTask: vi.fn().mockResolvedValue({ id: 'task-vite-1' })
}));

import * as appsService from '../../services/apps.js';
import { addTask } from '../../services/cos/cosTaskStore.js';
import { isRunning } from '../../services/cos/cos.js';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { PATHS } from '../../lib/fileUtils.js';
import { certPaths } from '../../../lib/certPaths.js';
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
    isRunning.mockReturnValue(true);
    addTask.mockResolvedValue({ id: 'task-vite-1' });
    repoDir = join(tmpdir(), `vite-host-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  const writeViteConfig = (content) =>
    writeFileSync(join(repoDir, 'vite.config.js'), content);

  describe('POST /:id/upgrade-tls', () => {
    const helperRel = join('lib', 'tailscale-https.js');
    const sourceHelper = () => readFileSync(join(PATHS.root, helperRel), 'utf-8');
    const mockApp = (extra = {}) =>
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir, ...extra });

    it('copies the helper, records tlsPort and returns the snippet', async () => {
      mockApp();
      const res = await request(app).post('/api/apps/app-001/upgrade-tls').send({ tlsPort: 5443 });

      expect(res.status).toBe(200);
      expect(res.body.overwrote).toBe(false);
      expect(res.body.helperPath).toBe(join(repoDir, helperRel));
      expect(res.body.snippet).toContain('server.listen(5443');
      expect(res.body.certDirHint).toBe(certPaths(PATHS.data).dir);
      expect(readFileSync(join(repoDir, helperRel), 'utf-8')).toBe(sourceHelper());
      expect(appsService.updateApp).toHaveBeenCalledWith('app-001', { tlsPort: 5443 });
    });

    it('refuses to overwrite an existing helper without force', async () => {
      mockApp();
      mkdirSync(join(repoDir, 'lib'), { recursive: true });
      writeFileSync(join(repoDir, helperRel), 'custom');

      for (const body of [{ tlsPort: 5443 }, { tlsPort: 5443, force: false }]) {
        const res = await request(app).post('/api/apps/app-001/upgrade-tls').send(body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALREADY_EXISTS');
      }
      expect(readFileSync(join(repoDir, helperRel), 'utf-8')).toBe('custom');
      expect(appsService.updateApp).not.toHaveBeenCalled();
    });

    it('overwrites an existing helper when force is true', async () => {
      mockApp();
      mkdirSync(join(repoDir, 'lib'), { recursive: true });
      writeFileSync(join(repoDir, helperRel), 'custom');

      const res = await request(app).post('/api/apps/app-001/upgrade-tls').send({ tlsPort: 5443, force: true });

      expect(res.status).toBe(200);
      expect(res.body.overwrote).toBe(true);
      expect(readFileSync(join(repoDir, helperRel), 'utf-8')).toBe(sourceHelper());
      expect(appsService.updateApp).toHaveBeenCalledWith('app-001', { tlsPort: 5443 });
    });

    it('returns 400 ALREADY_UPGRADED for the PortOS app', async () => {
      appsService.getAppById.mockResolvedValue({ id: appsService.PORTOS_APP_ID, name: 'PortOS', repoPath: repoDir });
      const res = await request(app).post(`/api/apps/${appsService.PORTOS_APP_ID}/upgrade-tls`).send({ tlsPort: 5443 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ALREADY_UPGRADED');
    });

    it('returns 400 PATH_NOT_FOUND for a missing or nonexistent repoPath', async () => {
      for (const repoPath of [undefined, join(repoDir, 'does-not-exist')]) {
        mockApp({ repoPath });
        const res = await request(app).post('/api/apps/app-001/upgrade-tls').send({ tlsPort: 5443 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PATH_NOT_FOUND');
      }
      expect(appsService.updateApp).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid tlsPort without touching the repo', async () => {
      mockApp();
      for (const tlsPort of [0, 65536, 1.5, '5443', undefined]) {
        const res = await request(app).post('/api/apps/app-001/upgrade-tls').send({ tlsPort });
        expect(res.status).toBe(400);
      }
      expect(existsSync(join(repoDir, helperRel))).toBe(false);
      expect(appsService.updateApp).not.toHaveBeenCalled();
    });
  });

  describe('GET /:id/vite-host-check', () => {
  it('rejects a repeated query key with 400 (vite-host-check, #16428)', async () => {
    appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });
    const res = await request(app).get('/api/apps/app-001/vite-host-check?host=a&host=b');
    expect(res.status).toBe(400);
  });

    it('reports hostAllowed=false + canAutoFix for a Vite app missing the host', async () => {
      writeViteConfig("export default { server: { port: 5173 } };");
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .get('/api/apps/app-001/vite-host-check?host=host-beta.example-tailnet.ts.net');

      expect(response.status).toBe(200);
      expect(response.body.hasViteConfig).toBe(true);
      expect(response.body.hostAllowed).toBe(false);
      expect(response.body.canAutoFix).toBe(true);
    });

    it('reports hostAllowed=true when the config already allows the tailnet', async () => {
      writeViteConfig("export default { server: { allowedHosts: ['.ts.net'] } };");
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .get('/api/apps/app-001/vite-host-check?host=host-gamma.example-tailnet.ts.net');

      expect(response.status).toBe(200);
      expect(response.body.hostAllowed).toBe(true);
    });

    it('reports hasViteConfig=false when the app has no vite config', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .get('/api/apps/app-001/vite-host-check?host=host-gamma.example-tailnet.ts.net');

      expect(response.status).toBe(200);
      expect(response.body.hasViteConfig).toBe(false);
    });
  });

  describe('POST /:id/fix-vite-hosts', () => {
    it('allow-all rewrites the config to allowedHosts: true', async () => {
      writeViteConfig("export default { server: { port: 5173 } };");
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .post('/api/apps/app-001/fix-vite-hosts')
        .send({ mode: 'allow-all', host: 'host-beta.example-tailnet.ts.net' });

      expect(response.status).toBe(200);
      expect(response.body.strategy).toBe('inject-into-server');
      const written = readFileSync(join(repoDir, 'vite.config.js'), 'utf-8');
      expect(written).toContain('allowedHosts: true');
    });

    it('allow-all returns 422 when no vite config exists', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });

      const response = await request(app)
        .post('/api/apps/app-001/fix-vite-hosts')
        .send({ mode: 'allow-all' });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('NO_VITE_CONFIG');
    });

    it('ai mode queues a CoS task targeting the app', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });
      isRunning.mockReturnValue(true);

      const response = await request(app)
        .post('/api/apps/app-001/fix-vite-hosts')
        .send({ mode: 'ai', host: 'host-beta.example-tailnet.ts.net' });

      expect(response.status).toBe(200);
      expect(response.body.taskId).toBe('task-vite-1');
      expect(addTask).toHaveBeenCalledWith(
        expect.objectContaining({ app: 'app-001', approvalRequired: true }),
        'internal'
      );
    });

    it('ai mode returns 409 when CoS is not running', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'A', repoPath: repoDir });
      isRunning.mockReturnValue(false);

      const response = await request(app)
        .post('/api/apps/app-001/fix-vite-hosts')
        .send({ mode: 'ai' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('COS_NOT_RUNNING');
    });
  });
});
