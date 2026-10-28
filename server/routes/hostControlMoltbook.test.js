import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

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
  getFeed: vi.fn(async () => ({ posts: [] })),
  getProfile: vi.fn(async () => ({ id: 'example-profile', is_claimed: true })),
  getComments: vi.fn(async () => ({ comments: [{ id: 'example-comment', author: 'Other Bot', content: 'Example comment' }] })),
  getPostsByAuthor: vi.fn(async () => [{ id: 'example-post', title: 'Example title', created_at: new Date().toISOString() }]),
  getAccountWithCredentials: vi.fn(), getAccountById: vi.fn(),
  createAccount: vi.fn(async data => ({ id: 'example-account', ...data })),
  updateAccountStatus: vi.fn(async () => ({ id: 'example-account', platform: 'moltbook' })),
  recordActivity: vi.fn(async () => {}), logActivity: vi.fn(async () => {}),
  schedule: vi.fn(), cancel: vi.fn(),
  generatePost: vi.fn(async () => ({ title: 'Generated title', content: 'Generated content' })),
}));
vi.mock('../integrations/moltbook/index.js', () => ({
  createMoltbookClient: () => effects,
  checkRateLimit: () => ({ allowed: true }), isAccountSuspended: () => false,
}));
vi.mock('../integrations/moltworld/index.js', () => ({ createMoltworldClient: vi.fn() }));
vi.mock('../services/platformAccounts.js', () => effects);
vi.mock('../services/agentActivity.js', () => effects);
vi.mock('../services/eventScheduler.js', async (importOriginal) => {
  const actual = await importOriginal();
  effects.schedule.mockImplementation(actual.schedule);
  effects.cancel.mockImplementation(actual.cancel);
  return { ...actual, schedule: effects.schedule, cancel: effects.cancel };
});
vi.mock('../services/userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
vi.mock('../services/history.js', () => ({ logAction: vi.fn(async () => {}) }));
vi.mock('../services/agentContentGenerator.js', () => ({
  generatePost: effects.generatePost,
  generateComment: vi.fn(async () => ({ content: 'Example reply' })),
  generateReply: vi.fn(async () => ({ content: 'Example reply' })),
  assertMoltbookCommentProvider: vi.fn(async () => {}),
}));
vi.mock('../services/agentPersonalityGenerator.js', () => ({}));
vi.mock('../services/agentFeedFilter.js', () => ({
  findRelevantPosts: vi.fn(async () => [{ id: 'example-post', title: 'Example title' }]),
  findReplyOpportunities: vi.fn(async () => []),
}));
vi.mock('../services/agentPublished.js', () => ({}));
vi.mock('../services/agentDrafts.js', () => ({
  createDraft: vi.fn(async data => ({ id: 'example-draft', ...data })),
}));
// The AI Assignments facade reads unrelated catalogs after writing. Keep its
// real socialAgent writer while excluding other features and provider calls.
vi.mock('../services/providers.js', () => ({ getSelectableProviders: async () => ({ providers: [] }) }));
vi.mock('../services/brain.js', () => ({ loadMeta: async () => null }));
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
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import * as personalities from '../services/agentPersonalities.js';
import * as scheduler from '../services/automationScheduler.js';
import { cancelAll } from '../services/eventScheduler.js';
import { init as initExecutor } from '../services/agentActionExecutor.js';
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
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address }); next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/agents/tools', toolsRoutes);
  app.use('/api/agents/schedules', scheduleRoutes);
  app.use('/api/agents/personalities', personalityRoutes);
  app.use('/api/agents/accounts', accountRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](`/api/agents${path}`);
  for (const [key, value] of Object.entries(headers)) pending.set(key, value);
  return pending.send(body);
};
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
  } }));
  await writeFile(join(PATHS.agentPersonalities, 'schedules.json'), JSON.stringify({ schedules: {
    'example-schedule': scheduleBody,
  } }));
  personalities.invalidateCache(); scheduler.invalidateCache();
  initExecutor();
});

afterEach(() => { cancelAll(); });

