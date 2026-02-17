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
import { MoltbookClient, checkRateLimit, isAccountSuspended } from '../integrations/moltbook/index.js';
import { MoltworldClient } from '../integrations/moltworld/index.js';
import { generatePost, generateComment, generateReply } from './agentContentGenerator.js';
import { findRelevantPosts, findReplyOpportunities } from './agentFeedFilter.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Execute an action based on type
 */
async function executeAction(schedule, account, agent) {
  const { action } = schedule;

  // Dispatch to platform-specific handler
  if (account.platform === 'moltworld') {
    return executeMoltworldAction(action, account, agent);
  }

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

    case 'monitor':
      return executeMonitor(client, agent, schedule, action.params);

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
    const contentConfig = agent.aiConfig?.content || agent.aiConfig;
    const generated = await generatePost(agent, { submolt }, contentConfig?.providerId, contentConfig?.model);
    title = generated.title;
    content = generated.content;
  }

  if (!title || !content) {
    throw new Error('Post action requires title and content in params (or aiGenerate enabled)');
  }

  const result = await client.createPost(submolt, title, content);
  const post = result?.post || result;
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

    const contentConfig = agent.aiConfig?.content || agent.aiConfig;

    // AI generate comment if no content
    if (!content) {
      console.log(`🤖 AI generating comment for "${agent.name}" on post ${postId}`);
      const generated = await generateComment(agent, pick.post, pick.comments, null, contentConfig?.providerId, contentConfig?.model);
      content = generated.content;
    }
  } else if (!content) {
    // Have postId but no content - generate it
    console.log(`🤖 AI generating comment for "${agent.name}" on post ${postId}`);
    const post = await client.getPost(postId);
    const commentsResponse = await client.getComments(postId);
    const comments = commentsResponse.comments || commentsResponse || [];
    const contentConfig = agent.aiConfig?.content || agent.aiConfig;

    if (parentId) {
      const parent = comments.find(c => c.id === parentId);
      if (parent) {
        const generated = await generateReply(agent, post, parent, null, contentConfig?.providerId, contentConfig?.model);
        content = generated.content;
      } else {
        const generated = await generateComment(agent, post, comments, null, contentConfig?.providerId, contentConfig?.model);
        content = generated.content;
      }
    } else {
      const generated = await generateComment(agent, post, comments, null, contentConfig?.providerId, contentConfig?.model);
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

  const engagementConfig = agent.aiConfig?.engagement || agent.aiConfig;

  console.log(`🤝 Starting engage for "${agent.name}" (maxComments=${maxComments}, maxVotes=${maxVotes})`);

  const relevantPosts = await findRelevantPosts(client, agent, {
    sort: 'hot',
    limit: 25,
    minScore: 1,
    maxResults: 10
  });

  const votes = [];
  const comments = [];
  let suspended = false;

  // Vote on relevant posts
  for (const post of relevantPosts) {
    if (votes.length >= maxVotes || suspended) break;

    const rateCheck = checkRateLimit(client.apiKey, 'vote');
    if (!rateCheck.allowed) break;

    await client.upvote(post.id).catch(e => {
      if (isAccountSuspended(e)) suspended = true;
    });
    if (suspended) break;
    votes.push({ postId: post.id, title: post.title });
    await delay(1500);
  }

  // Comment on best matches
  if (maxComments > 0 && !suspended) {
    const opportunities = await findReplyOpportunities(client, agent, {
      sort: 'hot',
      minScore: 2,
      maxCandidates: maxComments + 2
    });

    for (const opportunity of opportunities) {
      if (comments.length >= maxComments || suspended) break;

      const rateCheck = checkRateLimit(client.apiKey, 'comment');
      if (!rateCheck.allowed) break;

      const generated = await generateComment(agent, opportunity.post, opportunity.comments, null, engagementConfig?.providerId, engagementConfig?.model);
      await client.createComment(opportunity.post.id, generated.content).catch(e => {
        if (isAccountSuspended(e)) suspended = true;
      });
      if (suspended) break;

      comments.push({
        postId: opportunity.post.id || opportunity.post._id,
        postTitle: opportunity.post.title,
        reason: opportunity.reason
      });
      await delay(1500);
    }
  }

  if (suspended) {
    console.log(`🚫 Account suspended during engage — halting`);
  }

  console.log(`🤝 Engage ${suspended ? 'aborted (suspended)' : 'complete'} for "${agent.name}": ${votes.length} votes, ${comments.length} comments`);

  return {
    type: 'engage',
    postsReviewed: relevantPosts.length,
    votes,
    comments,
    suspended
  };
}

/**
 * Execute a monitor action - check engagement on published posts and respond
 */
async function executeMonitor(client, agent, schedule, params) {
  const { days = 7, maxReplies = 2, maxUpvotes = 10 } = params;

  const engagementConfig = agent.aiConfig?.engagement || agent.aiConfig;

  console.log(`👀 Starting monitor for "${agent.name}" (days=${days}, maxReplies=${maxReplies}, maxUpvotes=${maxUpvotes})`);

  const account = await platformAccounts.getAccountWithCredentials(schedule.accountId);
  const agentUsername = account?.credentials?.username;

  // Fetch posts directly from Moltbook API
  const allPosts = await client.getPostsByAuthor(agentUsername);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const posts = allPosts.filter(p => new Date(p.created_at) >= cutoff);

  console.log(`👀 Found ${allPosts.length} total posts by ${agentUsername}, ${posts.length} within ${days} days`);

  const upvoted = [];
  const replied = [];
  let totalComments = 0;
  let newComments = 0;
  let suspended = false;

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

    const otherComments = allComments.filter(c => {
      const authorName = typeof c.author === 'object' ? c.author?.name : c.author;
      return authorName !== agentUsername;
    });
    newComments += otherComments.length;

    for (const comment of otherComments) {
      if (suspended) break;

      if (upvoted.length < maxUpvotes) {
        const rateCheck = checkRateLimit(client.apiKey, 'vote');
        if (rateCheck.allowed) {
          await client.upvoteComment(comment.id).catch(e => {
            if (isAccountSuspended(e)) suspended = true;
          });
          if (suspended) break;
          upvoted.push({ commentId: comment.id, postId, postTitle: post.title });
          await delay(1500);
        }
      }

      if (!suspended && replied.length < maxReplies) {
        const rateCheck = checkRateLimit(client.apiKey, 'comment');
        if (rateCheck.allowed) {
          const generated = await generateReply(agent, post, comment, null, engagementConfig?.providerId, engagementConfig?.model);
          await client.replyToComment(postId, comment.id, generated.content).catch(e => {
            if (isAccountSuspended(e)) suspended = true;
          });
          if (suspended) break;
          replied.push({
            commentId: comment.id,
            postId,
            postTitle: post.title
          });
          await delay(1500);
        }
      }

      if (upvoted.length >= maxUpvotes && replied.length >= maxReplies) break;
    }
  }

  if (suspended) {
    console.log(`🚫 Account ${agentUsername} suspended — halting monitor, marking account`);
    await platformAccounts.updateAccountStatus(schedule.accountId, 'suspended');
  }

  console.log(`👀 Monitor ${suspended ? 'aborted (suspended)' : 'complete'} for "${agent.name}": ${posts.length} posts, ${newComments} new comments, ${upvoted.length} upvotes, ${replied.length} replies`);

  return {
    type: 'monitor',
    postsChecked: posts.length,
    totalComments,
    newComments,
    upvoted,
    replied,
    suspended
  };
}

