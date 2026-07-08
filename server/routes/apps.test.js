import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import appsRoutes from './apps.js';

// Mock the services
vi.mock('../services/apps.js', () => ({
  getAllApps: vi.fn(),
  getActiveApps: vi.fn(),
  getAppById: vi.fn(),
  createApp: vi.fn(),
  updateApp: vi.fn(),
  deleteApp: vi.fn(),
  archiveApp: vi.fn(),
  updateAppTaskTypeOverride: vi.fn(),
  getAppTaskTypeOverrides: vi.fn(),
  getAppLayeredIntelligenceConfig: vi.fn(),
  updateAppLayeredIntelligence: vi.fn(),
  toggleAllAppTaskTypes: vi.fn(),
  notifyAppsChanged: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn(),
  listProcessesStrict: vi.fn(),
  getAppStatus: vi.fn(),
  getAppStatusStrict: vi.fn(),
  startWithCommand: vi.fn(),
  stopApp: vi.fn(),
  restartApp: vi.fn(),
  getLogs: vi.fn()
}));

vi.mock('../services/history.js', () => ({
  logAction: vi.fn()
}));

// Mock the autonomous-jobs barrel so the layered-intelligence overview route can
// read the global job's enabled state without pulling in the whole CoS graph.
vi.mock('../services/autonomousJobs.js', () => ({
  getJob: vi.fn()
}));

vi.mock('../services/streamingDetect.js', () => ({
  parseEcosystemFromPath: vi.fn(),
  writeEcosystemPortEdits: vi.fn().mockResolvedValue({ file: 'ecosystem.config.cjs', changed: true, remapApplied: true, applied: [], unapplied: [] }),
  usesPm2: vi.fn((type) => !new Set(['ios-native', 'macos-native', 'xcode', 'swift']).has(type)),
  NON_PM2_TYPES: new Set(['ios-native', 'macos-native', 'xcode', 'swift'])
}));

vi.mock('../services/appUpdater.js', () => ({
  updateApp: vi.fn()
}));

vi.mock('../services/appIconDetect.js', () => ({
  detectAppIcon: vi.fn(),
  getIconContentType: vi.fn(),
  isUsableSvg: vi.fn().mockResolvedValue(true)
}));

vi.mock('../services/cos.js', () => ({
  getAgents: vi.fn().mockResolvedValue([]),
  getAgentDates: vi.fn().mockResolvedValue([]),
  getAgentsByDate: vi.fn().mockResolvedValue([]),
  isRunning: vi.fn().mockReturnValue(true),
  addTask: vi.fn().mockResolvedValue({ id: 'task-vite-1' })
}));

vi.mock('../services/git.js', () => ({
  stageFiles: vi.fn(),
  getStatus: vi.fn(),
  commit: vi.fn()
}));

vi.mock('../services/xcodeScripts.js', () => ({
  checkScripts: vi.fn().mockReturnValue({ missing: [], present: [] }),
  installScripts: vi.fn(),
  XCODE_TEAM_ID: 'TEST_TEAM',
  XCODE_BUNDLE_PREFIX: 'net.test',
  XCODE_SCRIPT_NAMES: ['deploy.sh', 'take_screenshots.sh', 'take_screenshots_macos.sh'],
  toBundleId: vi.fn(),
  toTargetName: vi.fn(),
  generateDeployScript: vi.fn(),
  generateScreenshotScript: vi.fn(),
  generateMacScreenshotScript: vi.fn()
}));

