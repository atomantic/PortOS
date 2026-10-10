import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-post-ai-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// Music Video cover design/generation, promotion plans, and POST LLM drills
// (#10989). Real routers behind the real auth and host-control gates. Cover
// design runs for real against a synthetic CLI provider so the prompt-runner
// sink can be asserted; cover generation's image queue is the same doubled
// enqueueJob. The other families double their AI service so no provider, run
// record or fill can start.
const auth = vi.hoisted(() => ({ enabled: false }));
const cliProvider = vi.hoisted(() => ({
  id: 'example-cli', name: 'Example CLI', type: 'cli', enabled: true, command: 'example-agent', args: [], defaultModel: 'example-model',
}));
const sink = vi.hoisted(() => ({
  runPromptThroughProvider: vi.fn(async () => ({ text: '{}', model: 'example-model', provider: { id: 'example-cli' } })),
  enqueueJob: vi.fn(async () => ({ jobId: 'job-example' })),
}));
const DRAFT = {
  imagePrompt: 'Example image prompt: a grainy profile in blue light',
  rationale: 'Example reason.',
  design: {
    layout: 'top-center', typeface: 'serif', weight: 'light', letterCase: 'lower',
    titleColor: '#f0e6d2', accentColor: '#3366ff', backdrop: 'none', tagStyle: 'plain',
  },
};

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(async (mutate) => mutate({})),
}));
vi.mock('../services/promptRunner.js', async (importOriginal) => ({
  ...await importOriginal(),
  runPromptThroughProvider: sink.runPromptThroughProvider,
}));
vi.mock('../services/mediaJobQueue/index.js', async (importOriginal) => ({
  ...await importOriginal(),
  enqueueJob: sink.enqueueJob,
}));
vi.mock('../services/musicVideo/promotionPlan.js', () => ({
  planMusicVideoPromotion: vi.fn(async () => ({ planKey: 'example-plan', steps: [] })),
  promotionPlanSteps: vi.fn(async () => ({ planKey: 'example-plan', steps: [] })),
}));
vi.mock('../services/meatspacePostLlm.js', () => ({
  generateLlmDrill: vi.fn(async () => ({ type: 'word-association', questions: [{ prompt: 'example' }] })),
  scoreLlmDrill: vi.fn(async () => ({ score: 1 })),
}));
vi.mock('../services/meatspacePostRhetoric.js', () => ({
  evaluateRhetoricAttempt: vi.fn(async () => ({ score: 1 })),
}));
vi.mock('../services/meatspacePostDrillCache.js', () => ({
  getCacheStats: vi.fn(() => ({})),
  requestCacheFill: vi.fn(() => ['compound-chain']),
  getCachedDrill: vi.fn(() => null),
  triggerReplenish: vi.fn(),
}));
vi.mock('../services/meatspacePostAdaptive.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveDrillConfig: vi.fn(async (_type, config) => ({ config: config ?? {}, adaptive: null, progression: null })),
}));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import musicVideoRoutes from './musicVideo.js';
import meatspaceRoutes from './meatspacePostRoutes.js';
import { __setCoverArtDepsForTests } from '../services/musicVideo/coverArt.js';
import { createProject } from '../services/musicVideo/projects.js';
import { planMusicVideoPromotion, promotionPlanSteps } from '../services/musicVideo/promotionPlan.js';
import { generateLlmDrill, scoreLlmDrill } from '../services/meatspacePostLlm.js';
import { evaluateRhetoricAttempt } from '../services/meatspacePostRhetoric.js';
import { requestCacheFill, triggerReplenish } from '../services/meatspacePostDrillCache.js';
import * as postService from '../services/meatspacePost.js';

let projectId;
const picker = { providerId: cliProvider.id, model: 'example-model' };
const operations = () => [
  [`/api/music-video/${projectId}/publish-kit/cover-art/design`, { direction: 'Example direction', ...picker }, sink.runPromptThroughProvider, 200],
  [`/api/music-video/${projectId}/publish-kit/cover-art/generate`, { notes: 'Example notes' }, sink.enqueueJob, 200],
  [`/api/music-video/${projectId}/publish/promotion-plan`, { goal: 'Example goal', audience: 'Example audience', ...picker }, planMusicVideoPromotion, 201],
  ['/api/meatspace/post/score-llm', {
    type: 'word-association', drillData: { prompt: 'Example' }, responses: [{ response: 'Example answer' }], timeLimitMs: 1000, ...picker,
  }, scoreLlmDrill, 200],
  ['/api/meatspace/post/rhetoric/evaluate', {
    attemptId: 'attempt-example', mode: 'meter', prompt: 'Example prompt', response: 'Example response', ...picker,
  }, evaluateRhetoricAttempt, 200],
  ['/api/meatspace/post/drill-cache/fill', { types: ['compound-chain'], ...picker }, requestCacheFill, 200],
  ['/api/meatspace/post/drill', { type: 'word-association', ...picker }, generateLlmDrill, 200],
];
const sinks = () => [...new Set([...operations().map(([, , service]) => service), triggerReplenish])];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/music-video', musicVideoRoutes);
  app.use('/api/meatspace', meatspaceRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const service of sinks()) expect(service).not.toHaveBeenCalled();
};

