import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import crudRoutes from './crud.js';

// Mock the services this router (and its port-config service) touch.
vi.mock('../../services/apps.js', () => ({
  getAllApps: vi.fn(),
  getAppById: vi.fn(),
  createApp: vi.fn(),
  updateApp: vi.fn(),
  deleteApp: vi.fn(),
  archiveApp: vi.fn(),
  unarchiveApp: vi.fn(),
  updateAppLayeredIntelligence: vi.fn(),
  notifyAppsChanged: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

vi.mock('../../services/pm2.js', () => ({
  listProcessesStrict: vi.fn(),
  getAppStatusStrict: vi.fn()
}));

vi.mock('../../services/streamingDetect.js', () => ({
  parseEcosystemFromPath: vi.fn(),
  writeEcosystemPortEdits: vi.fn().mockResolvedValue({ file: 'ecosystem.config.cjs', changed: true, remapApplied: true, applied: [], unapplied: [] }),
  usesPm2: vi.fn((type) => !new Set(['ios-native', 'macos-native', 'xcode', 'swift']).has(type)),
  NON_PM2_TYPES: new Set(['ios-native', 'macos-native', 'xcode', 'swift'])
}));

vi.mock('../../services/appIconDetect.js', () => ({
  detectAppIcon: vi.fn(),
  getIconContentType: vi.fn(),
  isUsableSvg: vi.fn().mockResolvedValue(true)
}));

vi.mock('../../services/xcodeScripts.js', () => ({
  checkScripts: vi.fn().mockReturnValue({ missing: [], present: [] }),
  XCODE_SCRIPT_NAMES: ['deploy.sh', 'take_screenshots.sh', 'take_screenshots_macos.sh']
}));

import * as appsService from '../../services/apps.js';
import * as pm2Service from '../../services/pm2.js';
import * as streamingDetect from '../../services/streamingDetect.js';

describe('Apps CRUD Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', crudRoutes);
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
});
