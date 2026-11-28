import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callRoute, expectRemoteRefusal, hostControlApp, REMOTE_ADDRESS } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-moltbook-authority-') }),
  sleep: vi.fn(async () => {}),
}));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// Keep the mounted routers, authorization, saved schedules/personalities and
// scheduler -> action-executor consumer real. Only external effects and provider
// generation are synthetic; each test cleans up the real scheduler timers.
const effects = vi.hoisted(() => ({
  createPost: vi.fn(async () => ({ id: 'example-post' })),
  createComment: vi.fn(async () => ({ id: 'example-comment' })),
  replyToComment: vi.fn(async () => ({ id: 'example-reply' })),
  upvote: vi.fn(async () => ({})), upvoteComment: vi.fn(async () => ({})),
  getFeed: vi.fn(async () => ({ posts: [{ id: 'example-post', title: 'Example title' }] })),
  getProfile: vi.fn(async () => ({ id: 'example-profile', is_claimed: true })),
  getComments: vi.fn(async () => ({ comments: [{ id: 'example-comment', author: 'Other Bot', content: 'Example comment' }] })),
  getPostsByAuthor: vi.fn(async () => [{ id: 'example-post', title: 'Example title', created_at: new Date().toISOString() }]),
  getAccountWithCredentials: vi.fn(), getAccountById: vi.fn(),
  createAccount: vi.fn(async data => ({ id: 'example-account', ...data })),
  updateAccountStatus: vi.fn(async () => ({ id: 'example-account', platform: 'moltbook' })),
  recordActivity: vi.fn(async () => {}), logActivity: vi.fn(async () => {}), getActivities: vi.fn(async () => []),
  schedule: vi.fn(), cancel: vi.fn(),
  generatePost: vi.fn(async () => ({ title: 'Generated title', content: 'Generated content' })),
}));
vi.mock('../integrations/moltbook/index.js', () => ({
  createMoltbookClient: () => effects,
  checkRateLimit: () => ({ allowed: true }), isAccountSuspended: () => false,
}));
vi.mock('../integrations/moltworld/index.js', () => ({ createMoltworldClient: vi.fn() }));
vi.mock('../services/platformAccounts.js', () => effects);
vi.mock('../services/agent/agentActivity.js', () => effects);
vi.mock('../services/eventScheduler.js', async (importOriginal) => {
  const actual = await importOriginal();
  effects.schedule.mockImplementation(actual.schedule);
  effects.cancel.mockImplementation(actual.cancel);
  return { ...actual, schedule: effects.schedule, cancel: effects.cancel };
});
vi.mock('../services/userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
vi.mock('../services/history.js', () => ({ logAction: vi.fn(async () => {}) }));
vi.mock('../services/agent/agentContentGenerator.js', () => ({
  generatePost: effects.generatePost,
  generateComment: vi.fn(async () => ({ content: 'Example reply' })),
  generateReply: vi.fn(async () => ({ content: 'Example reply' })),
  assertMoltbookCommentProvider: vi.fn(async () => {}),
}));
vi.mock('../services/agent/agentPersonalityGenerator.js', () => ({}));
vi.mock('../services/agent/agentDrafts.js', () => ({
  createDraft: vi.fn(async data => ({ id: 'example-draft', ...data })),
}));
// The AI Assignments facade reads unrelated catalogs after writing. Keep its
// real socialAgent writer while excluding other features and provider calls.
vi.mock('../services/provider/providers.js', () => ({ getSelectableProviders: async () => ({ providers: [] }) }));
vi.mock('../services/brainStorage.js', async (importOriginal) => ({ ...await importOriginal(), loadMeta: async () => null }));
vi.mock('../services/universeBuilder.js', () => ({ listUniverses: async () => [] }));
vi.mock('../services/storyBuilder.js', () => ({ listStorySessions: async () => [] }));
vi.mock('../services/pipeline/series.js', () => ({ listSeries: async () => [] }));
vi.mock('../services/taskSchedule.js', () => ({ getScheduleStatus: async () => null }));
vi.mock('../services/loops.js', () => ({ getLoops: async () => [] }));
vi.mock('../services/featureAgents.js', () => ({ getAllFeatureAgents: async () => [] }));
vi.mock('../services/autonomousJobs.js', () => ({ getAllJobs: async () => [] }));
vi.mock('../services/voice/config.js', () => ({ getVoiceConfig: async () => ({}) }));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  CODEX_PARALLEL_MIN: 1, CODEX_PARALLEL_MAX: 8, CODEX_PARALLEL_DEFAULT: 2,
}));

import { PATHS } from '../lib/fileUtils.js';
import { createSession } from '../services/auth.js';
import { logAction } from '../services/history.js';
import * as personalities from '../services/agent/agentPersonalities.js';
import * as scheduler from '../services/automationScheduler.js';
import { cancelAll } from '../services/eventScheduler.js';
import { init as initExecutor } from '../services/agent/agentActionExecutor.js';
import toolsRoutes from './agentTools.js';
import scheduleRoutes from './automationSchedules.js';
import personalityRoutes from './agentPersonalities.js';
import accountRoutes from './platformAccounts.js';
import settingsRoutes from './settings.js';