// =============================================================================
// MOLTWORLD ACTION HANDLERS
// =============================================================================

/**
 * Dispatch a Moltworld action
 */
async function executeMoltworldAction(action, account, agent) {
  const client = new MoltworldClient(
    account.credentials.apiKey,
    account.credentials.agentId
  );

  switch (action.type) {
    case 'mw_heartbeat':
      return executeMoltworldHeartbeat(client, account, action.params);

    case 'mw_explore':
      return executeMoltworldExplore(client, account, action.params);

    case 'mw_build':
      return executeMoltworldBuild(client, action.params);

    case 'mw_say':
      return executeMoltworldSay(client, action.params);

    case 'mw_think':
      return executeMoltworldThink(client, action.params);

    case 'mw_interact':
      return executeMoltworldInteract(client, account, action.params);

    default:
      throw new Error(`Unknown Moltworld action type: ${action.type}`);
  }
}

/**
 * Moltworld heartbeat — join/move to stay visible
 */
async function executeMoltworldHeartbeat(client, account, params) {
  const x = params.x ?? 0;
  const y = params.y ?? 0;

  const result = await client.joinWorld({
    name: account.credentials.username,
    x,
    y
  });

  console.log(`💓 Moltworld: Heartbeat for ${account.credentials.username} at (${x}, ${y})`);

  return {
    type: 'mw_heartbeat',
    x,
    y,
    nearby: result?.nearby?.length || 0
  };
}

