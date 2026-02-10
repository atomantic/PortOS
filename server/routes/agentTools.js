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
  engageSchema,
  checkPostsSchema,
  createDraftSchema,
  updateDraftSchema
} from '../lib/validation.js';
import * as platformAccounts from '../services/platformAccounts.js';
import * as agentPersonalities from '../services/agentPersonalities.js';
import * as agentActivity from '../services/agentActivity.js';
import * as agentDrafts from '../services/agentDrafts.js';
import { generatePost, generateComment, generateReply } from '../services/agentContentGenerator.js';
import { findRelevantPosts } from '../services/agentFeedFilter.js';
import { MoltbookClient } from '../integrations/moltbook/index.js';
import { collectPublishedPosts } from '../services/agentPublished.js';

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
  const result = await client.createPost(data.submolt, data.title, data.content);
  const post = result?.post || result;
  const postId = post?.id || post?._id || post?.post_id;

  await platformAccounts.recordActivity(data.accountId);
  await agentActivity.logActivity({
    agentId: data.agentId,
    accountId: data.accountId,
    action: 'post',
    params: { submolt: data.submolt, title: data.title },
    status: 'completed',
    result: { type: 'post', postId, submolt: data.submolt, title: data.title },
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
    result: { type: 'comment', commentId: result?.id || result?._id || result?.comment_id, postId: data.postId, isReply: !!data.parentId },
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
        postId: opportunity.post.id || opportunity.post._id,
        postTitle: opportunity.post.title,
        commentId: result?.id || result?._id || result?.comment_id,
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

// GET /published - Aggregate published content across multiple days
router.get('/published', asyncHandler(async (req, res) => {
  const { agentId, accountId, days = '7' } = req.query;

  if (!agentId || !accountId) {
    throw new ServerError('agentId and accountId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const numDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 30);
  console.log(`🛠️ GET /api/agents/tools/published agent=${agentId} days=${numDays}`);

  const { client } = await getClientAndAgent(accountId, agentId);

  const { postMap, commentMap } = await collectPublishedPosts(agentId, numDays);

  // Fetch live engagement for posts (only for those with postId)
  const posts = Array.from(postMap.values());
  const postsWithId = posts.filter(p => p.postId);
  const postResults = await Promise.allSettled(
    postsWithId.map(p => client.getPost(p.postId))
  );

  const liveDataMap = {};
  postsWithId.forEach((post, i) => {
    if (postResults[i].status === 'fulfilled') {
      liveDataMap[post.postId] = postResults[i].value;
    }
  });

  const enrichedPosts = posts.map(post => {
    const live = post.postId ? liveDataMap[post.postId] : null;
    return {
      ...post,
      score: live?.score ?? null,
      commentCount: live?.commentCount ?? null,
      url: post.postId ? `https://www.moltbook.com/post/${post.postId}` : null
    };
  }).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Enrich comments with post titles where missing
  const comments = Array.from(commentMap.values());
  const missingTitlePostIds = [...new Set(
    comments.filter(c => !c.postTitle && c.postId).map(c => c.postId)
  )];
  const titleResults = await Promise.allSettled(
    missingTitlePostIds.map(id => client.getPost(id))
  );
  const titleMap = {};
  missingTitlePostIds.forEach((id, i) => {
    if (titleResults[i].status === 'fulfilled') {
      titleMap[id] = titleResults[i].value.title;
    }
  });

  const enrichedComments = comments.map(c => ({
    ...c,
    postTitle: c.postTitle || titleMap[c.postId] || 'Unknown post',
    url: c.postId ? `https://www.moltbook.com/post/${c.postId}` : null
  })).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  res.json({ posts: enrichedPosts, comments: enrichedComments });
}));

// POST /check-posts - Check engagement on published posts and respond
router.post('/check-posts', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(checkPostsSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`👀 POST /api/agents/tools/check-posts agent=${data.agentId} days=${data.days}`);

  const { client, agent, account } = await getClientAndAgent(data.accountId, data.agentId);
  const { checkRateLimit, isAccountSuspended } = await import('../integrations/moltbook/index.js');

  const agentUsername = account.credentials.username;

  // Fetch posts directly from Moltbook API — more reliable than activity logs
  const allPosts = await client.getPostsByAuthor(agentUsername);

  // Filter to posts within the requested day range
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - data.days);
  const posts = allPosts.filter(p => new Date(p.created_at) >= cutoff);

  console.log(`👀 Found ${allPosts.length} total posts by ${agentUsername}, ${posts.length} within ${data.days} days`);
  const upvoted = [];
  const replied = [];
  const skipped = [];
  let totalComments = 0;
  let newComments = 0;
  let suspended = false;
  const delayMs = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  for (const post of posts) {
    if (suspended) break;

    const postId = post.id;
    const commentsResponse = await client.getComments(postId).catch(e => {
      if (isAccountSuspended(e)) suspended = true;
      return { comments: [] };
    });
    if (suspended) break;

    const allComments = commentsResponse.comments || commentsResponse || [];
    totalComments += allComments.length;

    // Filter to comments NOT by the agent
    const otherComments = allComments.filter(c => {
      const authorName = typeof c.author === 'object' ? c.author?.name : c.author;
      return authorName !== agentUsername;
    });
    newComments += otherComments.length;

    for (const comment of otherComments) {
      if (suspended) break;

      // Upvote positive comments
      if (upvoted.length < data.maxUpvotes) {
        const rateCheck = checkRateLimit(client.apiKey, 'vote');
        if (rateCheck.allowed) {
          const voted = await client.upvoteComment(comment.id).catch(e => {
            if (isAccountSuspended(e)) suspended = true;
            else console.log(`👀 Upvote failed for comment ${comment.id}: ${e.message}`);
            return null;
          });
          if (suspended) break;
          if (voted) {
            upvoted.push({
              commentId: comment.id,
              postId,
              postTitle: post.title,
              snippet: (comment.content || '').substring(0, 80)
            });
          }
          await delayMs(1500);
        }
      }

      // Generate replies for top comments
      if (!suspended && replied.length < data.maxReplies) {
        const rateCheck = checkRateLimit(client.apiKey, 'comment');
        if (rateCheck.allowed) {
          const generated = await generateReply(agent, post, comment);
          const replyResult = await client.replyToComment(postId, comment.id, generated.content).catch(e => {
            if (isAccountSuspended(e)) suspended = true;
            else console.log(`👀 Reply failed on post ${postId}: ${e.message}`);
            return null;
          });
          if (suspended) break;
          if (replyResult) {
            replied.push({
              commentId: comment.id,
              replyId: replyResult?.id || replyResult?._id || replyResult?.comment_id,
              postId,
              postTitle: post.title,
              snippet: (comment.content || '').substring(0, 80),
              reply: generated.content
            });
          }
          await delayMs(1500);
        }
      }

      if (upvoted.length >= data.maxUpvotes && replied.length >= data.maxReplies) break;
    }
  }

  // If account was suspended, mark it and halt early
  if (suspended) {
    console.log(`🚫 Account ${agentUsername} suspended — halting monitor, marking account`);
    await platformAccounts.updateAccountStatus(data.accountId, 'suspended');
  }

  await platformAccounts.recordActivity(data.accountId);
  await agentActivity.logActivity({
    agentId: data.agentId,
    accountId: data.accountId,
    action: 'monitor',
    params: { days: data.days, maxReplies: data.maxReplies, maxUpvotes: data.maxUpvotes },
    status: suspended ? 'failed' : 'completed',
    error: suspended ? 'Account suspended by platform' : undefined,
    result: { type: 'monitor', postsChecked: posts.length, totalComments, newComments, upvoted, replied },
    timestamp: new Date().toISOString()
  });

  console.log(`👀 Monitor ${suspended ? 'aborted (suspended)' : 'complete'} for "${agent.name}": ${posts.length} posts, ${newComments} new comments, ${upvoted.length} upvotes, ${replied.length} replies`);

  res.json({ postsChecked: posts.length, suspended, engagement: { totalComments, newComments, upvoted, replied, skipped } });
}));

// =============================================================================
// DRAFTS
// =============================================================================

// GET /drafts - List drafts for an agent
router.get('/drafts', asyncHandler(async (req, res) => {
  const { agentId } = req.query;
  if (!agentId) {
    throw new ServerError('agentId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`🛠️ GET /api/agents/tools/drafts agent=${agentId}`);
  const drafts = await agentDrafts.listDrafts(agentId);
  res.json(drafts);
}));

// POST /drafts - Create a draft
router.post('/drafts', asyncHandler(async (req, res) => {
  const { success, data, errors } = validate(createDraftSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🛠️ POST /api/agents/tools/drafts agent=${data.agentId} type=${data.type}`);
  const draft = await agentDrafts.createDraft(data.agentId, data);
  res.status(201).json(draft);
}));

// PUT /drafts/:draftId - Update a draft
router.put('/drafts/:draftId', asyncHandler(async (req, res) => {
  const { draftId } = req.params;
  const { agentId } = req.query;
  if (!agentId) {
    throw new ServerError('agentId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const { success, data, errors } = validate(updateDraftSchema, req.body);
  if (!success) {
    throw new ServerError('Validation failed', { status: 400, code: 'VALIDATION_ERROR', context: { errors } });
  }

  console.log(`🛠️ PUT /api/agents/tools/drafts/${draftId} agent=${agentId}`);
  const updated = await agentDrafts.updateDraft(agentId, draftId, data);
  if (!updated) {
    throw new ServerError('Draft not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(updated);
}));

// DELETE /drafts/:draftId - Delete a draft
router.delete('/drafts/:draftId', asyncHandler(async (req, res) => {
  const { draftId } = req.params;
  const { agentId } = req.query;
  if (!agentId) {
    throw new ServerError('agentId required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  console.log(`🛠️ DELETE /api/agents/tools/drafts/${draftId} agent=${agentId}`);
  const deleted = await agentDrafts.deleteDraft(agentId, draftId);
  if (!deleted) {
    throw new ServerError('Draft not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

export default router;
