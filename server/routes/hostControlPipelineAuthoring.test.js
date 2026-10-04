import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER, SESSION_TTL_MS } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pipeline-authority-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// Real Pipeline routers behind the real auth gates (#10068). Provider dispatch,
// run creation, record stores and the image queue are doubled, so a request that
// is not refused would be visible as a call on one of these effects.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  titleLogo: vi.fn(async () => ({ logo: 'example' })),
  generateStage: vi.fn(async () => ({ runId: 'example-run' })),
  autoRun: vi.fn(async () => ({ runId: 'example-run', alreadyRunning: false })),
  enqueueVisual: vi.fn(async () => ({ jobId: 'example-job' })),
  renderPage: vi.fn(async () => ({ jobId: 'example-job' })),
  refineRender: vi.fn(async () => ({ jobId: 'example-job' })),
  shotFrame: vi.fn(async () => ({ jobId: 'example-job' })),
  refinePanel: vi.fn(async () => ({ prompt: 'Example prompt' })),
  panelCandidates: vi.fn(async () => ({ candidates: [] })),
  refineScene: vi.fn(async () => ({ prompt: 'Example prompt' })),
  sceneCandidates: vi.fn(async () => ({ candidates: [] })),
  updateSeries: vi.fn(async (id, patch) => ({ id, name: 'Example Series', ...patch })),
  updateIssue: vi.fn(async (id, patch) => ({ id, ...patch })),
  cancelAutoRun: vi.fn(() => true),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/pipeline/seriesTitleLogo.js', () => ({ generateSeriesTitleLogo: effects.titleLogo }));
