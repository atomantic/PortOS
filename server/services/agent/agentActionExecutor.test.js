import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executorRegistration, mockMoltbookClient, mockMoltworldClient } = vi.hoisted(() => {
  return {
    executorRegistration: { execute: null },
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

vi.mock('../automationScheduler.js', () => ({
  registerActionExecutor: (execute) => { executorRegistration.execute = execute; }
}));

vi.mock('./agentActivity.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  getActivities: vi.fn().mockResolvedValue([])
}));

vi.mock('../platformAccounts.js', () => ({
  getAccountWithCredentials: vi.fn(),
  recordActivity: vi.fn().mockResolvedValue(undefined),
  updateAccountStatus: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./agentPersonalities.js', () => ({
  getAgentById: vi.fn()
}));

vi.mock('../../integrations/moltbook/index.js', () => ({
  createMoltbookClient: vi.fn(() => mockMoltbookClient),
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  isAccountSuspended: vi.fn(() => false)
}));

vi.mock('../../integrations/moltworld/index.js', () => ({
  createMoltworldClient: vi.fn(() => mockMoltworldClient)
}));

vi.mock('./agentContentGenerator.js', () => ({
  generatePost: vi.fn().mockResolvedValue({ title: 'AI Title', content: 'AI Content' }),
  generateComment: vi.fn().mockResolvedValue({ content: 'AI Comment' }),
  generateReply: vi.fn().mockResolvedValue({ content: 'AI Reply' }),
  assertMoltbookCommentProvider: vi.fn().mockResolvedValue(undefined)
}));

// The engage/monitor loops pause 1.5s between platform writes.
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sleep: vi.fn().mockResolvedValue(undefined)
}));

import * as agentActivity from './agentActivity.js';
import * as platformAccounts from '../platformAccounts.js';
import * as agentPersonalities from './agentPersonalities.js';
import { generatePost, generateComment, generateReply, assertMoltbookCommentProvider } from './agentContentGenerator.js';
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
  personality: { topics: ['robotics'] },
  aiConfig: { content: { providerId: 'p1', model: 'm1' }, engagement: { providerId: 'p1', model: 'm1' } },
  ...overrides
});

// Scores +3 for the topic, clearing the comment threshold (2).
const matchingPost = (id) => ({ id, title: `Robotics update ${id}`, content: '', submolt: 'general' });

async function runAction(type, params = {}) {
  await executorRegistration.execute({
    scheduleId: 's1',
    schedule: makeSchedule(type, params),
    timestamp: new Date().toISOString()
  });
  return agentActivity.logActivity.mock.calls.at(-1)[0];
}

