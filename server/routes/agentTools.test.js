import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Route-contract tests for agentTools: validation (400), account/agent status
// mapping (404 / ACCOUNT_INACTIVE), and the MOLTBOOK_ACTION_DELAY_MS throttle
// on the engage loop. The platform + content + moltbook deps are mocked so no
// network or real 1.5s sleeps happen.
const fnMap = vi.hoisted(() => (names) => Object.fromEntries(names.map((n) => [n, vi.fn()])));

// Capture sleep calls (the throttle) and resolve instantly so the engage loop
// doesn't actually wait 1.5s between writes.
const sleepMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../lib/fileUtils.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, sleep: sleepMock };
});

vi.mock('../services/platformAccounts.js', () => fnMap([
  'getAccountWithCredentials', 'recordActivity', 'updateAccountStatus',
]));
vi.mock('../services/agent/agentPersonalities.js', () => fnMap(['getAgentById']));
vi.mock('../services/agent/agentActivity.js', () => fnMap(['logActivity', 'getActivities']));
vi.mock('../services/agent/agentDrafts.js', () => fnMap([
  'listDrafts', 'createDraft', 'updateDraft', 'deleteDraft',
]));
vi.mock('../services/agent/agentContentGenerator.js', () => fnMap([
  'generatePost', 'generateComment', 'generateReply', 'assertMoltbookCommentProvider',
]));

// createMoltbookClient is a factory; checkRateLimit gates the engage loop's writes.
const moltbookClient = vi.hoisted(() => ({
  createPost: vi.fn(() => Promise.resolve({ id: 'p-new' })),
  upvote: vi.fn(() => Promise.resolve({})),
  createComment: vi.fn(() => Promise.resolve({ id: 'c1' })),
  getPost: vi.fn(() => Promise.resolve({ id: 'p1', title: 'T' })),
  getComments: vi.fn(() => Promise.resolve({ comments: [] })),
  getFeed: vi.fn(() => Promise.resolve({ posts: [] })),
  getPostsByAuthor: vi.fn(() => Promise.resolve([])),
  upvoteComment: vi.fn(() => Promise.resolve({})),
  replyToComment: vi.fn(() => Promise.resolve({ id: 'r1' })),
  apiKey: 'key-123',
}));
const checkRateLimitMock = vi.hoisted(() => vi.fn(() => ({ allowed: true })));
const isAccountSuspendedMock = vi.hoisted(() => vi.fn(() => false));
vi.mock('../integrations/moltbook/index.js', () => ({
  createMoltbookClient: () => moltbookClient,
  checkRateLimit: checkRateLimitMock,
  isAccountSuspended: isAccountSuspendedMock,
}));

import agentToolsRoutes from './agentTools.js';
import * as platformAccounts from '../services/platformAccounts.js';
import * as agentPersonalities from '../services/agent/agentPersonalities.js';
import * as agentActivity from '../services/agent/agentActivity.js';
import * as agentDrafts from '../services/agent/agentDrafts.js';
import { generatePost, generateComment, generateReply, assertMoltbookCommentProvider } from '../services/agent/agentContentGenerator.js';
import { ServerError } from '../lib/errorHandler.js';

const ACTIVE_ACCOUNT = { id: 'acc-1', status: 'active', credentials: { apiKey: 'key-123', username: 'testuser' } };
const AGENT = { id: 'agent-1', name: 'Bot', aiConfig: {} };

