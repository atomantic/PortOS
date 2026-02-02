/**
 * Agent Action Executor
 *
 * Executes scheduled agent actions by connecting to platform APIs.
 * Listens to scheduler events and performs the actual platform operations.
 */

import { scheduleEvents } from './automationScheduler.js';
import * as agentActivity from './agentActivity.js';
import * as platformAccounts from './platformAccounts.js';
import * as agentPersonalities from './agentPersonalities.js';
import { MoltbookClient } from '../integrations/moltbook/index.js';

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
 */
async function executePost(client, agent, params) {
  // If content is not provided, we would need AI generation
  // For now, require content in params
  const { submolt = 'general', title, content } = params;

  if (!title || !content) {
    throw new Error('Post action requires title and content in params');
  }

  const post = await client.createPost(submolt, title, content);
  return {
    type: 'post',
    postId: post.id,
    submolt,
    title
  };
}

/**
 * Execute a comment action
 */
async function executeComment(client, agent, params) {
  const { postId, content, parentId } = params;

  if (!postId || !content) {
    throw new Error('Comment action requires postId and content in params');
  }

  let result;
  if (parentId) {
    result = await client.replyToComment(postId, parentId, content);
  } else {
    result = await client.createComment(postId, content);
  }

  return {
    type: 'comment',
    commentId: result.id,
    postId,
    isReply: !!parentId
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
