/**
 * Agent Tools Routes
 *
 * HTTP endpoints for agent content generation, feed browsing,
 * publishing, and autonomous engagement.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validate,
  generatePostSchema,
  generateCommentSchema,
  publishPostSchema,
  publishCommentSchema,
  engageSchema
} from '../lib/validation.js';
import * as platformAccounts from '../services/platformAccounts.js';
import * as agentPersonalities from '../services/agentPersonalities.js';
import * as agentActivity from '../services/agentActivity.js';
import { generatePost, generateComment, generateReply } from '../services/agentContentGenerator.js';
import { findRelevantPosts } from '../services/agentFeedFilter.js';
import { MoltbookClient } from '../integrations/moltbook/index.js';

const router = Router();

/**
 * Get authenticated MoltbookClient for an account
 */
async function getClientAndAgent(accountId, agentId) {
  const account = await platformAccounts.getAccountWithCredentials(accountId);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }
  if (account.status !== 'active') {
    throw new ServerError(`Account not active: ${account.status}`, { status: 400, code: 'ACCOUNT_INACTIVE' });
  }

  const agent = await agentPersonalities.getAgentById(agentId);
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  }

  const client = new MoltbookClient(account.credentials.apiKey);
  return { client, agent, account };
}

// POST /generate-post - Preview AI-generated post (doesn't publish)
router.post('/generate-post', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(generatePostSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🛠️ POST /api/agents/tools/generate-post agent=${data.agentId}`);

  const { agent } = await getClientAndAgent(data.accountId, data.agentId);
  const generated = await generatePost(agent, { submolt: data.submolt || 'general' }, data.providerId, data.model);
  res.json(generated);
}));

// POST /generate-comment - Preview AI-generated comment
router.post('/generate-comment', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(generateCommentSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🛠️ POST /api/agents/tools/generate-comment agent=${data.agentId} post=${data.postId}`);

  const { client, agent } = await getClientAndAgent(data.accountId, data.agentId);

  const post = await client.getPost(data.postId);
  const commentsResponse = await client.getComments(data.postId);
  const comments = commentsResponse.comments || commentsResponse || [];

  let generated;
  if (data.parentId) {
    const parent = comments.find(c => c.id === data.parentId);
    generated = parent
      ? await generateReply(agent, post, parent, null, data.providerId, data.model)
      : await generateComment(agent, post, comments, null, data.providerId, data.model);
  } else {
    generated = await generateComment(agent, post, comments, null, data.providerId, data.model);
  }

  res.json(generated);
}));

// POST /publish-post - Publish a post to Moltbook
router.post('/publish-post', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(publishPostSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🛠️ POST /api/agents/tools/publish-post agent=${data.agentId} submolt=${data.submolt}`);

  const { client, account } = await getClientAndAgent(data.accountId, data.agentId);
  const post = await client.createPost(data.submolt, data.title, data.content);

  await platformAccounts.recordActivity(data.accountId);
  await agentActivity.logActivity({
    agentId: data.agentId,
    accountId: data.accountId,
    action: 'post',
    params: { submolt: data.submolt, title: data.title },
    status: 'completed',
    result: { type: 'post', postId: post.id, submolt: data.submolt, title: data.title },
    timestamp: new Date().toISOString()
  });

  res.json(post);
}));

// POST /publish-comment - Publish a comment to Moltbook
router.post('/publish-comment', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(publishCommentSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🛠️ POST /api/agents/tools/publish-comment agent=${data.agentId} post=${data.postId}`);

  const { client } = await getClientAndAgent(data.accountId, data.agentId);

  let result;
  if (data.parentId) {
    result = await client.replyToComment(data.postId, data.parentId, data.content);
  } else {
    result = await client.createComment(data.postId, data.content);
  }

  await platformAccounts.recordActivity(data.accountId);
  await agentActivity.logActivity({
    agentId: data.agentId,
    accountId: data.accountId,
    action: 'comment',
    params: { postId: data.postId, parentId: data.parentId },
    status: 'completed',
    result: { type: 'comment', commentId: result.id, postId: data.postId, isReply: !!data.parentId },
    timestamp: new Date().toISOString()
  });

  res.json(result);
}));