// Import mocked modules
import * as appsService from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';
import * as history from '../services/history.js';
import * as streamingDetect from '../services/streamingDetect.js';
import * as cos from '../services/cos.js';
import * as autonomousJobs from '../services/autonomousJobs.js';
import { detectAppIcon, getIconContentType, isUsableSvg } from '../services/appIconDetect.js';
import { installScripts } from '../services/xcodeScripts.js';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Apps Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', appsRoutes);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('GET /api/apps', () => {
    it('should return list of apps with PM2 status', async () => {
      const mockApps = [
        { id: 'app-001', name: 'Test App', pm2ProcessNames: ['test-app'], repoPath: '/tmp/test' }
      ];
      const mockPm2Processes = [
        { name: 'test-app', status: 'online' }
      ];

      appsService.getAllApps.mockResolvedValue(mockApps);
      pm2Service.listProcessesStrict.mockResolvedValue(mockPm2Processes);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].overallStatus).toBe('online');
    });

    it('should handle apps with no PM2 processes', async () => {
      const mockApps = [
        { id: 'app-001', name: 'Test App', pm2ProcessNames: [], repoPath: '/tmp/test' }
      ];

      appsService.getAllApps.mockResolvedValue(mockApps);
      pm2Service.listProcessesStrict.mockResolvedValue([]);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body[0].overallStatus).toBe('not_started');
    });

    it('reports unknown + degraded (not not_started) when the PM2 read fails', async () => {
      const mockApps = [
        { id: 'app-001', name: 'Test App', pm2ProcessNames: ['test-app'], repoPath: '/tmp/test' }
      ];

      appsService.getAllApps.mockResolvedValue(mockApps);
      // Strict read returns null on a failed PM2 read — must not collapse into
      // a confident "not started."
      pm2Service.listProcessesStrict.mockResolvedValue(null);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body[0].overallStatus).toBe('unknown');
      expect(response.body[0].degraded).toBe(true);
      expect(response.body[0].pm2Status['test-app'].status).toBe('unknown');
    });

    it('should return empty array when no apps exist', async () => {
      appsService.getAllApps.mockResolvedValue([]);
      pm2Service.listProcessesStrict.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(0);
    });
  });

  describe('GET /api/apps/:id', () => {
    it('should return app by ID', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatusStrict.mockResolvedValue({ name: 'test-app', status: 'online' });

      const response = await request(app).get('/api/apps/app-001');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('app-001');
      expect(response.body.pm2Status).toBeDefined();
    });

    it('returns degraded + unknown when the PM2 status read fails', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      // Detail endpoint reads per-process status via the strict variant, which
      // returns null on a failed read — must surface as degraded, not collapse
      // into a confident not_started.
      pm2Service.getAppStatusStrict.mockResolvedValue(null);

      const response = await request(app).get('/api/apps/app-001');

      expect(response.status).toBe(200);
      expect(response.body.overallStatus).toBe('unknown');
      expect(response.body.degraded).toBe(true);
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).get('/api/apps/app-999');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/apps', () => {
    it('should create a new app', async () => {
      const newApp = {
        name: 'New App',
        repoPath: '/path/to/repo'
      };
      appsService.createApp.mockResolvedValue({ id: 'app-001', ...newApp });

      const response = await request(app)
        .post('/api/apps')
        .send(newApp);

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('app-001');
      expect(appsService.createApp).toHaveBeenCalledWith(expect.objectContaining({ name: 'New App' }));
    });

    it('should return 400 if validation fails', async () => {
      // Missing required fields
      const response = await request(app)
        .post('/api/apps')
        .send({});

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/apps/:id', () => {
    it('should update an app', async () => {
      const updates = { name: 'Updated Name' };
      appsService.updateApp.mockResolvedValue({ id: 'app-001', name: 'Updated Name' });

      const response = await request(app)
        .put('/api/apps/app-001')
        .send(updates);

      expect(response.status).toBe(200);
      expect(appsService.updateApp).toHaveBeenCalledWith('app-001', expect.objectContaining({ name: 'Updated Name' }));
    });

    it('should return 404 if app not found', async () => {
      appsService.updateApp.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/apps/app-999')
        .send({ name: 'Test' });

      expect(response.status).toBe(404);
    });

    it('routes a layeredIntelligence update through the dedicated merge helper (not the shallow updateApp)', async () => {
      appsService.updateApp.mockResolvedValue({ id: 'app-001', name: 'App' });
      appsService.updateAppLayeredIntelligence.mockResolvedValue({ id: 'app-001', layeredIntelligence: { enabled: true, sources: { goals: true } } });

      const response = await request(app)
        .put('/api/apps/app-001')
        .send({ layeredIntelligence: { enabled: true } });

      expect(response.status).toBe(200);
      // The nested config must NOT be passed to the shallow updateApp (which would wipe it)…
      expect(appsService.updateApp).toHaveBeenCalledWith('app-001', expect.not.objectContaining({ layeredIntelligence: expect.anything() }));
      // …it goes through the preserving merge helper instead.
      expect(appsService.updateAppLayeredIntelligence).toHaveBeenCalledWith('app-001', { enabled: true });
      expect(response.body.layeredIntelligence.enabled).toBe(true);
    });

    it('GET /:id/layered-intelligence returns the effective config + isPortos flag', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'App' });
      appsService.getAppLayeredIntelligenceConfig.mockResolvedValue({
        enabled: false, intervalMs: 86400000, sources: { goals: true }, allowedScopes: ['app-improvement']
      });

      const response = await request(app).get('/api/apps/app-001/layered-intelligence');

      expect(response.status).toBe(200);
      expect(response.body.appId).toBe('app-001');
      expect(response.body.isPortos).toBe(false);
      expect(response.body.config.allowedScopes).toEqual(['app-improvement']);
      expect(appsService.getAppLayeredIntelligenceConfig).toHaveBeenCalledWith('app-001');
    });

    it('GET /:id/layered-intelligence flags the PortOS baseline app', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'portos-default', name: 'PortOS' });
      appsService.getAppLayeredIntelligenceConfig.mockResolvedValue({ enabled: false, allowedScopes: ['app-improvement', 'loop-meta'] });

      const response = await request(app).get('/api/apps/portos-default/layered-intelligence');

      expect(response.status).toBe(200);
      expect(response.body.isPortos).toBe(true);
    });

    it('GET /:id/layered-intelligence returns 404 for an unknown app', async () => {
      appsService.getAppById.mockResolvedValue(null);
      const response = await request(app).get('/api/apps/app-999/layered-intelligence');
      expect(response.status).toBe(404);
    });

    it('GET /layered-intelligence/overview summarizes every active app + global job state', async () => {
      appsService.getActiveApps.mockResolvedValue([
        { id: 'off-app', name: 'Zeta Off', layeredIntelligence: { enabled: false } },
        { id: 'on-app', name: 'Alpha On', layeredIntelligence: { enabled: true, intervalMs: 86400000 } },
        { id: 'portos-default', name: 'PortOS', layeredIntelligence: { enabled: true } }
      ]);
      autonomousJobs.getJob.mockResolvedValue({ id: 'job-layered-intelligence', enabled: true });

      const response = await request(app).get('/api/apps/layered-intelligence/overview');

      expect(response.status).toBe(200);
      expect(response.body.jobEnabled).toBe(true);
      expect(response.body.jobExists).toBe(true);
      expect(response.body.enabledCount).toBe(2);
      // Enabled first, PortOS ahead of other enabled, disabled last.
      expect(response.body.apps.map(a => a.id)).toEqual(['portos-default', 'on-app', 'off-app']);
      const portos = response.body.apps.find(a => a.id === 'portos-default');
      expect(portos.isPortos).toBe(true);
      expect(portos.allowedScopes).toContain('portos-self');
      // Free-text rules never leak into the list payload.
      expect(JSON.stringify(response.body)).not.toContain('"rules"');
      expect(appsService.getActiveApps).toHaveBeenCalled();
    });

    it('GET /layered-intelligence/overview reports jobEnabled:false when the job is missing', async () => {
      appsService.getActiveApps.mockResolvedValue([]);
      autonomousJobs.getJob.mockResolvedValue(null);

      const response = await request(app).get('/api/apps/layered-intelligence/overview');

      expect(response.status).toBe(200);
      expect(response.body.jobEnabled).toBe(false);
      expect(response.body.jobExists).toBe(false);
      expect(response.body.enabledCount).toBe(0);
    });

    it('writes changed ports back to the ecosystem config (source of truth)', async () => {
      // repoPath must exist on disk so the pathExists guard passes.
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 5173, uiPort: 5174 };
      appsService.getAppById.mockResolvedValue(mockApp);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({ processes: [{ name: 'a', ports: { api: 5173, ui: 5174 } }] });
      appsService.updateApp.mockResolvedValue({ ...mockApp, apiPort: 6000, uiPort: 6001 });

      const response = await request(app)
        .put('/api/apps/app-001')
        .send({ apiPort: 6000, uiPort: 6001 });

      expect(response.status).toBe(200);
      expect(streamingDetect.writeEcosystemPortEdits).toHaveBeenCalledWith(
        process.cwd(),
        expect.arrayContaining([[5173, 6000], [5174, 6001]]),
        []
      );
    });

    it('does not write to the ecosystem config when no port changed', async () => {
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 5173 };
      appsService.getAppById.mockResolvedValue(mockApp);
      appsService.updateApp.mockResolvedValue({ ...mockApp, name: 'Renamed' });

      await request(app).put('/api/apps/app-001').send({ name: 'Renamed' });

      expect(streamingDetect.writeEcosystemPortEdits).not.toHaveBeenCalled();
    });

    it('persists a shared-value port change via the per-process-targeted rewrite', async () => {
      // uiPort and apiPort both 6000 in the same process block. A value-keyed
      // rewrite can't split them, so the route routes it to the targeted edits
      // (process + label) instead — the edit now persists rather than 422.
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 6000, uiPort: 6000 };
      appsService.getAppById.mockResolvedValue(mockApp);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({ processes: [{ name: 'srv', ports: { api: 6000, ui: 6000 } }] });
      appsService.updateApp.mockResolvedValue({ ...mockApp, uiPort: 7000 });

      const response = await request(app).put('/api/apps/app-001').send({ uiPort: 7000 });

      expect(response.status).toBe(200);
      // Empty value-keyed remap (shared value), one targeted edit.
      expect(streamingDetect.writeEcosystemPortEdits).toHaveBeenCalledWith(
        process.cwd(),
        [],
        [{ processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 }]
      );
      expect(appsService.updateApp).toHaveBeenCalled();
    });

    it('persists a request mixing a distinct port (value-keyed) and a shared port (targeted) in one PUT', async () => {
      // devUiPort is distinct (5556) so it goes through the value-keyed remap;
      // apiPort/uiPort share 6000 so the uiPort edit goes through the targeted
      // edits. Both are handed to the single atomic writer in one call.
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 6000, uiPort: 6000, devUiPort: 5556 };
      appsService.getAppById.mockResolvedValue(mockApp);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({
        processes: [
          { name: 'srv', ports: { api: 6000, ui: 6000 } },
          { name: 'srv-ui', ports: { devUi: 5556 } }
        ]
      });
      appsService.updateApp.mockResolvedValue({ ...mockApp, uiPort: 7000, devUiPort: 7001 });

      const response = await request(app)
        .put('/api/apps/app-001')
        .send({ uiPort: 7000, devUiPort: 7001 });

      expect(response.status).toBe(200);
      // One atomic write: devUiPort (distinct) in remap; uiPort (shared) targeted.
      expect(streamingDetect.writeEcosystemPortEdits).toHaveBeenCalledWith(
        process.cwd(),
        [[5556, 7001]],
        [{ processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 }]
      );
      expect(appsService.updateApp).toHaveBeenCalled();
    });

    it('rejects (422) a shared-value port change the targeted rewrite cannot apply', async () => {
      // Shared value, but the targeted rewrite finds no matching literal to
      // change (e.g. derived from a const outside the block) → unapplied → 422.
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 6000, uiPort: 6000 };
      appsService.getAppById.mockResolvedValue(mockApp);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({ processes: [{ name: 'srv', ports: { api: 6000, ui: 6000 } }] });
      streamingDetect.writeEcosystemPortEdits.mockResolvedValueOnce({
        file: 'ecosystem.config.cjs', changed: false, remapApplied: false, applied: [],
        unapplied: [{ processName: 'srv', label: 'ui', oldPort: 6000, newPort: 7000 }]
      });

      const response = await request(app).put('/api/apps/app-001').send({ uiPort: 7000 });

      expect(response.status).toBe(422);
      expect(appsService.updateApp).not.toHaveBeenCalled();
    });

    it('ignores a submitted uiPort on a derived (served-by-API) app and pins it to the derived value', async () => {
      // App has an API process + Vite dev UI but no literal ports.ui, so the
      // displayed uiPort is derived (= apiPort). The drawer submits all fields
      // and never syncs the UI field to a changed API field, so a stale/echoed
      // or even hand-typed uiPort can't be distinguished from a deliberate
      // (impossible) independent UI change. The route ignores the submitted
      // value: no config write for the UI port, no 422, and the stored uiPort is
      // pinned to the derived value so it keeps tracking the API port.
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 6000, uiPort: 6000, devUiPort: 5556 };
      appsService.getAppById.mockResolvedValue(mockApp);
      // Parser yields api + devUi only; ui is derived from api (served-by-API).
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({
        processes: [{ name: 'srv', ports: { api: 6000, devUi: 5556 } }]
      });
      appsService.updateApp.mockResolvedValue({ ...mockApp });

      const response = await request(app).put('/api/apps/app-001').send({ uiPort: 7000 });

      expect(response.status).toBe(200);
      // No API port change → no config rewrite for the (ignored) UI port.
      expect(streamingDetect.writeEcosystemPortEdits).not.toHaveBeenCalled();
      // Stored uiPort pinned to the derived value (= unchanged apiPort 6000),
      // NOT the submitted 7000.
      const updateArg = appsService.updateApp.mock.calls[0][1];
      expect(updateArg.uiPort).toBe(6000);
    });

    it('strips the echoed derived uiPort so it is never persisted as an explicit field', async () => {
      // Same served-by-API shape; the modal echoes the derived uiPort (6000)
      // unchanged on a rename. That must NOT 422, but it also must NOT be stored
      // as a STALE explicit uiPort — the route pins it to the current derived
      // value so it keeps tracking apiPort instead of freezing.
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 6000, uiPort: 6000, devUiPort: 5556 };
      appsService.getAppById.mockResolvedValue(mockApp);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({
        processes: [{ name: 'srv', ports: { api: 6000, devUi: 5556 } }]
      });
      appsService.updateApp.mockResolvedValue({ ...mockApp, name: 'Renamed' });

      const response = await request(app)
        .put('/api/apps/app-001')
        .send({ name: 'Renamed', uiPort: 6000 });

      expect(response.status).toBe(200);
      expect(streamingDetect.writeEcosystemPortEdits).not.toHaveBeenCalled();
      // uiPort pinned to the derived value (= unchanged apiPort 6000) so a stale
      // stored value can't survive the merge.
      const updateArg = appsService.updateApp.mock.calls[0][1];
      expect(updateArg.uiPort).toBe(6000);
      expect(updateArg.name).toBe('Renamed');
    });

    it('changing apiPort on a served-by-API app (UI following the new API port) persists the API port and pins uiPort to the new derived value', async () => {
      // Valid combined save: API 6000→7000 with the UI following to 7000 (the
      // derived port tracks the new API port). The apiPort edit persists via the
      // value-keyed rewrite; the stored uiPort is overwritten with the NEW
      // derived value (7000) so a stale 6000 can't survive the updateApp merge
      // and block re-derivation.
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 6000, uiPort: 6000, devUiPort: 5556 };
      appsService.getAppById.mockResolvedValue(mockApp);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({
        processes: [{ name: 'srv', ports: { api: 6000, devUi: 5556 } }]
      });
      appsService.updateApp.mockResolvedValue({ ...mockApp, apiPort: 7000, uiPort: 7000 });

      const response = await request(app)
        .put('/api/apps/app-001')
        .send({ apiPort: 7000, uiPort: 7000 });

      expect(response.status).toBe(200);
      // apiPort (distinct, value-keyed) persisted; uiPort follows → not in remap.
      expect(streamingDetect.writeEcosystemPortEdits).toHaveBeenCalledWith(
        process.cwd(),
        [[6000, 7000]],
        []
      );
      const updateArg = appsService.updateApp.mock.calls[0][1];
      expect(updateArg.uiPort).toBe(7000); // pinned to new derived value
      expect(updateArg.apiPort).toBe(7000);
    });

    it('accepts the common API-only edit (drawer echoes the stale derived uiPort) and pins uiPort to the new API port', async () => {
      // The drawer submits all fields and does NOT sync the UI field when the
      // API field changes, so a normal API-only edit arrives as
      // { apiPort: 7000, uiPort: 6000 (old derived) }. That stale echo must NOT
      // 422 — the API port persists via the value-keyed rewrite and the stored
      // uiPort is pinned to the NEW derived value (7000), not the echoed 6000.
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 6000, uiPort: 6000, devUiPort: 5556 };
      appsService.getAppById.mockResolvedValue(mockApp);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({
        processes: [{ name: 'srv', ports: { api: 6000, devUi: 5556 } }]
      });
      appsService.updateApp.mockResolvedValue({ ...mockApp, apiPort: 7000, uiPort: 7000 });

      const response = await request(app)
        .put('/api/apps/app-001')
        .send({ apiPort: 7000, uiPort: 6000 });

      expect(response.status).toBe(200);
      // API port persisted; the stale echoed UI port is ignored, not remapped.
      expect(streamingDetect.writeEcosystemPortEdits).toHaveBeenCalledWith(
        process.cwd(),
        [[6000, 7000]],
        []
      );
      const updateArg = appsService.updateApp.mock.calls[0][1];
      expect(updateArg.uiPort).toBe(7000); // pinned to NEW derived value, not echoed 6000
      expect(updateArg.apiPort).toBe(7000);
    });

    it('does not reject a non-port edit on an app whose top-level ports are not stored (derived)', async () => {
      // apps.json has no apiPort/uiPort (derived from processes); a rename
      // submits the echoed display values. Those must not read as port changes.
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd() };
      appsService.getAppById.mockResolvedValue(mockApp);
      // Config currently serves these derived ports; the modal echoes them back.
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({ processes: [{ name: 'a', ports: { api: 5555, ui: 5556 } }] });
      appsService.updateApp.mockResolvedValue({ ...mockApp, name: 'Renamed' });

      const response = await request(app)
        .put('/api/apps/app-001')
        .send({ name: 'Renamed', apiPort: 5555, uiPort: 5556 });

      expect(response.status).toBe(200);
      expect(streamingDetect.writeEcosystemPortEdits).not.toHaveBeenCalled();
      expect(appsService.updateApp).toHaveBeenCalled();
    });

    it('rejects (422) when the port literal is not found in the config (changed:false)', async () => {
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 5173 };
      appsService.getAppById.mockResolvedValue(mockApp);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({ processes: [{ name: 'a', ports: { api: 5173 } }] });
      streamingDetect.writeEcosystemPortEdits.mockResolvedValueOnce({ file: 'ecosystem.config.cjs', changed: false, remapApplied: false, applied: [], unapplied: [] });

      const response = await request(app).put('/api/apps/app-001').send({ apiPort: 6000 });

      expect(response.status).toBe(422);
      expect(appsService.updateApp).not.toHaveBeenCalled();
    });

    it('fails the request (and does not update the registry) when the config write throws', async () => {
      const mockApp = { id: 'app-001', name: 'App', type: 'node', repoPath: process.cwd(), apiPort: 5173 };
      appsService.getAppById.mockResolvedValue(mockApp);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue({ processes: [{ name: 'a', ports: { api: 5173 } }] });
      streamingDetect.writeEcosystemPortEdits.mockRejectedValueOnce(new Error('EACCES'));

      const response = await request(app).put('/api/apps/app-001').send({ apiPort: 6000 });

      expect(response.status).toBeGreaterThanOrEqual(500);
      // Registry write must not happen after a failed canonical-config write.
      expect(appsService.updateApp).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/apps/:id', () => {
    it('should delete an app', async () => {
      appsService.deleteApp.mockResolvedValue(true);

      const response = await request(app).delete('/api/apps/app-001');

      expect(response.status).toBe(204);
      expect(appsService.deleteApp).toHaveBeenCalledWith('app-001');
    });

    it('should return 404 if app not found', async () => {
      appsService.deleteApp.mockResolvedValue(false);

      const response = await request(app).delete('/api/apps/app-999');

      expect(response.status).toBe(404);
    });

    it('should return 403 when deleting PortOS baseline app', async () => {
      const response = await request(app).delete('/api/apps/portos-default');

      expect(response.status).toBe(403);
      expect(appsService.deleteApp).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/apps/:id/archive', () => {
    it('should return 403 when archiving PortOS baseline app', async () => {
      const response = await request(app).post('/api/apps/portos-default/archive');

      expect(response.status).toBe(403);
      expect(appsService.archiveApp).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/apps/:id/start', () => {
    it('should start an app', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        repoPath: '/path/to/repo',
        pm2ProcessNames: ['test-app'],
        startCommands: ['npm run dev']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.startWithCommand.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/start');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(pm2Service.startWithCommand).toHaveBeenCalled();
      expect(history.logAction).toHaveBeenCalledWith('start', 'app-001', 'Test App', expect.any(Object), true);
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).post('/api/apps/app-999/start');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/apps/:id/stop', () => {
    it('should stop an app', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.stopApp.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/stop');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(pm2Service.stopApp).toHaveBeenCalledWith('test-app', undefined);
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).post('/api/apps/app-999/stop');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/apps/:id/restart', () => {
    it('should restart an app', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.restartApp.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/restart');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(pm2Service.restartApp).toHaveBeenCalledWith('test-app', undefined);
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).post('/api/apps/app-999/restart');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/apps - devUiPort enrichment', () => {
    it('should include devUiPort derived from process ports.devUi', async () => {
      const mockApps = [{
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app'],
        repoPath: '/tmp/test',
        processes: [{ name: 'test-app', ports: { devUi: 5554 } }]
      }];
      appsService.getAllApps.mockResolvedValue(mockApps);
      pm2Service.listProcessesStrict.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body[0].devUiPort).toBe(5554);
    });

    it('should derive uiPort from apiPort when app has devUi but no ui process', async () => {
      const mockApps = [{
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-api', 'test-ui'],
        repoPath: '/tmp/test',
        processes: [
          { name: 'test-api', ports: { api: 5551 } },
          { name: 'test-ui', ports: { devUi: 5550 } }
        ]
      }];
      appsService.getAllApps.mockResolvedValue(mockApps);
      pm2Service.listProcessesStrict.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body[0].uiPort).toBe(5551);
      expect(response.body[0].devUiPort).toBe(5550);
      expect(response.body[0].apiPort).toBe(5551);
    });

    it('should use explicit devUiPort over derived value', async () => {
      const mockApps = [{
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app'],
        repoPath: '/tmp/test',
        devUiPort: 4444,
        processes: [{ name: 'test-app', ports: { devUi: 5554 } }]
      }];
      appsService.getAllApps.mockResolvedValue(mockApps);
      pm2Service.listProcessesStrict.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body[0].devUiPort).toBe(4444);
    });
  });

  describe('POST /api/apps/:id/build', () => {
    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).post('/api/apps/app-999/build');

      expect(response.status).toBe(404);
    });

    it.skipIf(process.platform !== 'win32')('should reject build command args containing shell-unsafe metacharacters', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        repoPath: process.cwd(), // real path so pathExists check passes
        buildCommand: 'npm run build&whoami',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);

      const response = await request(app).post('/api/apps/app-001/build');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_BUILD_COMMAND');
    });

    it('should reject build commands not starting with npm or npx', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        repoPath: '/tmp',
        buildCommand: 'rm -rf /',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);

      const response = await request(app).post('/api/apps/app-001/build');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_BUILD_COMMAND');
    });

    it('should return 400 if repo path does not exist', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        repoPath: '/nonexistent/path/that/does/not/exist',
        buildCommand: 'npm run build',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);

      const response = await request(app).post('/api/apps/app-001/build');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('PATH_NOT_FOUND');
    });
  });

  describe('GET /api/apps/:id/status', () => {
    it('should return PM2 status for app processes', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-api', 'test-worker']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus
        .mockResolvedValueOnce({ status: 'online', cpu: 2.5 })
        .mockResolvedValueOnce({ status: 'stopped' });

      const response = await request(app).get('/api/apps/app-001/status');

      expect(response.status).toBe(200);
      expect(response.body['test-api']).toEqual({ status: 'online', cpu: 2.5 });
      expect(response.body['test-worker']).toEqual({ status: 'stopped' });
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).get('/api/apps/app-999/status');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/apps/:id/logs', () => {
    it('should return logs for app process', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getLogs.mockResolvedValue('Log line 1\nLog line 2');

      const response = await request(app).get('/api/apps/app-001/logs?lines=50');

      expect(response.status).toBe(200);
      expect(response.body.processName).toBe('test-app');
      expect(response.body.lines).toBe(50);
      expect(response.body.logs).toBe('Log line 1\nLog line 2');
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).get('/api/apps/app-999/logs');

      expect(response.status).toBe(404);
    });

    it('should return 400 if no process name available', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: []
      };
      appsService.getAppById.mockResolvedValue(mockApp);

      const response = await request(app).get('/api/apps/app-001/logs');

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/apps/:id/task-types/:taskType', () => {
    it('should accept valid taskMetadata with allowed boolean keys', async () => {
      appsService.updateAppTaskTypeOverride.mockResolvedValue({
        id: 'app-001',
        name: 'Test App',
        taskTypeOverrides: { 'feature-ideas': { taskMetadata: { useWorktree: true } } }
      });

      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: { useWorktree: true, simplify: false } });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should accept taskMetadata: null to clear metadata', async () => {
      appsService.updateAppTaskTypeOverride.mockResolvedValue({
        id: 'app-001',
        name: 'Test App',
        taskTypeOverrides: {}
      });

      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: null });

      expect(response.status).toBe(200);
    });

    it('should reject taskMetadata that is an array', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: [1, 2, 3] });

      expect(response.status).toBe(400);
    });

    it('should reject taskMetadata with only unknown keys', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: { unknownKey: true } });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('unrecognized');
    });

    it('should reject taskMetadata with non-boolean values for allowed keys', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({ taskMetadata: { useWorktree: 'yes' } });

      expect(response.status).toBe(400);
    });

    it('should return 400 when no valid fields provided', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/feature-ideas')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should reject an unknown taskType in the URL', async () => {
      const response = await request(app)
        .put('/api/apps/app-001/task-types/not-a-real-task-type')
        .send({ enabled: true });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_TASK_TYPE');
    });
  });

  describe('PUT /api/apps/bulk-task-type/:taskType', () => {
    it('should reject an unknown taskType in the URL', async () => {
      const response = await request(app)
        .put('/api/apps/bulk-task-type/not-a-real-task-type')
        .send({ enabled: true });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_TASK_TYPE');
    });
  });

  describe('GET /api/apps/:id/icon', () => {
    const iconDir = join(tmpdir(), 'portos-test-icon');
    const iconPath = join(iconDir, 'icon.png');
    const mockApp = { id: 'app-001', name: 'Test App', appIconPath: iconPath, repoPath: '/tmp/test', pm2ProcessNames: [] };

    beforeEach(() => {
      mkdirSync(iconDir, { recursive: true });
      writeFileSync(iconPath, 'fake-png-data');
      appsService.getAppById.mockResolvedValue(mockApp);
      getIconContentType.mockReturnValue('image/png');
    });

    afterAll(() => {
      rmSync(iconDir, { recursive: true, force: true });
    });

    it('should return icon with ETag header', async () => {
      const response = await request(app).get('/api/apps/app-001/icon');

      expect(response.status).toBe(200);
      expect(response.headers['etag']).toBeDefined();
      expect(response.headers['etag']).toMatch(/^W\//);
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
    });

    it('should return 304 when If-None-Match matches ETag', async () => {
      const first = await request(app).get('/api/apps/app-001/icon');
      const etag = first.headers['etag'];

      const second = await request(app)
        .get('/api/apps/app-001/icon')
        .set('If-None-Match', etag);

      expect(second.status).toBe(304);
    });

    it('should return 304 when If-None-Match contains multiple ETags including match', async () => {
      const first = await request(app).get('/api/apps/app-001/icon');
      const etag = first.headers['etag'];

      const second = await request(app)
        .get('/api/apps/app-001/icon')
        .set('If-None-Match', `W/"other-etag", ${etag}, W/"another"`);

      expect(second.status).toBe(304);
    });

    it('redetects when stored path is an unusable SVG (external <image href>) so PortOS-style icons recover', async () => {
      // Simulate the bad-state PortOS install: appIconPath stored as an SVG
      // that exists on disk but embeds <image href="/portos-logo.png"> — CSP
      // blocks the embed, so it renders blank. The route must re-detect.
      const badSvgPath = join(iconDir, 'favicon.svg');
      const goodPngPath = join(iconDir, 'redetected.png');
      writeFileSync(badSvgPath, '<svg><image href="/logo.png"/></svg>');
      writeFileSync(goodPngPath, 'fake-png-data');
      appsService.getAppById.mockResolvedValue({
        ...mockApp,
        appIconPath: badSvgPath,
      });
      isUsableSvg.mockResolvedValueOnce(false);
      detectAppIcon.mockResolvedValueOnce(goodPngPath);

      const response = await request(app).get('/api/apps/app-001/icon');

      expect(response.status).toBe(200);
      expect(detectAppIcon).toHaveBeenCalledWith('/tmp/test', undefined);
      expect(appsService.updateApp).toHaveBeenCalledWith('app-001', { appIconPath: goodPngPath });
    });
  });

  describe('PUT /api/apps/:id/task-types/all', () => {
    it('should toggle all task types for an app', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App' });
      appsService.toggleAllAppTaskTypes.mockResolvedValue({ id: 'app-001', name: 'Test App', taskTypeOverrides: { security: { enabled: true } } });

      const response = await request(app)
        .put('/api/apps/app-001/task-types/all')
        .send({ enabled: true });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.appId).toBe('app-001');
      expect(appsService.toggleAllAppTaskTypes).toHaveBeenCalledWith('app-001', true);
    });

    it('should return 400 when enabled is not a boolean', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App' });

      const response = await request(app)
        .put('/api/apps/app-001/task-types/all')
        .send({ enabled: 'yes' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should return 404 when app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/apps/app-999/task-types/all')
        .send({ enabled: true });

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/apps/:id/xcode-scripts/install', () => {
    it('should install requested scripts successfully', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });
      installScripts.mockResolvedValue({ installed: ['deploy.sh'], skipped: [], errors: [] });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['deploy.sh'] });

      expect(response.status).toBe(200);
      expect(response.body.installed).toEqual(['deploy.sh']);
    });

    it('should return 400 when all scripts fail', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });
      installScripts.mockResolvedValue({ installed: [], skipped: [], errors: ['some failure'] });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['deploy.sh'] });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INSTALL_FAILED');
    });

    it('should return 400 when scripts array contains an unknown name', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['bad.sh'] });

      // Unknown script names are now rejected by the Zod enum validator
      expect(response.status).toBe(400);
    });

    it('should return 400 when scripts array is empty', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: [] });

      expect(response.status).toBe(400);
    });

    it('should return 404 when app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/apps/app-999/xcode-scripts/install')
        .send({ scripts: ['deploy.sh'] });

      expect(response.status).toBe(404);
    });

    it('should return partial success with errors', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });
      installScripts.mockResolvedValue({
        installed: ['deploy.sh'],
        skipped: [],
        errors: ['Script take_screenshots_macos.sh does not apply to ios-native apps']
      });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['deploy.sh', 'take_screenshots_macos.sh'] });

      expect(response.status).toBe(200);
      expect(response.body.installed).toEqual(['deploy.sh']);
      expect(response.body.errors).toHaveLength(1);
    });

    it('should return 400 when repoPath does not exist', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/nonexistent/path' });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['deploy.sh'] });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('PATH_NOT_FOUND');
    });
  });

  describe('Vite Dev-UI host guard', () => {
    let repoDir;

    beforeEach(() => {
      repoDir = join(tmpdir(), `vite-host-${Math.random().toString(36).slice(2)}`);
      mkdirSync(repoDir, { recursive: true });
    });

    afterAll(() => {
      // best-effort cleanup of any straggler temp dirs is handled per-test below
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
});
