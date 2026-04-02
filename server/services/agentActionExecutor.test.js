import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockScheduleEvents, mockMoltbookClient, mockMoltworldClient } = vi.hoisted(() => {
  const { EventEmitter } = require('events');
  return {
    mockScheduleEvents: new EventEmitter(),
    mockMoltbookClient: {
      heartbeat: vi.fn(),
      createPost: vi.fn(),
      getPost: vi.fn(),
      getComments: vi.fn(),
      createComment: vi.fn(),
      replyToComment: vi.fn(),
      upvote: vi.fn(),
      downvote: vi.fn(),
      upvoteComment: vi.fn(),
      getFeed: vi.fn(),
      getPostsByAuthor: vi.fn()
    },
    mockMoltworldClient: {
      joinWorld: vi.fn(),
      build: vi.fn(),
      think: vi.fn()
    }
  };
});

vi.mock('./automationScheduler.js', () => ({
  scheduleEvents: mockScheduleEvents
}));

vi.mock('./agentActivity.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./platformAccounts.js', () => ({
  getAccountWithCredentials: vi.fn(),
  recordActivity: vi.fn().mockResolvedValue(undefined),
  updateAccountStatus: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./agentPersonalities.js', () => ({
  getAgentById: vi.fn()
}));

vi.mock('../integrations/moltbook/index.js', () => ({
  MoltbookClient: vi.fn(function () { return mockMoltbookClient; }),
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  isAccountSuspended: vi.fn(() => false)
}));

vi.mock('../integrations/moltworld/index.js', () => ({
  MoltworldClient: vi.fn(function () { return mockMoltworldClient; })
}));

vi.mock('./agentContentGenerator.js', () => ({
  generatePost: vi.fn().mockResolvedValue({ title: 'AI Title', content: 'AI Content' }),
  generateComment: vi.fn().mockResolvedValue({ content: 'AI Comment' }),
  generateReply: vi.fn().mockResolvedValue({ content: 'AI Reply' })
}));

vi.mock('./agentFeedFilter.js', () => ({
  findRelevantPosts: vi.fn().mockResolvedValue([]),
  findReplyOpportunities: vi.fn().mockResolvedValue([])
}));

import * as agentActivity from './agentActivity.js';
import * as platformAccounts from './platformAccounts.js';
import * as agentPersonalities from './agentPersonalities.js';
import { MoltbookClient, checkRateLimit, isAccountSuspended } from '../integrations/moltbook/index.js';
import { MoltworldClient } from '../integrations/moltworld/index.js';
import { generatePost, generateComment, generateReply } from './agentContentGenerator.js';
import { findRelevantPosts, findReplyOpportunities } from './agentFeedFilter.js';
import { init } from './agentActionExecutor.js';

const makeSchedule = (actionType, params = {}) => ({
  agentId: 'agent-1',
  accountId: 'acc-1',
  action: { type: actionType, params }
});

const makeAccount = (platform = 'moltbook') => ({
  id: 'acc-1',
  platform,
  status: 'active',
  credentials: { apiKey: 'test-key', username: 'testuser', agentId: 'mw-agent-1' }
});

const makeAgent = (overrides = {}) => ({
  id: 'agent-1',
  name: 'TestBot',
  enabled: true,
  aiConfig: { content: { providerId: 'p1', model: 'm1' }, engagement: { providerId: 'p1', model: 'm1' } },
  ...overrides
});