beforeAll(async () => {
  projectId = (await createProject({ name: 'Example Song' })).id;
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  sink.runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(DRAFT), model: 'example-model' });
  sink.enqueueJob.mockResolvedValue({ jobId: 'job-example' });
  vi.spyOn(postService, 'getPostConfig').mockResolvedValue({ rhetoricEvaluator: { enabled: true } });
  __setCoverArtDepsForTests({
    compose: vi.fn(async () => ({ width: 1, height: 1 })),
    enqueue: sink.enqueueJob,
    defaultRoute: async () => ({ mode: 'grok', model: null }),
    // A finished job is not in flight, so a later authorized generate can queue again.
    jobStatus: async () => 'completed',
    runner: async () => ({
      resolveProviderAndModel: async ({ providerId, model }) => ({
        provider: !providerId || providerId === cliProvider.id ? cliProvider : null,
        selectedModel: model || cliProvider.defaultModel,
      }),
      runPromptThroughProvider: sink.runPromptThroughProvider,
    }),
    getSettings: async () => ({}),
    getPlatforms: async () => ({ distrokid: { account: 'Example Artist' } }),
    imageParams: async (_settings, route, common) => ({ ...common, provider: route.mode }),
    withStyle: async (_project, params) => params,
    fonts: async () => [],
    registerFonts: async () => {},
    artistStyle: async () => null,
  });
});

describe('Music Video cover/promotion and POST LLM operator authority (#10989)', () => {
  it('refuses a remote password-free caller, including spoofed-proxy variants, before any provider call', async () => {
    for (const operation of operations()) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        const response = await post(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password, denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations()) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Bearer invalid-session' }, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await post(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('matches case and trailing-slash variants before any provider call', async () => {
    for (const operation of operations()) {
      const variant = [operation[0].toUpperCase() + '/', operation[1]];
      const response = await post(appFor(), variant);
      expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Cookie: `portos_auth=${agent.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations()) {
        const response = await post(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(operation[3]);
        expect(operation[2], operation[0]).toHaveBeenCalled();
      }
    }
  });

  it('lets an authorized cover design reach the chosen CLI provider and nobody else', async () => {
    const operation = operations()[0];
    expect((await post(appFor('192.0.2.10'), operation)).status).toBe(403);
    expect(sink.runPromptThroughProvider).not.toHaveBeenCalled();

    expect((await post(appFor('127.0.0.1'), operation)).status).toBe(200);
    expect(sink.runPromptThroughProvider).toHaveBeenCalledTimes(1);
    expect(sink.runPromptThroughProvider.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: cliProvider, source: 'music-video-cover-design', model: 'example-model',
    }));
    expect(sink.runPromptThroughProvider.mock.calls[0][0].prompt).toContain('Example direction');
  });

  it('lets an authorized cover image reach enqueueJob', async () => {
    const operation = operations()[1];
    expect((await post(appFor('192.0.2.10'), operation)).status).toBe(403);
    expect(sink.enqueueJob).not.toHaveBeenCalled();

    expect((await post(appFor('127.0.0.1'), operation)).status).toBe(200);
    expect(sink.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image', owner: `music-video-cover-art:${projectId}`,
    }));
  });

  it('keeps a non-LLM drill open to a remote caller', async () => {
    const response = await post(appFor(), ['/api/meatspace/post/drill', { type: 'doubling-chain' }]);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.questions?.length).toBeGreaterThan(0);
    expectNoEffects();
  });

  it('leaves cover compose, lettering saves and promotion reads open to a remote caller', async () => {
    const app = appFor();
    const compose = await request(app).post(`/api/music-video/${projectId}/publish-kit/cover-art`).send({});
    expect([compose.status, compose.body.code]).toEqual([422, 'VALIDATION_ERROR']);

    const lettering = await request(app).put(`/api/music-video/${projectId}/publish-kit/cover-art/design`).send({ design: { layout: 'top-center' } });
    expect(lettering.status, JSON.stringify(lettering.body)).toBe(200);

    const plan = await request(app).get(`/api/music-video/${projectId}/publish/promotion-plan`);
    expect(plan.status).toBe(200);
    expect(promotionPlanSteps).toHaveBeenCalled();
    expectNoEffects();
  });
});