// POST /engage - One-click autonomous engagement cycle
router.post('/engage', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(engageSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🛠️ POST /api/agents/tools/engage agent=${data.agentId}`);

  const { client, agent } = await getClientAndAgent(data.accountId, data.agentId);

  // Import executeEngage pattern inline to avoid circular deps
  const { findReplyOpportunities } = await import('../services/agentFeedFilter.js');
  const { checkRateLimit } = await import('../integrations/moltbook/index.js');

  const relevantPosts = await findRelevantPosts(client, agent, {
    sort: 'hot',
    limit: 25,
    minScore: 1,
    maxResults: 10
  });

  const votes = [];
  const comments = [];
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Vote on relevant posts
  for (const post of relevantPosts) {
    if (votes.length >= data.maxVotes) break;

    const rateCheck = checkRateLimit(client.apiKey, 'vote');
    if (!rateCheck.allowed) break;

    await client.upvote(post.id);
    votes.push({ postId: post.id, title: post.title });
    await delay(1500);
  }

  // Comment on best matches
  if (data.maxComments > 0) {
    const opportunities = await findReplyOpportunities(client, agent, {
      sort: 'hot',
      minScore: 2,
      maxCandidates: data.maxComments + 2
    });

    for (const opportunity of opportunities) {
      if (comments.length >= data.maxComments) break;

      const rateCheck = checkRateLimit(client.apiKey, 'comment');
      if (!rateCheck.allowed) break;

      const generated = await generateComment(agent, opportunity.post, opportunity.comments);
      const result = await client.createComment(opportunity.post.id, generated.content);

      comments.push({
        postId: opportunity.post.id,
        postTitle: opportunity.post.title,
        commentId: result.id,
        content: generated.content,
        reason: opportunity.reason
      });
      await delay(1500);
    }
  }

  await platformAccounts.recordActivity(data.accountId);
  await agentActivity.logActivity({
    agentId: data.agentId,
    accountId: data.accountId,
    action: 'engage',
    params: { maxComments: data.maxComments, maxVotes: data.maxVotes },
    status: 'completed',
    result: { type: 'engage', postsReviewed: relevantPosts.length, votes, comments },
    timestamp: new Date().toISOString()
  });

  res.json({ postsReviewed: relevantPosts.length, votes, comments });
}));

// GET /feed - Browse Moltbook feed for an account
router.get('/feed', asyncHandler(async (req, res) => {
  const { accountId, sort = 'hot', limit = 25 } = req.query;

  if (!accountId) {
    throw new ServerError('accountId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`🛠️ GET /api/agents/tools/feed account=${accountId} sort=${sort}`);

  const account = await platformAccounts.getAccountWithCredentials(accountId);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }

  const client = new MoltbookClient(account.credentials.apiKey);
  const feed = await client.getFeed(sort, parseInt(limit, 10));
  res.json(feed);
}));

// GET /relevant-posts - Relevance-scored feed for an agent
router.get('/relevant-posts', asyncHandler(async (req, res) => {
  const { agentId, accountId, maxResults = 10 } = req.query;

  if (!agentId || !accountId) {
    throw new ServerError('agentId and accountId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`🛠️ GET /api/agents/tools/relevant-posts agent=${agentId}`);

  const { client, agent } = await getClientAndAgent(accountId, agentId);
  const posts = await findRelevantPosts(client, agent, { maxResults: parseInt(maxResults, 10) });
  res.json(posts);
}));

// GET /submolts - List available submolts
router.get('/submolts', asyncHandler(async (req, res) => {
  const { accountId } = req.query;

  if (!accountId) {
    throw new ServerError('accountId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`🛠️ GET /api/agents/tools/submolts account=${accountId}`);

  const account = await platformAccounts.getAccountWithCredentials(accountId);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }

  const client = new MoltbookClient(account.credentials.apiKey);
  const submolts = await client.getSubmolts();
  res.json(submolts);
}));

// GET /post/:postId - Get post details + comments
router.get('/post/:postId', asyncHandler(async (req, res) => {
  const { postId } = req.params;
  const { accountId } = req.query;

  if (!accountId) {
    throw new ServerError('accountId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`🛠️ GET /api/agents/tools/post/${postId}`);

  const account = await platformAccounts.getAccountWithCredentials(accountId);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }

  const client = new MoltbookClient(account.credentials.apiKey);
  const [post, commentsResponse] = await Promise.all([
    client.getPost(postId),
    client.getComments(postId)
  ]);

  res.json({
    ...post,
    comments: commentsResponse.comments || commentsResponse || []
  });
}));

// GET /rate-limits - Current rate limit status
router.get('/rate-limits', asyncHandler(async (req, res) => {
  const { accountId } = req.query;

  if (!accountId) {
    throw new ServerError('accountId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`🛠️ GET /api/agents/tools/rate-limits account=${accountId}`);

  const account = await platformAccounts.getAccountWithCredentials(accountId);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'NOT_FOUND' });
  }

  const client = new MoltbookClient(account.credentials.apiKey);
  const rateLimits = client.getRateLimitStatus();
  res.json(rateLimits);
}));

export default router;
