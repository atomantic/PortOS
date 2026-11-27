/**
 * Each of the eight services that call `callProviderAISimple`, driven once at
 * its own service boundary with the real adapter, shared runner and run store;
 * only the HTTP transport and each caller's external inputs (Jira, settings,
 * peers) are stubbed (#16560). `lib/creativeLatitude.sources.test.js` covers
 * every call site's `source` tag, including the ones not driven here.
 *
 * The regression this catches: a caller whose model call leaves no run record,
 * opens no usage session, or opens two of either for one request.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { mockJsonResponse } from '../lib/testHelper.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-caller-runs-' });
const defaultProvider = {
  id: 'example-api', name: 'Example API', type: 'api', enabled: true,
  endpoint: 'https://api.example.com/v1', defaultModel: 'example-model', models: ['example-model'],
};
const shared = vi.hoisted(() => ({
  provider: {
    id: 'example-api', name: 'Example API', type: 'api', enabled: true,
    endpoint: 'https://api.example.com/v1', defaultModel: 'example-model', models: ['example-model'],
  },
  // Extra providers the Jira summary may fall through to.
  moreProviders: [],
  recordSession: vi.fn(async () => {}),
  recordRunUsage: vi.fn(async () => {}),
}));
const findProvider = (id) => [shared.provider, ...shared.moreProviders].find(p => p.id === id) || shared.provider;

vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
vi.mock('./aiStatusEvents.js', () => ({ startAIOp: () => ({ update: () => {}, complete: () => {}, error: () => {} }) }));
vi.mock('./provider/providerExecutionReadiness.js', () => ({
  ensureManagedRuntimeReady: async () => ({ success: true }),
  ensureProviderReadyForExecution: async () => ({ success: true }),
}));
vi.mock('./usage.js', async (importOriginal) => ({
  ...await importOriginal(),
  recordSession: shared.recordSession,
  recordRunUsage: shared.recordRunUsage,
}));
vi.mock('./provider/providers.js', async (importOriginal) => ({
  ...await importOriginal(),
  getProviderById: async (id) => findProvider(id),
  getActiveProvider: async () => shared.provider,
  getAllProviders: async () => ({ activeProvider: shared.provider.id, providers: [shared.provider, ...shared.moreProviders] }),
  listProviders: async () => [shared.provider, ...shared.moreProviders],
}));
vi.mock('./settings.js', async (importOriginal) => ({
  ...await importOriginal(),
  getSettings: async () => ({ timezone: 'UTC' }),
}));
vi.mock('./notifications.js', async (importOriginal) => ({ ...await importOriginal(), addNotification: async () => {} }));
vi.mock('./mortalLoomStore.js', () => ({
  isMortalLoomEnabled: async () => false,
  mlArrayIfEnabled: async () => null,
}));
vi.mock('./digital-twin-meta.js', async (importOriginal) => ({ ...await importOriginal(), digitalTwinEvents: { emit: () => {} } }));
vi.mock('./jira.js', () => ({
  getInstances: async () => ({ instances: { 'example-instance': { baseUrl: 'https://jira.example.com' } } }),
  resolveCustomFieldIds: () => ({ storyPoints: 'customfield_10000' }),
  createJiraClient: () => ({
    search: async () => ({ data: { issues: [{
      key: 'EX-1',
      fields: { summary: 'Example ticket', status: { name: 'In Progress', statusCategory: { name: 'In Progress' } }, priority: { name: 'Medium' } },
    }] } }),
  }),
}));
vi.mock('./apps.js', () => ({ getActiveApps: async () => [] }));
vi.mock('./modelComparison.js', () => ({ recordPortosModelBenchmark: async () => {} }));
vi.mock('../lib/cliProviderRun.js', () => ({ runCliProviderPrompt: vi.fn() }));
vi.mock('./lmStudioManager.js', () => ({ getBaseUrl: vi.fn() }));
vi.mock('./ollamaManager.js', () => ({ getBaseUrl: vi.fn(), getModelCapabilities: vi.fn() }));

const { createRunnerService } = await import('../lib/aiToolkit/runner.js');
const { analyzeError } = await import('../lib/aiToolkit/errorDetection.js');
const { PATHS } = await import('../lib/fileUtils.js');

const runsDir = join(tempRoot, 'runs');
const hooks = {
  // The session `services/bootstrap.js` records when a run is created.
  onRunCreated: vi.fn((metadata) => shared.recordSession(metadata.providerId, metadata.providerName, metadata.model)),
  onRunStarted: vi.fn(),
  onRunCompleted: vi.fn(),
  onRunFailed: vi.fn(),
  onRunCanceled: vi.fn(),
};

const reply = (content) => mockJsonResponse({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
});
const records = async () => Promise.all((await readdir(runsDir).catch(() => [])).map(async (id) => (
  JSON.parse(await readFile(join(runsDir, id, 'metadata.json'), 'utf8'))
)));

/**
 * The contract every caller has to meet: `calls` model requests leave exactly
 * `calls` run records tagged `source`, `calls` usage sessions and `calls`
 * completion (usage-ledger) hooks, each carrying the provider's own counts.
 */