describe('agentActionExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps a previous mockRejectedValue. Comment paths must
    // pass the provider check unless a case opts out.
    assertMoltbookCommentProvider.mockResolvedValue(undefined);
    generatePost.mockResolvedValue({ title: 'AI Title', content: 'AI Content' });
    generateComment.mockResolvedValue({ content: 'AI Comment' });
    generateReply.mockResolvedValue({ content: 'AI Reply' });
    agentActivity.getActivities.mockResolvedValue([]);
    mockMoltbookClient.getFeed.mockResolvedValue({ posts: [] });
    mockMoltbookClient.getComments.mockResolvedValue({ comments: [] });
    init();
  });

  // ===========================================================================
  // Registered executor — account/agent validation
  // ===========================================================================
  describe('registered executor', () => {
    it('should log failure when account not found', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(null);

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

    it('should record failure when agent not found', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(null);

      await executorRegistration.execute({
        scheduleId: 's1',
        schedule: makeSchedule('heartbeat'),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'failed', error: 'Agent not found' })
        );
      });
    });

    it('should skip when agent is disabled', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent({ enabled: false }));

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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
      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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
      mockMoltbookClient.getFeed.mockResolvedValue({ posts: [matchingPost('p1')] });
      mockMoltbookClient.createComment.mockResolvedValue({ id: 'c1' });

      await executorRegistration.execute({
        scheduleId: 's1',
        schedule: makeSchedule('comment', {}),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(generateComment).toHaveBeenCalled();
        expect(mockMoltbookClient.createComment).toHaveBeenCalledWith('p1', 'AI Comment');
      });
    });

    it('should return none when no relevant posts found', async () => {
      await executorRegistration.execute({
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

      await executorRegistration.execute({
        scheduleId: 's1',
        schedule: makeSchedule('comment', { postId: 'p1', parentId: 'parent-1' }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(generateReply).toHaveBeenCalled();
        expect(mockMoltbookClient.replyToComment).toHaveBeenCalledWith('p1', 'parent-1', 'AI Reply');
      });
    });

    it('skips a CLI content provider before reading the feed or publishing', async () => {
      const refusal = Object.assign(new Error('Provider "Example CLI" cannot read Moltbook posts.'), {
        code: 'untrusted-content-provider-unavailable',
        status: 422
      });
      assertMoltbookCommentProvider.mockRejectedValue(refusal);

      await executorRegistration.execute({
        scheduleId: 's1',
        schedule: makeSchedule('comment', {}),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'skipped',
            code: 'untrusted-content-provider-unavailable',
            error: refusal.message
          })
        );
      });
      expect(assertMoltbookCommentProvider).toHaveBeenCalledWith('p1');
      expect(mockMoltbookClient.getFeed).not.toHaveBeenCalled();
      expect(generateComment).not.toHaveBeenCalled();
      expect(mockMoltbookClient.createComment).not.toHaveBeenCalled();
    });
  });

  describe('engage and monitor actions', () => {
    beforeEach(() => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
    });

    it('skips engage before votes when the engagement provider cannot read Moltbook', async () => {
      assertMoltbookCommentProvider.mockRejectedValue(Object.assign(new Error('blocked'), {
        code: 'untrusted-content-provider-unavailable'
      }));

      await executorRegistration.execute({
        scheduleId: 's1',
        schedule: makeSchedule('engage', { maxComments: 1, maxVotes: 3 }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'skipped', code: 'untrusted-content-provider-unavailable' })
        );
      });
      expect(mockMoltbookClient.getFeed).not.toHaveBeenCalled();
      expect(generateComment).not.toHaveBeenCalled();
      expect(mockMoltbookClient.upvote).not.toHaveBeenCalled();
      expect(mockMoltbookClient.createComment).not.toHaveBeenCalled();
    });

    it('skips monitor before the author feed when replies would be generated', async () => {
      assertMoltbookCommentProvider.mockRejectedValue(Object.assign(new Error('blocked'), {
        code: 'security-guard-classified-malicious'
      }));

      await executorRegistration.execute({
        scheduleId: 's1',
        schedule: makeSchedule('monitor', { maxReplies: 2 }),
        timestamp: new Date().toISOString()
      });

      await vi.waitFor(() => {
        expect(agentActivity.logActivity).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'skipped', code: 'security-guard-classified-malicious' })
        );
      });
      expect(mockMoltbookClient.getPostsByAuthor).not.toHaveBeenCalled();
      expect(generateReply).not.toHaveBeenCalled();
      expect(mockMoltbookClient.upvoteComment).not.toHaveBeenCalled();
      expect(mockMoltbookClient.replyToComment).not.toHaveBeenCalled();
    });
  });

  describe('repeat engagement', () => {
    beforeEach(() => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
      mockMoltbookClient.upvote.mockResolvedValue({});
      mockMoltbookClient.upvoteComment.mockResolvedValue({});
      mockMoltbookClient.createComment.mockResolvedValue({ id: 'new-comment' });
      mockMoltbookClient.replyToComment.mockResolvedValue({ id: 'new-reply' });
    });

    it.each(['engage', 'comment'])('%s skips a hot post the agent already commented on and takes the next one', async (type) => {
      mockMoltbookClient.getFeed.mockResolvedValue({ posts: ['a', 'b', 'c', 'd', 'e'].map(matchingPost) });
      mockMoltbookClient.getComments.mockImplementation(async (postId) => ({
        comments: postId === 'e' ? [{ author: 'someone-else' }] : [{ author: { name: 'testuser' } }]
      }));

      await runAction(type, type === 'engage' ? { maxComments: 1, maxVotes: 0 } : {});

      expect(mockMoltbookClient.createComment.mock.calls).toEqual([['e', 'AI Comment']]);
    });

    it('does not comment on off-topic posts that carry no submolt', async () => {
      mockMoltbookClient.getFeed.mockResolvedValue({ posts: [{ id: 'off-topic', title: 'Gardening', content: '' }] });

      const logged = await runAction('comment');

      expect(mockMoltbookClient.createComment).not.toHaveBeenCalled();
      expect(logged.result).toMatchObject({ action: 'none' });
    });

    it('records only the votes and comments the platform accepted, with the comment id', async () => {
      mockMoltbookClient.getFeed.mockResolvedValue({ posts: ['a', 'b'].map(matchingPost) });
      mockMoltbookClient.upvote.mockRejectedValueOnce(new Error('503'));
      mockMoltbookClient.createComment
        .mockRejectedValueOnce(new Error('503'))
        .mockResolvedValueOnce({ id: 'c-b' });

      const logged = await runAction('engage', { maxComments: 2, maxVotes: 2 });

      expect(logged).toMatchObject({ status: 'completed' });
      expect(logged.result.votes.map(v => v.postId)).toEqual(['b']);
      expect(logged.result.comments).toEqual([expect.objectContaining({ postId: 'b', commentId: 'c-b' })]);
    });

    it('logs an unsolved verification challenge instead of a completed publication', async () => {
      mockMoltbookClient.createPost.mockResolvedValue({ post: { id: 'p1' }, verification_solved: false });

      const logged = await runAction('post', { title: 'T', content: 'C' });

      expect(logged.status).toBe('verification_failed');
    });

    it('solves challenges with the agent\'s pinned challenge provider', async () => {
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent({ aiConfig: { challenge: { providerId: 'solver' } } }));
      mockMoltbookClient.createPost.mockResolvedValue({ post: { id: 'p1' } });

      await runAction('post', { title: 'T', content: 'C' });

      expect(mockMoltbookClient.aiConfig).toEqual({ providerId: 'solver' });
    });

    it('monitor replies once per comment across runs, even when an earlier run was suspended', async () => {
      mockMoltbookClient.getPostsByAuthor.mockResolvedValue([
        { id: 'mine', title: 'Mine', created_at: new Date().toISOString() }
      ]);
      mockMoltbookClient.getComments.mockResolvedValue({ comments: [
        { id: 'logged', author: 'a' },
        { id: 'threaded', author: 'b' },
        { id: 'own', author: 'testuser', parent_id: 'threaded' },
        { id: 'fresh', author: 'c' }
      ] });
      agentActivity.getActivities.mockImplementation(async (_agentId, { action, date }) => (
        action === 'monitor' && date.toDateString() === new Date().toDateString()
          ? [{ status: 'failed', result: { replied: [{ commentId: 'logged' }], upvoted: [{ commentId: 'logged' }] } }, { status: 'failed', result: null }]
          : []
      ));

      const logged = await runAction('monitor', { days: 2, maxReplies: 5, maxUpvotes: 5 });

      expect(mockMoltbookClient.replyToComment.mock.calls).toEqual([['mine', 'fresh', 'AI Reply']]);
      expect(mockMoltbookClient.upvoteComment.mock.calls.flat()).toEqual(['threaded', 'fresh']);
      expect(logged.result.replied.map(r => r.commentId)).toEqual(['fresh']);
    });

    it('monitor keeps a failed reply retryable by not recording it', async () => {
      mockMoltbookClient.getPostsByAuthor.mockResolvedValue([
        { id: 'mine', title: 'Mine', created_at: new Date().toISOString() }
      ]);
      mockMoltbookClient.getComments.mockResolvedValue({ comments: [{ id: 'c1', author: 'a' }] });
      mockMoltbookClient.upvoteComment.mockRejectedValueOnce(new Error('503'));
      mockMoltbookClient.replyToComment.mockRejectedValueOnce(new Error('503'));

      const logged = await runAction('monitor', { maxReplies: 1, maxUpvotes: 1 });

      expect(logged.result).toMatchObject({ replied: [], upvoted: [] });
    });
  });

  describe('unknown action type', () => {
    it('should fail with unknown action error', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(makeAccount());
      agentPersonalities.getAgentById.mockResolvedValue(makeAgent());
      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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

      await executorRegistration.execute({
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
      await executorRegistration.execute({
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

      await executorRegistration.execute({
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