vi.mock('../services/pipeline/textStages.js', () => ({ generateStage: effects.generateStage }));
vi.mock('../services/pipeline/autoRunner.js', () => ({
  startAutoRunTextStages: effects.autoRun,
  cancelAutoRun: effects.cancelAutoRun,
  attachClient: vi.fn(() => false),
}));
vi.mock('../services/pipeline/visualStages.js', () => ({
  enqueueVisualImage: effects.enqueueVisual,
  renderComicPage: effects.renderPage,
  refineComicPageRender: effects.refineRender,
  enqueueStoryboardShotStartFrame: effects.shotFrame,
  enqueueStoryboardSceneVideo: vi.fn(),
  refineComicPanelPrompt: effects.refinePanel,
  generateComicPanelImagePrompts: effects.panelCandidates,
  refineStoryboardScenePrompt: effects.refineScene,
  generateStoryboardSceneImagePrompts: effects.sceneCandidates,
}));
vi.mock('../services/pipeline/series.js', async (importOriginal) => ({
  ...await importOriginal(),
  updateSeries: effects.updateSeries,
}));
vi.mock('../services/pipeline/issues.js', async (importOriginal) => ({
  ...await importOriginal(),
  updateIssue: effects.updateIssue,
  getIssue: vi.fn(async (id) => ({
    id,
    stages: { comicPages: { pages: [{ panels: [{}] }] }, storyboards: { scenes: [{ shots: [{}] }] } },
  })),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession, revokeSessionById } from '../services/auth.js';
import seriesRoutes from './pipeline/series.js';
import issueRoutes from './pipeline/issues.js';

let ownerSession;
const id = '00000000-0000-4000-8000-000000000001';
const picker = { providerId: 'example-cli', model: 'example-model' };
const issue = `/api/pipeline/issues/${id}`;
const imageBody = { description: 'Example scene', width: 512, height: 512 };
// [path, body, effect observed on success]
const operations = [
  [`/api/pipeline/series/${id}/generate-title-logo`, picker, effects.titleLogo],
  [`${issue}/stages/prose/generate`, { seedInput: 'Example seed', ...picker }, effects.generateStage],
  [`${issue}/auto-run-text`, picker, effects.autoRun],
  [`${issue}/stages/comicPages/pages/0/panels/0/refine-prompt`, picker, effects.refinePanel],
  [`${issue}/stages/comicPages/pages/0/panels/0/image-prompts`, { count: 2, ...picker }, effects.panelCandidates],
  [`${issue}/stages/storyboards/scenes/0/refine-prompt`, picker, effects.refineScene],
  [`${issue}/stages/storyboards/scenes/0/image-prompts`, { count: 2, ...picker }, effects.sceneCandidates],
  [`${issue}/stages/comicPages/visual`, imageBody, effects.enqueueVisual],
  [`${issue}/stages/comicPages/pages/0/render`, { width: 512, height: 512 }, effects.renderPage],
  [`${issue}/stages/comicPages/pages/0/refine-render`,
    { instruction: 'Example correction', width: 512, height: 512, ...picker }, effects.refineRender],
  [`${issue}/stages/storyboards/scenes/0/shots/0/render`, { width: 512, height: 512 }, effects.shotFrame],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/pipeline', seriesRoutes);
  app.use('/api/pipeline', issueRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [path, body], headers = {}, method = 'post') => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
};

beforeEach(async () => {
  vi.clearAllMocks();
  auth.enabled = false;
  ownerSession = await createSession();
});

describe('Pipeline agent-backed generation authority (#10068)', () => {
  it('refuses remote and proxy-marked password-free callers before any effect', async () => {
    for (const operation of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        const response = await call(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('keeps anonymous callers on 401 and refuses legacy Basic when a password is set', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('fails closed for invalid, expired, revoked and scoped-peer credentials', async () => {
    auth.enabled = true;
    const expired = await createSession({ label: 'agent' });
    const revoked = await createSession({ label: 'agent' });
    await revokeSessionById(revoked.id);
    // Advance the verifier's clock without timers or production sleeps.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SESSION_TTL_MS + 1);
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{ Authorization: 'Bearer invalid-session' }, 401, 'AUTH_REQUIRED'],
        [{ Authorization: `Bearer ${expired.token}` }, 401, 'AUTH_REQUIRED'],
        [{ Cookie: `portos_auth=${revoked.token}` }, 401, 'AUTH_REQUIRED'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    clock.mockRestore();
    expectNoEffects();
  });

  it('matches case and trailing-slash variants before any effect', async () => {
    for (const operation of operations) {
      const response = await call(appFor(), [operation[0].toUpperCase() + '/', operation[1]]);
      expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('retains local, human-session and agent-session workflows with provider choices intact', async () => {
    const agentSession = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '::ffff:127.0.0.1' }],
      [true, '192.0.2.10', { Authorization: `Bearer ${ownerSession.token}` }],
      [true, '192.0.2.10', { Cookie: `portos_auth=${ownerSession.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agentSession.token}` }],
      [true, '192.0.2.10', { Cookie: `portos_auth=${agentSession.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(200);
      }
    }
    for (const [path, body, effect] of operations) {
      expect(effect, path).toHaveBeenCalledTimes(6);
      if (body.providerId) {
        const options = effect.mock.lastCall.find((value) => value && typeof value === 'object' && value.providerId);
        expect(options, path).toEqual(expect.objectContaining(picker));
      }
    }
  });

  it('keeps record CRUD, reads and cancellation open to remote callers', async () => {
    const app = appFor();
    const patchSeries = await call(app, [`/api/pipeline/series/${id}`, { styleNotes: 'Example notes' }], {}, 'patch');
    expect(patchSeries.status).toBe(200);
    expect(effects.updateSeries).toHaveBeenCalledTimes(1);
    const patchIssue = await call(app, [`${issue}`, { title: 'Example issue' }], {}, 'patch');
    expect(patchIssue.status).toBe(200);
    expect(effects.updateIssue).toHaveBeenCalledTimes(1);
    expect((await call(app, [`${issue}/auto-run-text/cancel`, {}])).status).toBe(200);
    expect(effects.cancelAutoRun).toHaveBeenCalledTimes(1);
    for (const effect of [
      effects.titleLogo, effects.generateStage, effects.autoRun, effects.enqueueVisual, effects.renderPage,
      effects.refineRender, effects.shotFrame, effects.refinePanel, effects.panelCandidates,
      effects.refineScene, effects.sceneCandidates,
    ]) expect(effect).not.toHaveBeenCalled();
  });
});
