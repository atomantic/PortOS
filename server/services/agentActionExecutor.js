/**
 * Agent Action Executor
 *
 * Executes scheduled agent actions by connecting to platform APIs.
 * Listens to scheduler events and performs the actual platform operations.
 * Supports AI-generated content when params are missing.
 */

import { scheduleEvents } from './automationScheduler.js';
import * as agentActivity from './agentActivity.js';
import * as platformAccounts from './platformAccounts.js';
import * as agentPersonalities from './agentPersonalities.js';
import { MoltbookClient, checkRateLimit } from '../integrations/moltbook/index.js';
import { generatePost, generateComment, generateReply } from './agentContentGenerator.js';
import { findRelevantPosts, findReplyOpportunities } from './agentFeedFilter.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Execute an action based on type
 */
async function executeAction(schedule, account, agent) {
  const { action } = schedule;
  const client = new MoltbookClient(account.credentials.apiKey);

  switch (action.type) {
    case 'heartbeat':
      return executeHeartbeat(client, action.params);

    case 'post':
      return executePost(client, agent, action.params);

    case 'comment':
      return executeComment(client, agent, action.params);

    case 'vote':
      return executeVote(client, action.params);

    case 'engage':
      return executeEngage(client, agent, action.params);

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

/**
 * Execute a heartbeat action - browse and engage naturally
 */
async function executeHeartbeat(client, params) {
  const options = {
    engageChance: params.engageChance || 0.3,
    maxEngagements: params.maxEngagements || 3
  };

  const result = await client.heartbeat(options);
  return {
    type: 'heartbeat',
    ...result
  };
}

/**
 * Execute a post action
 * When title/content missing, uses AI generation
 */
async function executePost(client, agent, params) {
  const { submolt = 'general', aiGenerate } = params;
  let { title, content } = params;

  // AI generate if content not provided
  if ((!title || !content) && aiGenerate !== false) {
    console.log(`🤖 AI generating post content for "${agent.name}"`);
    const generated = await generatePost(agent, { submolt });
    title = generated.title;
    content = generated.content;
  }

  if (!title || !content) {
    throw new Error('Post action requires title and content in params (or aiGenerate enabled)');
  }

  const post = await client.createPost(submolt, title, content);
  return {
    type: 'post',
    postId: post?.id || post?._id || post?.post_id,
    submolt,
    title,
    generated: !params.title || !params.content
  };
}

/**
 * Execute a comment action
 * When postId missing, finds relevant post. When content missing, uses AI generation.
 */
async function executeComment(client, agent, params) {
  let { postId, content, parentId } = params;

  // Find a relevant post if no postId specified
  if (!postId) {
    console.log(`🔍 Finding relevant post for "${agent.name}" to comment on`);
    const opportunities = await findReplyOpportunities(client, agent, { maxCandidates: 3 });

    if (opportunities.length === 0) {
      return { type: 'comment', action: 'none', reason: 'no relevant posts found' };
    }

    const pick = opportunities[0];
    postId = pick.post.id;

    // AI generate comment if no content
    if (!content) {
      console.log(`🤖 AI generating comment for "${agent.name}" on post ${postId}`);
      const generated = await generateComment(agent, pick.post, pick.comments);
      content = generated.content;
    }
  } else if (!content) {
    // Have postId but no content - generate it
    console.log(`🤖 AI generating comment for "${agent.name}" on post ${postId}`);
    const post = await client.getPost(postId);
    const commentsResponse = await client.getComments(postId);
    const comments = commentsResponse.comments || commentsResponse || [];

    if (parentId) {
      const parent = comments.find(c => c.id === parentId);
      if (parent) {
        const generated = await generateReply(agent, post, parent);
        content = generated.content;
      } else {
        const generated = await generateComment(agent, post, comments);
        content = generated.content;
      }
    } else {
      const generated = await generateComment(agent, post, comments);
      content = generated.content;
    }
  }

  if (!postId || !content) {
    throw new Error('Comment action requires postId and content');
  }

  let result;
  if (parentId) {
    result = await client.replyToComment(postId, parentId, content);
  } else {
    result = await client.createComment(postId, content);
  }

  return {
    type: 'comment',
    commentId: result?.id || result?._id || result?.comment_id,
    postId,
    isReply: !!parentId,
    generated: !params.content
  };
}

/**
 * Execute a vote action
 */
async function executeVote(client, params) {
  const { postId, commentId, direction = 'up' } = params;

  if (!postId && !commentId) {
    // No specific target - upvote from feed
    const feed = await client.getFeed('hot', 10);
    const posts = feed.posts || [];

    if (posts.length === 0) {
      return { type: 'vote', action: 'none', reason: 'no posts in feed' };
    }

    // Pick a random post to upvote
    const randomPost = posts[Math.floor(Math.random() * posts.length)];
    await client.upvote(randomPost.id);

    return {
      type: 'vote',
      action: 'upvote',
      postId: randomPost.id,
      title: randomPost.title
    };
  }

  if (commentId) {
    await client.upvoteComment(commentId);
    return { type: 'vote', action: 'upvote', commentId };
  }

  if (direction === 'up') {
    await client.upvote(postId);
  } else {
    await client.downvote(postId);
  }

  return { type: 'vote', action: direction === 'up' ? 'upvote' : 'downvote', postId };
}

/**
 * Execute an engage action - compound autonomous browsing, voting, and commenting
 */
async function executeEngage(client, agent, params) {
  const { maxComments = 1, maxVotes = 3 } = params;

  console.log(`🤝 Starting engage for "${agent.name}" (maxComments=${maxComments}, maxVotes=${maxVotes})`);

  const relevantPosts = await findRelevantPosts(client, agent, {
    sort: 'hot',
    limit: 25,
    minScore: 1,
    maxResults: 10
  });

  const votes = [];
  const comments = [];

  // Vote on relevant posts
  for (const post of relevantPosts) {
    if (votes.length >= maxVotes) break;

    const rateCheck = checkRateLimit(client.apiKey, 'vote');
    if (!rateCheck.allowed) break;

    await client.upvote(post.id);
    votes.push({ postId: post.id, title: post.title });
    await delay(1500);
  }

  // Comment on best matches
  if (maxComments > 0) {
    const opportunities = await findReplyOpportunities(client, agent, {
      sort: 'hot',
      minScore: 2,
      maxCandidates: maxComments + 2
    });

    for (const opportunity of opportunities) {
      if (comments.length >= maxComments) break;

      const rateCheck = checkRateLimit(client.apiKey, 'comment');
      if (!rateCheck.allowed) break;

      const generated = await generateComment(agent, opportunity.post, opportunity.comments);
      const result = await client.createComment(opportunity.post.id, generated.content);

      comments.push({
        postId: opportunity.post.id || opportunity.post._id,
        postTitle: opportunity.post.title,
        commentId: result?.id || result?._id || result?.comment_id,
        reason: opportunity.reason
      });
      await delay(1500);
    }
  }

  console.log(`🤝 Engage complete for "${agent.name}": ${votes.length} votes, ${comments.length} comments`);

  return {
    type: 'engage',
    postsReviewed: relevantPosts.length,
    votes,
    comments
  };
}

/**
 * Initialize the action executor
 * Listens to scheduler events and executes actions
 */
export function init() {
  scheduleEvents.on('execute', async ({ scheduleId, schedule, timestamp }) => {
    console.log(`⚡ Executing scheduled action: ${schedule.action.type} (${scheduleId})`);

    // Get account with full credentials
    const account = await platformAccounts.getAccountWithCredentials(schedule.accountId);
    if (!account) {
      console.error(`❌ Account not found: ${schedule.accountId}`);
      await agentActivity.logActivity({
        agentId: schedule.agentId,
        accountId: schedule.accountId,
        scheduleId,
        action: schedule.action.type,
        params: schedule.action.params,
        status: 'failed',
        error: 'Account not found',
        timestamp
      });
      return;
    }

    // Check account status
    if (account.status !== 'active') {
      console.log(`⏸️ Skipping action - account not active: ${account.status}`);
      await agentActivity.logActivity({
        agentId: schedule.agentId,
        accountId: schedule.accountId,
        scheduleId,
        action: schedule.action.type,
        params: schedule.action.params,
        status: 'skipped',
        error: `Account status: ${account.status}`,
        timestamp
      });
      return;
    }

    // Get agent personality
    const agent = await agentPersonalities.getAgentById(schedule.agentId);
    if (!agent) {
      console.error(`❌ Agent not found: ${schedule.agentId}`);
      return;
    }

    // Check if agent is enabled
    if (!agent.enabled) {
      console.log(`⏸️ Skipping action - agent disabled`);
      await agentActivity.logActivity({
        agentId: schedule.agentId,
        accountId: schedule.accountId,
        scheduleId,
        action: schedule.action.type,
        params: schedule.action.params,
        status: 'skipped',
        error: 'Agent disabled',
        timestamp
      });
      return;
    }

    // Execute the action
    const startTime = Date.now();
    let result = null;
    let error = null;

    try {
      result = await executeAction(schedule, account, agent);
      console.log(`✅ Action completed: ${schedule.action.type}`);
    } catch (err) {
      error = err.message;
      console.error(`❌ Action failed: ${err.message}`);
    }

    // Record activity
    await platformAccounts.recordActivity(schedule.accountId);

    // Log completion
    await agentActivity.logActivity({
      agentId: schedule.agentId,
      accountId: schedule.accountId,
      scheduleId,
      action: schedule.action.type,
      params: schedule.action.params,
      status: error ? 'failed' : 'completed',
      result,
      error,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime
    });
  });

  console.log('⚡ Agent action executor initialized');
}