const ids = { agentId: 'example-agent', accountId: 'example-account' };
const scheduleBody = {
  ...ids, action: { type: 'post', params: { title: 'Example title', content: 'Example content' } },
  schedule: { type: 'interval', intervalMs: 60000 }, enabled: true,
};
const operations = [
  ['post', '/tools/publish-post', { ...ids, submolt: 'general', title: 'Example title', content: 'Example content' }],
  ['post', '/tools/publish-comment', { ...ids, postId: 'example-post', content: 'Example content' }],
  ['post', '/tools/publish-comment', { ...ids, postId: 'example-post', parentId: 'example-comment', content: 'Example reply' }],
  ['post', '/tools/engage', { ...ids, maxComments: 0, maxVotes: 1 }],
  ['post', '/tools/check-posts', { ...ids, maxReplies: 1, maxUpvotes: 1 }],
  ['post', '/schedules', scheduleBody],
  ['put', '/schedules/example-schedule', { action: scheduleBody.action }],
  ['post', '/schedules/example-schedule/run', {}],
  ['post', '/schedules/example-schedule/toggle', { enabled: true }],
  ['put', '/personalities/example-agent', { personality: { promptPrefix: 'Changed instructions' } }],
  ['post', '/personalities/example-agent/toggle', { enabled: true }],
  ['post', '/accounts', { ...ids, platform: 'moltbook', credentials: { apiKey: 'example-key', username: 'Example Bot' } }],
  ['post', '/accounts/example-account/claim', {}],
  ['post', '/accounts/example-account/test', {}],
];
const mounts = [
  ['/api/agents/tools', toolsRoutes],
  ['/api/agents/schedules', scheduleRoutes],
  ['/api/agents/personalities', personalityRoutes],
  ['/api/agents/accounts', accountRoutes],
  ['/api/settings', settingsRoutes],
];
const appFor = (address = REMOTE_ADDRESS) => hostControlApp(address, mounts);
const call = async (app, [method, path, body], headers = {}) => callRoute(await app, [method, `/api/agents${path}`, body], headers);
const savedState = async () => Promise.all(['agents.json', 'schedules.json'].map(file =>
  readFile(join(PATHS.agentPersonalities, file), 'utf8')));
const expectNoEffects = () => {
  for (const fn of Object.values(effects).filter(vi.isMockFunction)) expect(fn).not.toHaveBeenCalled();
};
beforeEach(async () => {
  vi.clearAllMocks(); auth.enabled = false;
  const account = { id: ids.accountId, agentId: ids.agentId, platform: 'moltbook', status: 'active',
    credentials: { apiKey: 'example-key', username: 'Example Bot' } };
  effects.getAccountWithCredentials.mockResolvedValue(account);
  effects.getAccountById.mockResolvedValue({ ...account, status: 'pending' });
  await mkdir(PATHS.agentPersonalities, { recursive: true });
  await writeFile(join(PATHS.agentPersonalities, 'agents.json'), JSON.stringify({ agents: {
    [ids.agentId]: { name: 'Example Bot', enabled: true, personality: { style: 'casual' } },
    'other-agent': { name: 'Other Bot', enabled: true },
  } }));
  await writeFile(join(PATHS.agentPersonalities, 'schedules.json'), JSON.stringify({ schedules: {
    'example-schedule': scheduleBody,
  } }));
  personalities.invalidateCache(); scheduler.invalidateCache();
  initExecutor();
});

afterEach(() => { cancelAll(); });

describe('Schedule update ownership', () => {
  const path = '/schedules/example-schedule';
  const otherPair = { agentId: 'other-agent', accountId: 'other-account' };

  beforeEach(() => {
    effects.getAccountById.mockImplementation(async accountId => ({
      [ids.accountId]: { agentId: ids.agentId },
      [otherPair.accountId]: { agentId: otherPair.agentId },
    })[accountId] ?? null);
  });

  it.each([
    [{ agentId: 'missing-agent' }, 404, 'AGENT_NOT_FOUND'],
    [{ accountId: 'missing-account' }, 404, 'ACCOUNT_NOT_FOUND'],
    [{ accountId: otherPair.accountId }, 400, 'ACCOUNT_AGENT_MISMATCH'],
    [{ agentId: otherPair.agentId }, 400, 'ACCOUNT_AGENT_MISMATCH'],
  ])('refuses %j with %i %s before saving or auditing', async (updates, status, code) => {
    const before = await savedState();
    const response = await call(appFor('127.0.0.1'), ['put', path, updates]);
    expect([response.status, response.body.code]).toEqual([status, code]);
    expect(await savedState()).toEqual(before);
    expect(logAction).not.toHaveBeenCalled();
  });

  it('persists a reassignment when both new IDs form a valid pair', async () => {
    const response = await call(appFor('127.0.0.1'), ['put', path, otherPair]);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ...scheduleBody, ...otherPair });
    scheduler.invalidateCache();
    expect(await scheduler.getScheduleById('example-schedule')).toMatchObject(otherPair);
    expect(logAction).toHaveBeenCalledExactlyOnceWith('update', 'automation-schedule', 'example-schedule',
      { agentId: otherPair.agentId, action: 'post' });
  });

  it('lets the operator disable a legacy schedule without resolving its relationships', async () => {
    effects.getAccountById.mockResolvedValue(null);
    const response = await call(appFor('127.0.0.1'), ['put', path, { enabled: false }]);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ...ids, enabled: false });
    expect(effects.getAccountById).not.toHaveBeenCalled();
  });
});