async function expectTrackedRuns({ source, calls = 1 }) {
  expect(globalThis.fetch).toHaveBeenCalledTimes(calls);
  const runs = await records();
  expect(runs).toHaveLength(calls);
  for (const run of runs) {
    expect(run).toMatchObject({
      source, providerId: 'example-api', success: true, exitCode: 0, executionKind: 'api',
      reportedUsage: { tokensIn: 12, tokensOut: 4, source: 'measured' },
    });
  }
  expect(shared.recordSession).toHaveBeenCalledTimes(calls);
  expect(hooks.onRunCreated).toHaveBeenCalledTimes(calls);
  expect(hooks.onRunCompleted).toHaveBeenCalledTimes(calls);
  // Nothing bills the ledger beside the completion hook.
  expect(shared.recordRunUsage).not.toHaveBeenCalled();
  expect(hooks.onRunFailed).not.toHaveBeenCalled();
}

const seedJson = async (path, data) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(data));
};
const goal = (id) => ({
  id, title: `Example goal ${id}`, description: 'An example goal', status: 'active',
  targetDate: '2099-01-01', createdAt: '2026-01-01T00:00:00.000Z', progress: 40,
});

let runner;
beforeEach(async () => {
  shared.provider = { ...defaultProvider };
  shared.moreProviders = [];
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
  vi.clearAllMocks();
  vi.resetModules();
  runner = createRunnerService({
    dataDir: tempRoot, hooks,
    providerService: { getProviderById: async (id) => findProvider(id), getAllProviders: async () => ({ providers: [shared.provider, ...shared.moreProviders] }) },
  });
  // `resetModules` gives each test fresh service modules; the toolkit state
  // module is re-imported with them, so load it through the same registry.
  const state = await import('./runner.js');
  state.setAIToolkit({ services: { runner, errorDetection: { analyzeError } } }, { dataDir: tempRoot, hooks });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  (await import('../lib/aiToolkitState.js')).setAIToolkitInstance(null);
});
afterAll(cleanup);