/**
 * Moltworld explore — move to coordinates and think
 */
async function executeMoltworldExplore(client, account, params) {
  const x = params.x ?? Math.floor(Math.random() * 480) - 240;
  const y = params.y ?? Math.floor(Math.random() * 480) - 240;
  const thinking = params.thinking || `Exploring area (${x}, ${y})...`;

  const result = await client.joinWorld({
    name: account.credentials.username,
    x,
    y,
    thinking
  });

  console.log(`🌍 Moltworld: Explore to (${x}, ${y}) for ${account.credentials.username}`);

  return {
    type: 'mw_explore',
    x,
    y,
    thinking,
    nearby: result?.nearby?.length || 0
  };
}

/**
 * Moltworld build — place or remove blocks
 */
async function executeMoltworldBuild(client, params) {
  const result = await client.build({
    x: params.x || 0,
    y: params.y || 0,
    z: params.z || 0,
    type: params.type || 'stone',
    action: params.action || 'place'
  });

  return {
    type: 'mw_build',
    ...result
  };
}

/**
 * Moltworld say — broadcast or direct message via join
 */
async function executeMoltworldSay(client, params) {
  const result = await client.joinWorld({
    name: params.name || 'Agent',
    x: params.x ?? 0,
    y: params.y ?? 0,
    say: params.message,
    sayTo: params.sayTo
  });

  console.log(`💬 Moltworld: Said "${(params.message || '').substring(0, 50)}"`);

  return {
    type: 'mw_say',
    message: params.message,
    sayTo: params.sayTo,
    nearby: result?.nearby?.length || 0
  };
}

/**
 * Moltworld think — send a thought
 */
async function executeMoltworldThink(client, params) {
  const result = await client.think(params.thought || 'Thinking...');
  console.log(`💭 Moltworld: Thought "${(params.thought || '').substring(0, 50)}"`);
  return { type: 'mw_think', thought: params.thought };
}

/**
 * Moltworld interact — compound action: move, think, optionally build
 */
async function executeMoltworldInteract(client, account, params) {
  const x = params.x ?? Math.floor(Math.random() * 480) - 240;
  const y = params.y ?? Math.floor(Math.random() * 480) - 240;

  // Move and think
  const moveResult = await client.joinWorld({
    name: account.credentials.username,
    x,
    y,
    thinking: params.thinking || `Looking around (${x}, ${y})...`
  });

  const results = { type: 'mw_interact', x, y, nearby: moveResult?.nearby?.length || 0 };

  // Optionally build
  if (params.buildType) {
    await delay(1500);
    const buildResult = await client.build({
      x,
      y,
      z: params.z || 0,
      type: params.buildType,
      action: 'place'
    });
    results.built = buildResult;
  }

  console.log(`🤝 Moltworld: Interact at (${x}, ${y}) for ${account.credentials.username}`);
  return results;
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
