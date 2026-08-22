/**
 * The per-app provider/model pin reaching the SPAWN, for every task type (#4783).
 *
 * `taskTypeOverrides[<taskType>].providerId` / `.model` used to reach the agent
 * only for `layered-intelligence`, because only its `buildTaskInput` hook read
 * the field and `applyProviderModelPins` applied the hook's return last. Every
 * other type merged `taskMetadata` off the same record and then took its provider
 * from the global Schedule pin, so a pin set on the Automation tab silently never
 * ran. These tests assert the generated task's metadata, not the plumbing.
 *
 * Isolated file so the mocked leaf graph (taskSchedule / taskPromptService /
 * providers) can't leak into the shared cosTaskGenerator suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./taskPromptService.js', () => ({
  getTaskPrompt: vi.fn(async () => 'Improve {appName} at {repoPath}'),
  getStagePrompt: vi.fn(async () => 'Improve {appName} at {repoPath}'),
}));

const getTaskIntervalMock = vi.fn(async () => ({ type: 'weekly', taskMetadata: {} }));
vi.mock('./taskSchedule.js', () => ({
  INTERVAL_TYPES: { PERPETUAL: 'perpetual', WEEKLY: 'weekly' },
  getTaskInterval: vi.fn((...args) => getTaskIntervalMock(...args)),
  stripManagedAgentOptionsFromOverride: vi.fn((_type, meta) => meta),
  recordExecution: vi.fn(async () => {}),
  parkPerpetual: vi.fn(async () => {}),
  getPerpetualDrainState: vi.fn(async () => ({ signature: null, dispatchCount: 0 })),
  recordPerpetualDispatch: vi.fn(async () => 1),
}));

vi.mock('./appActivity.js', async (importActual) => ({
  ...(await importActual()),
  updateAppActivity: vi.fn(async () => {}),
}));

const getAppTaskTypeOverridesMock = vi.fn(async () => ({}));
vi.mock('./apps.js', async (importActual) => ({
  ...(await importActual()),
  getAppTaskTypeOverrides: vi.fn((...args) => getAppTaskTypeOverridesMock(...args)),
}));

// The harness boundary the pin has to answer to: `api` providers return text with
// no file-writing tools, so an agent task can never run on one.
const PROVIDER_TYPES = { 'claude-cli': 'cli', 'opencode-tui': 'tui', ollama: 'api' };
vi.mock('./providers.js', async (importActual) => ({
  ...(await importActual()),
  getProviderById: vi.fn(async (id) => (PROVIDER_TYPES[id] ? { id, type: PROVIDER_TYPES[id] } : null)),
}));

vi.mock('./taskLearning.js', async (importActual) => ({
  ...(await importActual()),
  getTaskTypeConfidence: vi.fn(async () => ({ autoApprove: true, tier: 'high', reason: 'test' })),
}));

vi.mock('../lib/gitRemote.js', async (importActual) => ({
  ...(await importActual()),
  readOriginRemoteUrl: vi.fn(async () => null),
}));

import { generateManagedAppImprovementTaskForType } from './cosTaskGenerator.js';

const APP = { id: 'app-1', name: 'Example App', repoPath: '/tmp/example-repo' };
const STATE = { config: { confidenceAutoApproval: { enabled: false }, idleReviewPriority: 'MEDIUM' } };

// `ux` has no buildTaskInput hook — exactly the class of task type the pin used to
// be inert for.
const generate = (taskType = 'ux') =>
  generateManagedAppImprovementTaskForType(taskType, APP, STATE, { skipPreconditions: true });

describe('per-app provider/model pin on a task type with no buildTaskInput hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTaskIntervalMock.mockResolvedValue({ type: 'weekly', taskMetadata: {} });
    getAppTaskTypeOverridesMock.mockResolvedValue({});
  });

  it('spawns on the app pin, not the global Schedule pin', async () => {
    getTaskIntervalMock.mockResolvedValue({ type: 'weekly', taskMetadata: {}, providerId: 'opencode-tui', model: 'qwen' });
    getAppTaskTypeOverridesMock.mockResolvedValue({ ux: { enabled: true, providerId: 'claude-cli', model: 'opus' } });

    const task = await generate();
    expect(task.metadata.provider).toBe('claude-cli');
    expect(task.metadata.providerId).toBe('claude-cli');
    expect(task.metadata.model).toBe('opus');
  });

  it('still takes the Schedule pin when the app pins nothing', async () => {
    getTaskIntervalMock.mockResolvedValue({ type: 'weekly', taskMetadata: {}, providerId: 'opencode-tui', model: 'qwen' });

    const task = await generate();
    expect(task.metadata.provider).toBe('opencode-tui');
    expect(task.metadata.model).toBe('qwen');
  });

  it('does not wedge on an api-typed app pin — it falls back to the Schedule pin', async () => {
    getTaskIntervalMock.mockResolvedValue({ type: 'weekly', taskMetadata: {}, providerId: 'claude-cli', model: 'opus' });
    getAppTaskTypeOverridesMock.mockResolvedValue({ ux: { enabled: true, providerId: 'ollama', model: 'llama-3' } });

    const task = await generate();
    expect(task.metadata.provider).toBe('claude-cli');
    expect(task.metadata.model).toBe('opus');
  });

  it('leaves an api-only Schedule pin alone when the app pins an api provider too', async () => {
    // Nothing reachable has a harness. Rerouting to some other provider the user
    // never chose would be worse than letting agentProviderResolution report its
    // permanent, actionable error — so the Schedule pin stands.
    getTaskIntervalMock.mockResolvedValue({ type: 'weekly', taskMetadata: {}, providerId: 'ollama' });
    getAppTaskTypeOverridesMock.mockResolvedValue({ ux: { enabled: true, providerId: 'ollama' } });

    const task = await generate();
    expect(task.metadata.provider).toBe('ollama');
  });

  // A model is provider-scoped. Overriding only the PROVIDER must not leave the
  // Schedule pin's model behind: agentProviderResolution honors an explicit
  // metadata.model as a CLI pass-through, so the leak ships the wrong CLI a model
  // it cannot run and fails on every retry until the task blocks.
  it('drops the Schedule pin model when the app pins a different provider', async () => {
    getTaskIntervalMock.mockResolvedValue({ type: 'weekly', taskMetadata: {}, providerId: 'opencode-tui', model: 'qwen-a' });
    getAppTaskTypeOverridesMock.mockResolvedValue({ ux: { enabled: true, providerId: 'claude-cli' } });

    const task = await generate();
    expect(task.metadata.provider).toBe('claude-cli');
    expect(task.metadata.model).toBeUndefined();
  });

  it('honors an app model pinned without an app provider', async () => {
    getTaskIntervalMock.mockResolvedValue({ type: 'weekly', taskMetadata: {}, providerId: 'claude-cli', model: 'opus' });
    getAppTaskTypeOverridesMock.mockResolvedValue({ ux: { enabled: true, model: 'sonnet' } });

    const task = await generate();
    expect(task.metadata.provider).toBe('claude-cli');
    expect(task.metadata.model).toBe('sonnet');
  });
});