// The refusal/principal matrix lives in services/authGate.test.js and
// server/test/guards/modules/hostControlCoverage.test.js; this keeps one refusal and the authorized
// workflows through the real scheduler -> action-executor consumer.
describe('Moltbook publication behind the default-deny gate (#16114)', () => {
  it('refuses a remote caller before credentials or persisted steering', async () => {
    const before = await savedState();
    const [method, path, body] = operations[0];
    await expectRemoteRefusal(mounts, [method, `/api/agents${path}`, body, effects.createPost]);
    const schedule = operations.find(([, p]) => p === '/schedules');
    await expectRemoteRefusal(mounts, [schedule[0], `/api/agents${schedule[1]}`, schedule[2], effects.schedule]);
    expect(await savedState()).toEqual(before);
    expectNoEffects();
  });

  it('preserves local and delegated-agent publication and saved execution', async () => {
    const agent = await createSession({ label: 'agent' });
    let completedRuns = 0;
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, operation[1]).toBe(operation[1] === '/schedules' || operation[1] === '/accounts' ? 201 : 200);
        if (operation[1] === '/schedules/example-schedule/run') {
          completedRuns++;
          expect(effects.logActivity.mock.calls.filter(([entry]) =>
            entry.scheduleId === 'example-schedule' && entry.status === 'completed'
          )).toHaveLength(completedRuns);
        }
      }
    }
    expect(effects.createPost).toHaveBeenCalledTimes(4);
    expect(effects.createPost).toHaveBeenLastCalledWith('general', 'Example title', 'Example content');
    expect(effects.createComment).toHaveBeenCalledTimes(2);
    expect(effects.replyToComment).toHaveBeenCalledTimes(4);
    expect(effects.upvote).toHaveBeenCalledTimes(2);
    expect(effects.upvoteComment).toHaveBeenCalledTimes(2);
    expect(effects.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: 'example-schedule', action: 'post', status: 'completed',
    }));
    scheduler.invalidateCache(); personalities.invalidateCache();
    expect((await scheduler.getScheduleById('example-schedule')).runCount).toBe(2);
    expect((await personalities.getAgentById(ids.agentId)).personality.promptPrefix).toBe('Changed instructions');
  });

  it('runs private drafts, disabling and deletion for host control without publication', async () => {
    const app = appFor('127.0.0.1');
    const draft = ['post', '/tools/drafts', { agentId: ids.agentId, type: 'post', content: 'Private draft' }];
    expect((await call(app, draft)).status).toBe(201);
    for (const path of ['/schedules/example-schedule', '/personalities/example-agent']) {
      expect((await call(app, ['post', path + '/toggle', { enabled: false }])).status).toBe(200);
    }
    // The real persisted consumer also respects the disabled schedule.
    await scheduler.runNow('example-schedule');
    for (const path of ['/schedules/example-schedule', '/personalities/example-agent']) {
      expect((await call(app, ['delete', path, {}])).status).toBe(200);
    }
    const [agentsFile, schedulesFile] = await savedState();
    expect(Object.keys(JSON.parse(agentsFile).agents)).toEqual(['other-agent']);
    expect(JSON.parse(schedulesFile).schedules).toEqual({});

    for (const fn of [effects.createPost, effects.createComment, effects.replyToComment, effects.upvote, effects.upvoteComment]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('persists decoded AI Assignments aliases and drives scheduled generation for local and agent callers', async () => {
    const payload = { providerId: 'example-provider', model: 'example-model' };
    const delegated = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '127.0.0.1', { Authorization: `Bearer ${delegated.token}` }],
    ]) {
      auth.enabled = enabled;
      const response = await callRoute(await appFor(address),
        ['put', '/api/settings/ai-assignments/socialAgent%2Eexample-agent%2Econtent', payload], headers);
      expect(response.status).toBe(200);
    }
    personalities.invalidateCache();
    expect((await personalities.getAgentById(ids.agentId)).aiConfig.content).toEqual(payload);
    await scheduler.updateSchedule('example-schedule', { action: { type: 'post', params: {} } });
    scheduler.invalidateCache();
    await scheduler.runNow('example-schedule');
    expect(effects.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: 'example-schedule', action: 'post', status: 'completed',
    }));
    expect(effects.generatePost).toHaveBeenCalledWith(expect.objectContaining({ id: ids.agentId }),
      { submolt: 'general' }, payload.providerId, payload.model);
    expect(effects.createPost).toHaveBeenCalledWith('general', 'Generated title', 'Generated content');
  });
});