describe('agentActionExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScheduleEvents.removeAllListeners();
    init();
  });

  afterEach(() => {
    mockScheduleEvents.removeAllListeners();
  });

  // ===========================================================================
  // init() event handler — account/agent validation
  // ===========================================================================
  describe('init — execute event handler', () => {
    it('should log failure when account not found', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(null);

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('heartbeat'),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'failed',
            error: 'Account not found'
          })
        );
      });
    });

    it('should skip when account is not active', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue({ ...makeAccount(), status: 'suspended' });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('heartbeat'),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'skipped',
            error: 'Account status: suspended'
          })
        );
      });
    });

    it('should skip when agent not found', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(null);

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('heartbeat'),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentPersonalities.getAgentById).toHaveBeenCalledWith('agent-1');
      });
    });

    it('should skip when agent is disabled', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent({ enabled: false }));

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('heartbeat'),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'skipped',
            error: 'Agent disabled'
          })
        );
      });
    });

    it('should execute action and log completion on success', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
      mockMoltbookClient.heartbeat.mockResolvedValue({ browsed: 5 });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('heartbeat', { engageChance: 0.5 }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'completed',
            action: 'heartbeat'
          })
        );
      });
      expect(platformAccounts.recordActivity).toHaveBeenCalledWith('acc-1');
    });

    it('should log failure when action throws', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
      mockMoltbookClient.heartbeat.mockRejectedValue(new Error('API down'));

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('heartbeat'),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'failed',
            error: 'API down'
          })
        );
      });
    });
  });

  describe('heartbeat action', () => {
    beforeEach(() => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
    });

    it('should call client.heartbeat with params', async () => {
      mockMoltbookClient.heartbeat.mockResolvedValue({ browsed: 3, engaged: 1 });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('heartbeat', { engageChance: 0.5, maxEngagements: 2 }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltbookClient.heartbeat).toHaveBeenCalledWith({
          engageChance: 0.5,
          maxEngagements: 2
        });
      });
    });

    it('should use default params when none provided', async () => {
      mockMoltbookClient.heartbeat.mockResolvedValue({ browsed: 1 });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('heartbeat', {}),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltbookClient.heartbeat).toHaveBeenCalledWith({
          engageChance: 0.3,
          maxEngagements: 3
        });
      });
    });
  });

  describe('post action', () => {
    beforeEach(() => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
    });

    it('should create post with provided title and content', async () => {
      mockMoltbookClient.createPost.mockResolvedValue({ post: { id: 'p1' } });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('post', { submolt: 'tech', title: 'My Title', content: 'My Content' }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltbookClient.createPost).toHaveBeenCalledWith('tech', 'My Title', 'My Content');
      });
      expect(generatePost).not.toHaveBeenCalled();
    });

    it('should AI-generate content when title/content missing', async () => {
      mockMoltbookClient.createPost.mockResolvedValue({ post: { id: 'p2' } });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('post', { submolt: 'general' }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(generatePost).toHaveBeenCalled();
        expect(mockMoltbookClient.createPost).toHaveBeenCalledWith('general', 'AI Title', 'AI Content');
      });
    });

    it('should throw when no content and aiGenerate is false', async () => {
      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('post', { aiGenerate: false }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'failed',
            error: expect.stringContaining('requires title and content')
          })
        );
      });
    });
  });

  describe('vote action', () => {
    beforeEach(() => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
    });

    it('should upvote a specific post', async () => {
      mockMoltbookClient.upvote.mockResolvedValue({});

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('vote', { postId: 'p1', direction: 'up' }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltbookClient.upvote).toHaveBeenCalledWith('p1');
      });
    });

    it('should downvote when direction is down', async () => {
      mockMoltbookClient.downvote.mockResolvedValue({});

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('vote', { postId: 'p1', direction: 'down' }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltbookClient.downvote).toHaveBeenCalledWith('p1');
      });
    });

    it('should upvote comment when commentId provided', async () => {
      mockMoltbookClient.upvoteComment.mockResolvedValue({});

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('vote', { commentId: 'c1' }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltbookClient.upvoteComment).toHaveBeenCalledWith('c1');
      });
    });

    it('should pick random post from feed when no target specified', async () => {
      mockMoltbookClient.getFeed.mockResolvedValue({ posts: [{ id: 'p1', title: 'Post 1' }] });
      mockMoltbookClient.upvote.mockResolvedValue({});

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('vote', {}),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltbookClient.getFeed).toHaveBeenCalledWith('hot', 10);
        expect(mockMoltbookClient.upvote).toHaveBeenCalledWith('p1');
      });
    });

    it('should return none when feed is empty', async () => {
      mockMoltbookClient.getFeed.mockResolvedValue({ posts: [] });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('vote', {}),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'completed',
            result: expect.objectContaining({ action: 'none', reason: 'no posts in feed' })
          })
        );
      });
    });
  });

  describe('comment action', () => {
    beforeEach(() => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
    });

    it('should find relevant post and AI-generate comment when no postId', async () => {
      findReplyOpportunities.mockResolvedValue([
        { post: { id: 'p1', title: 'Test' }, comments: [], reason: 'relevant' }
      ]);
      mockMoltbookClient.createComment.mockResolvedValue({ id: 'c1' });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('comment', {}),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(findReplyOpportunities).toHaveBeenCalled();
        expect(generateComment).toHaveBeenCalled();
        expect(mockMoltbookClient.createComment).toHaveBeenCalledWith('p1', 'AI Comment');
      });
    });

    it('should return none when no relevant posts found', async () => {
      findReplyOpportunities.mockResolvedValue([]);

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('comment', {}),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'completed',
            result: expect.objectContaining({ action: 'none', reason: 'no relevant posts found' })
          })
        );
      });
    });

    it('should reply to parent comment when parentId provided', async () => {
      mockMoltbookClient.getPost.mockResolvedValue({ id: 'p1', title: 'Post' });
      mockMoltbookClient.getComments.mockResolvedValue({ comments: [{ id: 'parent-1', content: 'Parent' }] });
      mockMoltbookClient.replyToComment.mockResolvedValue({ id: 'c2' });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('comment', { postId: 'p1', parentId: 'parent-1' }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(generateReply).toHaveBeenCalled();
        expect(mockMoltbookClient.replyToComment).toHaveBeenCalledWith('p1', 'parent-1', 'AI Reply');
      });
    });
  });

  describe('unknown action type', () => {
    it('should fail with unknown action error', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: makeSchedule('invalid_action'),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'failed',
            error: 'Unknown action type: invalid_action'
          })
        );
      });
    });
  });

  describe('moltworld actions', () => {
    const mwAccount = makeAccount('moltworld');

    beforeEach(() => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(mwAccount);
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
    });

    it('should execute mw_heartbeat', async () => {
      mockMoltworldClient.joinWorld.mockResolvedValue({ nearby: [{ name: 'bot2' }] });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: { ...makeSchedule('mw_heartbeat', { x: 10, y: 20 }), accountId: 'acc-1', agentId: 'agent-1' },
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltworldClient.joinWorld).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'testuser', x: 10, y: 20 })
        );
      });
    });

    it('should execute mw_build', async () => {
      mockMoltworldClient.build.mockResolvedValue({ built: true });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: { ...makeSchedule('mw_build', { x: 5, y: 5, z: 1, type: 'wood' }), accountId: 'acc-1', agentId: 'agent-1' },
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltworldClient.build).toHaveBeenCalledWith(
          expect.objectContaining({ x: 5, y: 5, z: 1, type: 'wood', action: 'place' })
        );
      });
    });

    it('should execute mw_say', async () => {
      mockMoltworldClient.joinWorld.mockResolvedValue({ nearby: [] });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: { ...makeSchedule('mw_say', { message: 'Hello world', name: 'Bot' }), accountId: 'acc-1', agentId: 'agent-1' },
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltworldClient.joinWorld).toHaveBeenCalledWith(
          expect.objectContaining({ say: 'Hello world', name: 'Bot' })
        );
      });
    });

    it('should execute mw_think', async () => {
      mockMoltworldClient.think.mockResolvedValue({});

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: { ...makeSchedule('mw_think', { thought: 'Deep thoughts' }), accountId: 'acc-1', agentId: 'agent-1' },
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltworldClient.think).toHaveBeenCalledWith('Deep thoughts');
      });
    });

    it('should execute mw_explore with random coords when none provided', async () => {
      mockMoltworldClient.joinWorld.mockResolvedValue({ nearby: [] });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: { ...makeSchedule('mw_explore', {}), accountId: 'acc-1', agentId: 'agent-1' },
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(mockMoltworldClient.joinWorld).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'testuser',
            thinking: expect.any(String)
          })
        );
      });
    });

    it('should fail for unknown moltworld action', async () => {
      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: { ...makeSchedule('mw_unknown', {}), accountId: 'acc-1', agentId: 'agent-1' },
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'failed',
            error: 'Unknown Moltworld action type: mw_unknown'
          })
        );
      });
    });

    it('should execute mw_interact with build when buildType provided', async () => {
      mockMoltworldClient.joinWorld.mockResolvedValue({ nearby: [] });
      mockMoltworldClient.build.mockResolvedValue({ built: true });

      mockScheduleEvents.emit('execute', {
        scheduleId: 's1',
        schedule: { ...makeSchedule('mw_interact', { x: 1, y: 2, buildType: 'stone', thinking: 'Building...' }), accountId: 'acc-1', agentId: 'agent-1' },
        timestamp: new Date().toISOString()
      });

      // mw_interact has a 1.5s delay before build, so increase timeout
      await vi.waitFor(() => {
        expect(mockMoltworldClient.joinWorld).toHaveBeenCalled();
        expect(mockMoltworldClient.build).toHaveBeenCalledWith(
          expect.objectContaining({ x: 1, y: 2, type: 'stone', action: 'place' })
        );
      }, { timeout: 3000 });
    });
  });
});