describe('Moltbook publication authority', () => {
  it('refuses remote, proxied and alternate spellings before credentials or persisted steering', async () => {
    const before = await savedState();
    for (const operation of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ]) {
        const response = await call(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[1]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      const response = await call(appFor(), [operation[0], operation[1].toUpperCase() + '/', operation[2]]);
      expect([response.status, response.body.code], operation[1]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expect(await savedState()).toEqual(before);
    expectNoEffects();
  });

  it('refuses anonymous, Basic and scoped peer credentials when auth is enabled', async () => {
    auth.enabled = true;
    const before = await savedState();
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{ [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance' }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[1]).toEqual([status, code]);
      }
    }
    expect(await savedState()).toEqual(before);
    expectNoEffects();
  });

  it('preserves local, human-session and delegated-agent publication and saved execution', async () => {
    const owner = await createSession();
    const agent = await createSession({ label: 'agent' });
    let completedRuns = 0;
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${owner.token}` }],
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
    expect(effects.createPost).toHaveBeenCalledTimes(6);
    expect(effects.createPost).toHaveBeenLastCalledWith('general', 'Example title', 'Example content');
    expect(effects.createComment).toHaveBeenCalledTimes(3);
    expect(effects.replyToComment).toHaveBeenCalledTimes(6);
    expect(effects.upvote).toHaveBeenCalledTimes(3);
    expect(effects.upvoteComment).toHaveBeenCalledTimes(3);
    expect(effects.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: 'example-schedule', action: 'post', status: 'completed',
    }));
    scheduler.invalidateCache(); personalities.invalidateCache();
    expect((await scheduler.getScheduleById('example-schedule')).runCount).toBe(3);
    expect((await personalities.getAgentById(ids.agentId)).personality.promptPrefix).toBe('Changed instructions');
  });

  it('keeps remote reads, private drafts, disabling and deletion available without publication', async () => {
    const app = appFor();
    expect((await request(app).get('/api/agents/tools/feed?accountId=example-account')).status).toBe(200);
    expect((await request(app).get('/api/agents/schedules')).status).toBe(200);
    expect((await call(app, ['post', '/tools/drafts', { agentId: ids.agentId, type: 'post', content: 'Private draft' }])).status).toBe(201);
    for (const path of ['/schedules/example-schedule', '/personalities/example-agent']) {
      expect((await call(app, ['post', path + '/toggle', { enabled: false }])).status).toBe(200);
    }
    // The real persisted consumer also respects the disabled schedule.
    await scheduler.runNow('example-schedule');
    for (const path of ['/schedules/example-schedule', '/personalities/example-agent']) {
      expect((await call(app, ['delete', path, {}])).status).toBe(200);
    }
    for (const fn of [effects.createPost, effects.createComment, effects.replyToComment, effects.upvote, effects.upvoteComment]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('blocks shared Moltworld schedule arming before the platform consumer', async () => {
    const before = await savedState();
    const response = await call(appFor(), ['post', '/schedules', {
      ...scheduleBody, action: { type: 'mw_say', params: { message: 'Example message' } },
    }]);
    expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(await savedState()).toEqual(before);
    expectNoEffects();
  });

  it('gates decoded AI Assignments aliases through persistence and scheduled generation', async () => {
    const payload = { providerId: 'example-provider', model: 'example-model' };
    const before = await savedState();
    for (const id of ['socialAgent.example-agent.default', 'socialAgent%2Eexample-agent%2Econtent']) {
      const denied = await request(appFor()).put(`/api/settings/ai-assignments/${id}`).send(payload);
      expect([denied.status, denied.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expect(await savedState()).toEqual(before);
    expectNoEffects();

    const owner = await createSession();
    const delegated = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${owner.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${delegated.token}` }],
    ]) {
      auth.enabled = enabled;
      const pending = request(appFor(address))
        .put('/api/settings/ai-assignments/socialAgent%2Eexample-agent%2Econtent');
      for (const [key, value] of Object.entries(headers)) pending.set(key, value);
      const response = await pending.send(payload);
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
