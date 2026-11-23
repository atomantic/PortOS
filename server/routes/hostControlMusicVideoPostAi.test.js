import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-post-ai-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());
// Music Video cover design/generation, promotion plans, and POST LLM drills
// (#10989). Real routers behind the real auth and host-control gates; the
// principal matrix lives in services/authGate.test.js (#16018, #16114). Cover
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
vi.mock('../services/meatspace/meatspacePostLlm.js', () => ({
  generateLlmDrill: vi.fn(async () => ({ type: 'word-association', questions: [{ prompt: 'example' }] })),
  scoreLlmDrill: vi.fn(async () => ({ score: 1 })),
}));
vi.mock('../services/meatspace/meatspacePostRhetoric.js', () => ({
  evaluateRhetoricAttempt: vi.fn(async () => ({ score: 1 })),
}));
vi.mock('../services/meatspace/meatspacePostDrillCache.js', () => ({
  getCacheStats: vi.fn(() => ({})),
  requestCacheFill: vi.fn(() => ['compound-chain']),
  getCachedDrill: vi.fn(() => null),
  triggerReplenish: vi.fn(),
}));
vi.mock('../services/meatspace/meatspacePostAdaptive.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveDrillConfig: vi.fn(async (_type, config) => ({ config: config ?? {}, adaptive: null, progression: null })),
}));

import musicVideoRoutes from './musicVideo.js';
import meatspaceRoutes from './meatspacePostRoutes.js';
import { __setCoverArtDepsForTests } from '../services/musicVideo/coverArt.js';
import { createProject } from '../services/musicVideo/projects.js';
import { planMusicVideoPromotion, promotionPlanSteps } from '../services/musicVideo/promotionPlan.js';
import { generateLlmDrill, scoreLlmDrill } from '../services/meatspace/meatspacePostLlm.js';
import { evaluateRhetoricAttempt } from '../services/meatspace/meatspacePostRhetoric.js';
import { requestCacheFill, triggerReplenish } from '../services/meatspace/meatspacePostDrillCache.js';
import * as postService from '../services/meatspace/meatspacePost.js';

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

const mounts = [['/api/music-video', musicVideoRoutes], ['/api/meatspace', meatspaceRoutes]];

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
  it('refuses a remote caller before any provider call', async () => {
    const [path, body, effect] = operations()[0];
    await expectRemoteRefusal(mounts, ['post', path, body, effect]);
    expectNoEffects();
  });

  it('keeps working for local callers and delegated agent sessions', async () => {
    await expectAuthorizedWorkflows({
      auth, mounts,
      workflows: operations().map(([path, body, effect, status]) => ['post', path, body, effect, status]),
    });
  });

  it('lets an authorized cover design reach the chosen CLI provider with the typed direction', async () => {
    const [path, body] = operations()[0];
    const response = await callRoute(await hostControlApp('127.0.0.1', mounts), ['post', path, body]);
    expect(response.status).toBe(200);
    expect(sink.runPromptThroughProvider).toHaveBeenCalledTimes(1);
    expect(sink.runPromptThroughProvider.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: cliProvider, source: 'music-video-cover-design', model: 'example-model',
    }));
    expect(sink.runPromptThroughProvider.mock.calls[0][0].prompt).toContain('Example direction');
  });

  it('lets an authorized cover image reach enqueueJob', async () => {
    const [path, body] = operations()[1];
    const response = await callRoute(await hostControlApp('127.0.0.1', mounts), ['post', path, body]);
    expect(response.status).toBe(200);
    expect(sink.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image', owner: `music-video-cover-art:${projectId}`,
    }));
  });

  it('generates a non-LLM drill for a local caller without a provider', async () => {
    const response = await callRoute(await hostControlApp('127.0.0.1', mounts),
      ['post', '/api/meatspace/post/drill', { type: 'doubling-chain' }]);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.questions?.length).toBeGreaterThan(0);
    expectNoEffects();
  });

  it('keeps promotion reads remote, and runs lettering saves for host control without AI', async () => {
    const coverArt = `/api/music-video/${projectId}/publish-kit/cover-art`;
    const local = await hostControlApp('127.0.0.1', mounts);
    const lettering = await callRoute(local, ['put', `${coverArt}/design`, { design: { layout: 'top-center' } }]);
    expect(lettering.status, JSON.stringify(lettering.body)).toBe(200);

    const plan = await callRoute(await hostControlApp('192.0.2.10', mounts), ['get', `/api/music-video/${projectId}/publish/promotion-plan`]);
    expect(plan.status).toBe(200);
    expect(promotionPlanSteps).toHaveBeenCalled();
    expectNoEffects();
  });
});