describe('Agent Tools Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/agents/tools', agentToolsRoutes);
    vi.clearAllMocks();
    assertMoltbookCommentProvider.mockResolvedValue(undefined);
    isAccountSuspendedMock.mockReturnValue(false);
    agentActivity.getActivities.mockResolvedValue([]);
  });

  describe('POST /generate-post', () => {
    it('400s when agentId/accountId are missing', async () => {
      const res = await request(app).post('/api/agents/tools/generate-post').send({ submolt: 'general' });
      expect(res.status).toBe(400);
      expect(generatePost).not.toHaveBeenCalled();
    });

    it('returns the generated post on the happy path', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      generatePost.mockResolvedValue({ title: 'Hi', content: 'Body' });

      const res = await request(app)
        .post('/api/agents/tools/generate-post')
        .send({ agentId: 'agent-1', accountId: 'acc-1', submolt: 'general' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ title: 'Hi', content: 'Body' });
      expect(generatePost).toHaveBeenCalledOnce();
    });

    it('404s when the account is unknown', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/agents/tools/generate-post')
        .send({ agentId: 'agent-1', accountId: 'ghost' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('404s when the agent is unknown', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/agents/tools/generate-post')
        .send({ agentId: 'ghost', accountId: 'acc-1' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /feed and /relevant-posts query validation', () => {
    it.each([
      '/feed?accountId=acc-1&limit=-1',
      '/feed?accountId=acc-1&limit=0',
      '/feed?accountId=acc-1&limit=abc',
      '/feed?accountId=acc-1&limit=101',
      '/feed?accountId=acc-1&sort=bogus',
      '/feed?accountId=a&accountId=b',
      '/feed',
      '/relevant-posts?agentId=agent-1&accountId=acc-1&maxResults=-1',
      '/relevant-posts?agentId=agent-1&accountId=acc-1&maxResults=0',
      '/relevant-posts?agentId=agent-1&accountId=acc-1&maxResults=abc',
      '/relevant-posts?accountId=acc-1',
    ])('400s %s before any lookup', async (path) => {
      const res = await request(app).get(`/api/agents/tools${path}`);
      expect(res.status).toBe(400);
      expect(platformAccounts.getAccountWithCredentials).not.toHaveBeenCalled();
      expect(moltbookClient.getFeed).not.toHaveBeenCalled();
    });

    it('passes coerced numeric limit and default sort to the client', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      moltbookClient.getFeed.mockResolvedValueOnce({ posts: [] });
      const res = await request(app).get('/api/agents/tools/feed?accountId=acc-1&limit=5');
      expect(res.status).toBe(200);
      expect(moltbookClient.getFeed).toHaveBeenCalledWith('hot', 5);
    });
  });

  describe('POST /engage', () => {
    it('returns ACCOUNT_INACTIVE (400) for a non-active account', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue({ ...ACTIVE_ACCOUNT, status: 'suspended' });
      const res = await request(app)
        .post('/api/agents/tools/engage')
        .send({ agentId: 'agent-1', accountId: 'acc-1' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ACCOUNT_INACTIVE');
      expect(moltbookClient.getFeed).not.toHaveBeenCalled();
    });

    it('400s on out-of-range maxVotes', async () => {
      const res = await request(app)
        .post('/api/agents/tools/engage')
        .send({ agentId: 'agent-1', accountId: 'acc-1', maxVotes: 999 });
      expect(res.status).toBe(400);
    });

    it('throttles between each vote with MOLTBOOK_ACTION_DELAY_MS', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      moltbookClient.getFeed.mockResolvedValueOnce({ posts: [
        { id: 'p1', title: 'A' },
        { id: 'p2', title: 'B' },
        { id: 'p3', title: 'C' },
      ] });

      const res = await request(app)
        .post('/api/agents/tools/engage')
        .send({ agentId: 'agent-1', accountId: 'acc-1', maxVotes: 3, maxComments: 0 });

      expect(res.status).toBe(200);
      expect(res.body.votes).toHaveLength(3);
      expect(moltbookClient.upvote).toHaveBeenCalledTimes(3);
      // One throttle sleep per vote, all with the documented delay.
      expect(sleepMock).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenCalledWith(1500);
    });

    it('stops voting early when the rate limiter disallows', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      moltbookClient.getFeed.mockResolvedValueOnce({ posts: [{ id: 'p1', title: 'A' }, { id: 'p2', title: 'B' }] });
      checkRateLimitMock.mockReturnValueOnce({ allowed: false });

      const res = await request(app)
        .post('/api/agents/tools/engage')
        .send({ agentId: 'agent-1', accountId: 'acc-1', maxVotes: 5, maxComments: 0 });

      expect(res.status).toBe(200);
      expect(res.body.votes).toHaveLength(0);
      expect(moltbookClient.upvote).not.toHaveBeenCalled();
    });

    it('refuses an ineligible engagement provider before any vote or comment', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue({
        ...AGENT,
        aiConfig: { engagement: { providerId: 'cli-1' } },
      });
      assertMoltbookCommentProvider.mockRejectedValue(new ServerError(
        'Provider "Example CLI" cannot read Moltbook posts.',
        { status: 422, code: 'untrusted-content-provider-unavailable' },
      ));

      const res = await request(app)
        .post('/api/agents/tools/engage')
        .send({ agentId: 'agent-1', accountId: 'acc-1', maxVotes: 3, maxComments: 1 });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('untrusted-content-provider-unavailable');
      expect(assertMoltbookCommentProvider).toHaveBeenCalledWith('cli-1');
      expect(moltbookClient.getFeed).not.toHaveBeenCalled();
      expect(generateComment).not.toHaveBeenCalled();
      expect(moltbookClient.upvote).not.toHaveBeenCalled();
      expect(moltbookClient.createComment).not.toHaveBeenCalled();
    });

    it('skips posts the account already commented on and does not report an unverified comment', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue({ ...AGENT, personality: { topics: ['robotics'] } });
      generateComment.mockResolvedValue({ content: 'Hello' });
      moltbookClient.getFeed.mockResolvedValue({ posts: ['done', 'held', 'ok'].map(id => ({ id, title: 'Robotics' })) });
      moltbookClient.getComments.mockImplementation(async id => ({ comments: id === 'done' ? [{ author: 'testuser' }] : [] }));
      moltbookClient.createComment
        .mockResolvedValueOnce({ id: 'c-held', verification_solved: false })
        .mockResolvedValueOnce({ id: 'c-ok' });

      const res = await request(app)
        .post('/api/agents/tools/engage')
        .send({ agentId: 'agent-1', accountId: 'acc-1', maxVotes: 0, maxComments: 1 });

      expect(res.status).toBe(200);
      expect(moltbookClient.createComment.mock.calls.map(([id]) => id)).toEqual(['held', 'ok']);
      expect(res.body.comments).toEqual([expect.objectContaining({ postId: 'ok', commentId: 'c-ok' })]);
    });
  });

  describe('POST /check-posts', () => {
    it('replies and upvotes only comments no earlier run handled', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      generateReply.mockResolvedValue({ content: 'Thanks' });
      moltbookClient.getPostsByAuthor.mockResolvedValue([{ id: 'mine', title: 'Mine', created_at: new Date().toISOString() }]);
      moltbookClient.getComments.mockImplementation(async () => ({ comments: [{ id: 'old', author: 'a' }, { id: 'new', author: 'b' }] }));
      agentActivity.getActivities.mockImplementation(async (agentId, { action }) => (
        agentId === 'agent-1' && action === 'monitor'
          ? [{ status: 'completed', result: { replied: [{ commentId: 'old' }], upvoted: [{ commentId: 'old' }] } }]
          : []
      ));

      const res = await request(app)
        .post('/api/agents/tools/check-posts')
        .send({ agentId: 'agent-1', accountId: 'acc-1', maxReplies: 2, maxUpvotes: 2 });

      expect(res.status).toBe(200);
      expect(moltbookClient.replyToComment.mock.calls).toEqual([['mine', 'new', 'Thanks']]);
      expect(moltbookClient.upvoteComment.mock.calls).toEqual([['new']]);
    });
  });

  describe('GET /published', () => {
    it('lists completed posts and engagement comments once, with live engagement counts', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      const log = {
        post: [
          { id: 'a1', status: 'completed', timestamp: '2026-01-01T00:00:00Z', result: { postId: 'p1', title: 'Live', submolt: 'general' } },
          { id: 'a2', status: 'verification_failed', timestamp: '2026-01-01T00:00:00Z', result: { postId: 'p2', title: 'Held' } },
        ],
        comment: [],
        engage: [{ id: 'a3', status: 'completed', timestamp: '2026-01-01T00:00:00Z', result: { comments: [{ postId: 'p9', postTitle: 'Other', commentId: 'c9' }] } }],
      };
      agentActivity.getActivities.mockImplementation(async (_id, { action }) => log[action] ?? []);
      moltbookClient.getPost.mockResolvedValue({ id: 'p1', score: 4, comment_count: 7 });

      const res = await request(app).get('/api/agents/tools/published?agentId=agent-1&accountId=acc-1&days=2');

      expect(res.status).toBe(200);
      expect(res.body.posts).toEqual([expect.objectContaining({ postId: 'p1', score: 4, commentCount: 7 })]);
      expect(res.body.comments).toEqual([expect.objectContaining({ commentId: 'c9', postTitle: 'Other' })]);
    });
  });

  describe('POST /generate-comment', () => {
    // Catches untrusted Moltbook content reaching an ineligible provider before the gate runs.
    it('refuses an ineligible comment provider before fetching post or comments', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      assertMoltbookCommentProvider.mockRejectedValueOnce(new ServerError(
        'Provider cannot read untrusted posts',
        { status: 422, code: 'untrusted-content-provider-unavailable' },
      ));

      const res = await request(app)
        .post('/api/agents/tools/generate-comment')
        .send({ agentId: 'agent-1', accountId: 'acc-1', postId: 'p1', providerId: 'cli-1' });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('untrusted-content-provider-unavailable');
      expect(assertMoltbookCommentProvider).toHaveBeenCalledWith('cli-1');
      expect(moltbookClient.getPost).not.toHaveBeenCalled();
      expect(moltbookClient.getComments).not.toHaveBeenCalled();
      expect(generateComment).not.toHaveBeenCalled();
      expect(generateReply).not.toHaveBeenCalled();
    });

    it('routes to generateReply when parentId matches a comment and falls back to generateComment otherwise', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      const post = { id: 'p1', title: 'Topic' };
      const parent = { id: 'c-parent', content: 'Parent comment' };
      moltbookClient.getPost.mockResolvedValue(post);
      moltbookClient.getComments.mockResolvedValue({ comments: [parent] });
      generateReply.mockResolvedValueOnce({ content: 'Direct reply' });
      generateComment.mockResolvedValueOnce({ content: 'Top-level comment' });

      const replyRes = await request(app)
        .post('/api/agents/tools/generate-comment')
        .send({ agentId: 'agent-1', accountId: 'acc-1', postId: 'p1', parentId: 'c-parent', providerId: 'p-api', model: 'm1' });
      expect(replyRes.status).toBe(200);
      expect(replyRes.body).toEqual({ content: 'Direct reply' });
      expect(generateReply).toHaveBeenCalledWith(AGENT, post, parent, null, 'p-api', 'm1');

      const fallbackRes = await request(app)
        .post('/api/agents/tools/generate-comment')
        .send({ agentId: 'agent-1', accountId: 'acc-1', postId: 'p1', parentId: 'c-missing' });
      expect(fallbackRes.status).toBe(200);
      expect(fallbackRes.body).toEqual({ content: 'Top-level comment' });
      expect(generateComment).toHaveBeenCalledWith(AGENT, post, [parent], null, undefined, undefined);
    });
  });

  describe('POST /publish-post and POST /publish-comment', () => {
    it('publishes a post, records activity, and flags verification_solved=false as verification_failed', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      moltbookClient.createPost
        .mockResolvedValueOnce({ post: { id: 'post-1', title: 'Ship it' } })
        .mockResolvedValueOnce({ post: { id: 'post-2', title: 'Held' }, verification_solved: false });

      const invalid = await request(app)
        .post('/api/agents/tools/publish-post')
        .send({ agentId: 'agent-1', accountId: 'acc-1', submolt: 'general' });
      expect(invalid.status).toBe(400);
      expect(moltbookClient.createPost).not.toHaveBeenCalled();

      const ok = await request(app)
        .post('/api/agents/tools/publish-post')
        .send({ agentId: 'agent-1', accountId: 'acc-1', submolt: 'general', title: 'Ship it', content: 'Body' });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ id: 'post-1', title: 'Ship it', verificationFailed: false });
      expect(platformAccounts.recordActivity).toHaveBeenCalledWith('acc-1');
      expect(agentActivity.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'post',
        status: 'completed',
        result: expect.objectContaining({ postId: 'post-1', verificationFailed: false }),
      }));

      const held = await request(app)
        .post('/api/agents/tools/publish-post')
        .send({ agentId: 'agent-1', accountId: 'acc-1', submolt: 'general', title: 'Held', content: 'Body' });
      expect(held.status).toBe(200);
      expect(held.body).toMatchObject({ id: 'post-2', verificationFailed: true });
      expect(agentActivity.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'post',
        status: 'verification_failed',
        result: expect.objectContaining({ postId: 'post-2', verificationFailed: true }),
      }));
    });

    it('dispatches publish-comment to createComment or replyToComment and records verification failures', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      moltbookClient.createComment.mockResolvedValueOnce({ id: 'c-top' });
      moltbookClient.replyToComment.mockResolvedValueOnce({ id: 'c-reply', verification_solved: false });

      const top = await request(app)
        .post('/api/agents/tools/publish-comment')
        .send({ agentId: 'agent-1', accountId: 'acc-1', postId: 'p1', content: 'Nice post' });
      expect(top.status).toBe(200);
      expect(top.body).toEqual({ id: 'c-top', verificationFailed: false });
      expect(moltbookClient.createComment).toHaveBeenCalledWith('p1', 'Nice post');
      expect(agentActivity.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'comment',
        status: 'completed',
        result: expect.objectContaining({ commentId: 'c-top', isReply: false, verificationFailed: false }),
      }));

      const reply = await request(app)
        .post('/api/agents/tools/publish-comment')
        .send({ agentId: 'agent-1', accountId: 'acc-1', postId: 'p1', parentId: 'c-top', content: 'Follow-up' });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ id: 'c-reply', verificationFailed: true });
      expect(moltbookClient.replyToComment).toHaveBeenCalledWith('p1', 'c-top', 'Follow-up');
      expect(agentActivity.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'comment',
        status: 'verification_failed',
        result: expect.objectContaining({ commentId: 'c-reply', isReply: true, verificationFailed: true }),
      }));
    });
  });

  describe('POST /check-posts suspension halt', () => {
    // Catches continuing to hammer Moltbook or failing to mark the account suspended after a suspension error.
    it('halts monitoring early, marks the account suspended, and logs a failed monitor run', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue(ACTIVE_ACCOUNT);
      agentPersonalities.getAgentById.mockResolvedValue(AGENT);
      const now = new Date().toISOString();
      moltbookClient.getPostsByAuthor.mockResolvedValueOnce([
        { id: 'p1', title: 'First', created_at: now },
        { id: 'p2', title: 'Second', created_at: now },
      ]);
      const suspendedErr = new Error('403 account suspended');
      moltbookClient.getComments.mockRejectedValueOnce(suspendedErr);
      isAccountSuspendedMock.mockImplementation((err) => err === suspendedErr);

      const res = await request(app)
        .post('/api/agents/tools/check-posts')
        .send({ agentId: 'agent-1', accountId: 'acc-1', maxReplies: 1, maxUpvotes: 1 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ postsChecked: 2, suspended: true });
      expect(moltbookClient.getComments).toHaveBeenCalledTimes(1);
      expect(platformAccounts.updateAccountStatus).toHaveBeenCalledWith('acc-1', 'suspended');
      expect(agentActivity.logActivity).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'monitor',
        status: 'failed',
        error: 'Account suspended by platform',
      }));
    });
  });

  describe('Drafts CRUD (/drafts)', () => {
    it('lists, creates, updates, and deletes drafts while returning 400 on invalid input and 404 on missing drafts', async () => {
      agentDrafts.listDrafts.mockResolvedValueOnce([{ id: 'd1', type: 'post', content: 'Hello' }]);
      agentDrafts.createDraft.mockResolvedValueOnce({ id: 'd2', type: 'post', content: 'New' });
      agentDrafts.updateDraft
        .mockResolvedValueOnce({ id: 'd2', content: 'Updated' })
        .mockResolvedValueOnce(null);
      agentDrafts.deleteDraft
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      expect((await request(app).get('/api/agents/tools/drafts')).status).toBe(400);
      const listed = await request(app).get('/api/agents/tools/drafts?agentId=agent-1');
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([{ id: 'd1', type: 'post', content: 'Hello' }]);

      const badCreate = await request(app)
        .post('/api/agents/tools/drafts')
        .send({ agentId: 'agent-1', type: 'invalid', content: 'Nope' });
      expect(badCreate.status).toBe(400);
      const created = await request(app)
        .post('/api/agents/tools/drafts')
        .send({ agentId: 'agent-1', type: 'post', title: 'Draft', content: 'New' });
      expect(created.status).toBe(201);
      expect(created.body).toEqual({ id: 'd2', type: 'post', content: 'New' });

      const updated = await request(app)
        .put('/api/agents/tools/drafts/d2?agentId=agent-1')
        .send({ content: 'Updated' });
      expect(updated.status).toBe(200);
      expect(updated.body).toEqual({ id: 'd2', content: 'Updated' });
      expect((await request(app).put('/api/agents/tools/drafts/missing?agentId=agent-1').send({ content: 'X' })).status).toBe(404);

      const deleted = await request(app).delete('/api/agents/tools/drafts/d2?agentId=agent-1');
      expect(deleted.status).toBe(204);
      expect(deleted.text).toBe('');
      expect((await request(app).delete('/api/agents/tools/drafts/missing?agentId=agent-1')).status).toBe(404);
    });
  });
});