describe('callers of callProviderAISimple leave one run and one usage session per request', () => {
  it('insightsService: taste-identity themes', async () => {
    const taste = await import('./taste-questionnaire.js');
    await taste.submitAnswer('food', 'food-core-1', 'An example answer about food.');
    vi.stubGlobal('fetch', vi.fn(async () => reply('An example food profile.')));
    await taste.generateSectionSummary('food');
    vi.stubGlobal('fetch', vi.fn(async () => reply('[{"title":"Example theme","narrative":"n","evidence":[],"strength":"strong"}]')));
    await rm(runsDir, { recursive: true, force: true });
    vi.clearAllMocks();
    const { generateThemeAnalysis } = await import('./insightsService.js');

    const result = await generateThemeAnalysis();

    expect(result.themes).toHaveLength(1);
    await expectTrackedRuns({ source: 'insights-taste-themes' });
  });

  it('goalCheckIn: one request per active goal, each its own run', async () => {
    await seedJson(join(PATHS.digitalTwin, 'goals.json'), { goals: [goal('g1'), goal('g2')] });
    vi.stubGlobal('fetch', vi.fn(async () => reply('{"assessment":"ok","recommendations":["keep going"]}')));
    const { runGoalCheckIn } = await import('./goalCheckIn.js');

    const result = await runGoalCheckIn({ background: true });

    expect(result.checked).toBe(2);
    await expectTrackedRuns({ source: 'goal-check-in', calls: 2 });
  });

  it('identity/goals: phase generation', async () => {
    await seedJson(join(PATHS.digitalTwin, 'goals.json'), { goals: [goal('g1')] });
    vi.stubGlobal('fetch', vi.fn(async () => reply('[{"title":"Example phase","description":"d","targetDate":"2098-01-01","order":0}]')));
    const { generateGoalPhases } = await import('./identity/goals.js');

    await generateGoalPhases('g1');

    await expectTrackedRuns({ source: 'goal-phases' });
  });

  it('taste-questionnaire: section summary', async () => {
    const taste = await import('./taste-questionnaire.js');
    await taste.submitAnswer('food', 'food-core-1', 'An example answer about food.');
    vi.stubGlobal('fetch', vi.fn(async () => reply('An example food profile.')));

    await taste.generateSectionSummary('food');

    await expectTrackedRuns({ source: 'taste-summary' });
    const { CREATIVE_LATITUDE_HEADING } = await import('../lib/creativeLatitude.js');
    const content = JSON.parse(globalThis.fetch.mock.calls[0][1].body).messages[0].content;
    expect(content.split(CREATIVE_LATITUDE_HEADING)).toHaveLength(2);
  });

  it('autobiography: story evaluation', async () => {
    await seedJson(join(PATHS.digitalTwin, 'autobiography', 'stories.json'), {
      version: 1, usedPrompts: [], stories: [{ id: 'story-1', promptText: 'An example question?', content: 'An example story.' }],
    });
    vi.stubGlobal('fetch', vi.fn(async () => reply('{}')));
    const { evaluateStory } = await import('./autobiography.js');

    await evaluateStory('story-1');

    await expectTrackedRuns({ source: 'autobiography-evaluate' });
  });

  it('jiraReports: narrative status summary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('**In Progress:**\n- Example work (EX-1)')));
    const { generateReport } = await import('./jiraReports.js');

    const report = await generateReport('example-app', {
      name: 'Example App', jira: { enabled: true, instanceId: 'example-instance', projectKey: 'EX' },
    });

    expect(report.statusSummary).toContain('Example work');
    await expectTrackedRuns({ source: 'jira-status-report' });
  });

  it('jiraReports: a summary stopped from Runs does not fall through to the next provider', async () => {
    shared.moreProviders = [{ ...shared.provider, id: 'example-api-2', name: 'Example API 2' }];
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
    })));
    const { generateReport } = await import('./jiraReports.js');

    const pending = generateReport('example-app', {
      name: 'Example App', jira: { enabled: true, instanceId: 'example-instance', projectKey: 'EX' },
    });
    // A directory exists before createRun has finished publishing it. This
    // case stops an actual in-flight request; early Stop is covered separately.
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    const [live] = await records();
    expect(await runner.stopRun(live.id)).toBe(true);
    const report = await pending;

    // One request, to the first provider only, and the plain list as the summary.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(await records()).toHaveLength(1);
    expect(report.statusSummary).toContain('EX-1');
  });

  it('jiraReports: skips disabled providers and falls back to plain summary', async () => {
    shared.provider = { ...defaultProvider, enabled: false };
    shared.moreProviders = [{ ...defaultProvider, id: 'disabled-api-2', name: 'Disabled API 2', enabled: false }];
    vi.stubGlobal('fetch', vi.fn(async () => reply('should not be called')));
    const { generateReport } = await import('./jiraReports.js');

    const report = await generateReport('example-app', {
      name: 'Example App', jira: { enabled: true, instanceId: 'example-instance', projectKey: 'EX' },
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(report.statusSummary).toContain('EX-1');
  });

  it('jiraReports: local active provider failure never falls over to external cloud API provider', async () => {
    shared.provider = {
      ...defaultProvider,
      id: 'local-api',
      name: 'Local API',
      endpoint: 'http://127.0.0.1:11434/v1',
    };
    shared.moreProviders = [{
      ...defaultProvider,
      id: 'cloud-api',
      name: 'Cloud API',
      endpoint: 'https://api.example.com/v1',
    }];
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const { generateReport } = await import('./jiraReports.js');

    const report = await generateReport('example-app', {
      name: 'Example App', jira: { enabled: true, instanceId: 'example-instance', projectKey: 'EX' },
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls[0][0]).toContain('127.0.0.1:11434');
    expect(report.statusSummary).toContain('EX-1');
  });

  it('codeReview: API provider reviewer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('NO FINDINGS')));
    const { runLocalCodeReview } = await import('./codeReview.js');

    const result = await runLocalCodeReview({ backend: 'provider:example-api', model: 'example-model', diff: 'diff --git a/example.js b/example.js' });

    expect(result).toMatchObject({ ok: true, findings: 'NO FINDINGS' });
    await expectTrackedRuns({ source: 'code-review' });
  });

  it('portosModelBenchmarks: one run per benchmark task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('175')));
    const { runPortosModelBenchmark } = await import('./portosModelBenchmarks.js');

    await runPortosModelBenchmark({ provider: shared.provider, model: 'example-model' });

    const calls = globalThis.fetch.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    await expectTrackedRuns({ source: 'model-benchmark', calls });
  });
});
