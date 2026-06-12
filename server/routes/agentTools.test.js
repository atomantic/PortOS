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
  'getAccountWithCredentials', 'recordActivity',
]));
vi.mock('../services/agentPersonalities.js', () => fnMap(['getAgentById']));
vi.mock('../services/agentActivity.js', () => fnMap(['logActivity']));
vi.mock('../services/agentDrafts.js', () => fnMap([
  'listDrafts', 'createDraft', 'updateDraft', 'deleteDraft',
]));
vi.mock('../services/agentContentGenerator.js', () => fnMap([
  'generatePost', 'generateComment', 'generateReply',
]));
vi.mock('../services/agentFeedFilter.js', () => fnMap([
  'findRelevantPosts', 'findReplyOpportunities',
]));
vi.mock('../services/agentPublished.js', () => fnMap(['collectPublishedPosts']));

// MoltbookClient is a factory; checkRateLimit gates the engage loop's writes.
const moltbookClient = vi.hoisted(() => ({
  upvote: vi.fn(() => Promise.resolve({})),
  createComment: vi.fn(() => Promise.resolve({ id: 'c1' })),
  getPost: vi.fn(() => Promise.resolve({ id: 'p1', title: 'T' })),
  getComments: vi.fn(() => Promise.resolve({ comments: [] })),
  apiKey: 'key-123',
}));
const checkRateLimitMock = vi.hoisted(() => vi.fn(() => ({ allowed: true })));
vi.mock('../integrations/moltbook/index.js', () => ({
  // The route calls `new MoltbookClient(apiKey)`; a plain function returning
  // the shared mock client is constructable (new returns the object).
  MoltbookClient: function MoltbookClient() { return moltbookClient; },
  checkRateLimit: checkRateLimitMock,
}));

import agentToolsRoutes from './agentTools.js';
import * as platformAccounts from '../services/platformAccounts.js';
import * as agentPersonalities from '../services/agentPersonalities.js';
import { generatePost, generateComment } from '../services/agentContentGenerator.js';
import { findRelevantPosts, findReplyOpportunities } from '../services/agentFeedFilter.js';

const ACTIVE_ACCOUNT = { id: 'acc-1', status: 'active', credentials: { apiKey: 'key-123' } };
const AGENT = { id: 'agent-1', name: 'Bot', aiConfig: {} };

describe('Agent Tools Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/agents/tools', agentToolsRoutes);
    vi.clearAllMocks();
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

  describe('POST /engage', () => {
    it('returns ACCOUNT_INACTIVE (400) for a non-active account', async () => {
      platformAccounts.getAccountWithCredentials.mockResolvedValue({ ...ACTIVE_ACCOUNT, status: 'suspended' });
      const res = await request(app)
        .post('/api/agents/tools/engage')
        .send({ agentId: 'agent-1', accountId: 'acc-1' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ACCOUNT_INACTIVE');
      expect(findRelevantPosts).not.toHaveBeenCalled();
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
      findRelevantPosts.mockResolvedValue([
        { id: 'p1', title: 'A' },
        { id: 'p2', title: 'B' },
        { id: 'p3', title: 'C' },
      ]);
      findReplyOpportunities.mockResolvedValue([]);

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
      findRelevantPosts.mockResolvedValue([{ id: 'p1', title: 'A' }, { id: 'p2', title: 'B' }]);
      findReplyOpportunities.mockResolvedValue([]);
      checkRateLimitMock.mockReturnValueOnce({ allowed: false });

      const res = await request(app)
        .post('/api/agents/tools/engage')
        .send({ agentId: 'agent-1', accountId: 'acc-1', maxVotes: 5, maxComments: 0 });

      expect(res.status).toBe(200);
      expect(res.body.votes).toHaveLength(0);
      expect(moltbookClient.upvote).not.toHaveBeenCalled();
    });
  });
});
