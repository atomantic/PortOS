/**
 * Moltbook API Client
 *
 * REST API client for Moltbook - an AI agent social platform.
 * All actions are performed via their REST API (no browser automation needed).
 *
 * API Base: https://www.moltbook.com/api/v1
 */

import { checkRateLimit, recordAction } from './rateLimits.js';
import { solveChallenge } from './challengeSolver.js';

const API_BASE = 'https://www.moltbook.com/api/v1';

/**
 * Handle a Moltbook verification challenge embedded in a response
 * Challenges are obfuscated math word problems that must be solved within 5 minutes.
 */
async function handleVerification(data, apiKey) {
  if (!data?.verification_required || !data?.verification) return data;

  const { code, challenge, expires_at } = data.verification;
  console.log(`🔐 Moltbook verification required: code=${code}, expires=${expires_at}`);
  console.log(`🔐 Challenge: "${challenge.substring(0, 100)}..."`);

  const answer = await solveChallenge(challenge);
  if (!answer) {
    console.error(`❌ Could not solve Moltbook challenge — post will remain pending`);
    return data;
  }

  console.log(`🔐 Submitting verification: code=${code} answer=${answer}`);

  const resp = await fetch(`${API_BASE}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ verification_code: code, answer })
  });

  const result = await resp.json().catch(() => ({}));
  if (resp.ok && result.success !== false) {
    console.log(`✅ Moltbook verification passed: ${result.message || 'verified'}`);
    data.verification_solved = true;
  } else {
    console.error(`❌ Moltbook verification failed: ${resp.status} ${result.error || result.message || 'unknown'}`);
    data.verification_solved = false;
  }

  return data;
}

/**
 * Make an API request to Moltbook
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  };

  console.log(`📚 Moltbook API: ${options.method || 'GET'} ${endpoint}`);

  const response = await fetch(url, config);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const message = error.error || error.message || `HTTP ${response.status}`;
    console.error(`❌ Moltbook API error: ${response.status} ${message}`);
    const err = new Error(message);
    err.status = response.status;
    err.suspended = response.status === 403 && message.toLowerCase().includes('suspended');
    throw err;
  }

  if (response.status === 204) {
    return null;
  }

  const data = await response.json();

  // Auto-solve verification challenges embedded in responses
  const apiKey = config.headers?.['Authorization']?.replace('Bearer ', '');
  if (apiKey) await handleVerification(data, apiKey);

  return data;
}

/**
 * Make an authenticated API request
 */
async function authRequest(apiKey, endpoint, options = {}) {
  return request(endpoint, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${apiKey}`
    }
  });
}

// =============================================================================
// ACCOUNT MANAGEMENT
// =============================================================================

/**
 * Register a new agent account on Moltbook
 * @param {string} name - Display name for the agent
 * @param {string} description - Bio/description
 * @returns {{ api_key: string, claim_url: string }} Registration result
 */
export async function register(name, description = '') {
  // Moltbook requires alphanumeric usernames with underscores/hyphens (3-30 chars)
  const username = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
  const result = await request('/agents/register', {
    method: 'POST',
    body: JSON.stringify({ name: username, description })
  });

  console.log(`🆕 Moltbook: Registered agent "${username}"`);
  return result;
}

/**
 * Get the status of an agent account
 * @param {string} apiKey - The agent's API key
 * @returns {{ status: 'pending_claim' | 'claimed' | 'active' | 'suspended' }}
 */
export async function getStatus(apiKey) {
  return authRequest(apiKey, '/agents/status');
}

/**
 * Get the agent's profile
 * @param {string} apiKey - The agent's API key
 */
export async function getProfile(apiKey) {
  return authRequest(apiKey, '/agents/me');
}

/**
 * Update the agent's profile
 * @param {string} apiKey - The agent's API key
 * @param {Object} updates - Profile updates
 */
export async function updateProfile(apiKey, updates) {
  return authRequest(apiKey, '/agents/me', {
    method: 'PUT',
    body: JSON.stringify(updates)
  });
}

// =============================================================================
// POSTS
// =============================================================================

/**
 * Create a new post
 * @param {string} apiKey - The agent's API key
 * @param {string} submolt - The submolt (subreddit-like) to post in
 * @param {string} title - Post title
 * @param {string} content - Post content (markdown)
 * @returns {Object} Created post
 */
export async function createPost(apiKey, submolt, title, content) {
  // Check rate limit
  const rateCheck = checkRateLimit(apiKey, 'post');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const result = await authRequest(apiKey, '/posts', {
    method: 'POST',
    body: JSON.stringify({ submolt, title, content })
  });

  recordAction(apiKey, 'post');
  const postId = result?.id || result?._id || result?.post_id;
  console.log(`📝 Moltbook: Created post "${title}" in ${submolt} (id=${postId}, keys=${Object.keys(result || {}).join(',')})`);
  return result;
}

/**
 * Get the feed
 * @param {string} apiKey - The agent's API key
 * @param {'hot' | 'new' | 'top' | 'rising'} sort - Sort order
 * @param {number} limit - Number of posts to fetch
 */
export async function getFeed(apiKey, sort = 'hot', limit = 25) {
  return authRequest(apiKey, `/feed?sort=${sort}&limit=${limit}`);
}

/**
 * Get posts by a specific author
 * @param {string} apiKey - The agent's API key
 * @param {string} username - The author's username
 */
export async function getPostsByAuthor(apiKey, username) {
  const result = await authRequest(apiKey, `/posts?author=${encodeURIComponent(username)}`);
  return result.posts || result || [];
}

/**
 * Delete a post
 * @param {string} apiKey - The agent's API key
 * @param {string} postId - The post ID to delete
 */
export async function deletePost(apiKey, postId) {
  return authRequest(apiKey, `/posts/${postId}`, { method: 'DELETE' });
}

/**
 * Get a specific post
 * @param {string} apiKey - The agent's API key
 * @param {string} postId - The post ID
 */
export async function getPost(apiKey, postId) {
  return authRequest(apiKey, `/posts/${postId}`);
}

// =============================================================================
// COMMENTS
// =============================================================================

/**
 * Create a comment on a post
 * @param {string} apiKey - The agent's API key
 * @param {string} postId - The post ID
 * @param {string} content - Comment content (markdown)
 */
export async function createComment(apiKey, postId, content) {
  // Check rate limit
  const rateCheck = checkRateLimit(apiKey, 'comment');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const result = await authRequest(apiKey, `/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content })
  });

  recordAction(apiKey, 'comment');
  console.log(`💬 Moltbook: Commented on post ${postId}`);
  return result;
}

/**
 * Reply to a comment
 * @param {string} apiKey - The agent's API key
 * @param {string} postId - The post ID
 * @param {string} parentId - The parent comment ID
 * @param {string} content - Reply content (markdown)
 */
export async function replyToComment(apiKey, postId, parentId, content) {
  // Check rate limit
  const rateCheck = checkRateLimit(apiKey, 'comment');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const result = await authRequest(apiKey, `/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content, parentId })
  });

  recordAction(apiKey, 'comment');
  console.log(`↩️ Moltbook: Replied to comment ${parentId}`);
  return result;
}

/**
 * Get comments for a post
 * @param {string} apiKey - The agent's API key
 * @param {string} postId - The post ID
 */
export async function getComments(apiKey, postId) {
  return authRequest(apiKey, `/posts/${postId}/comments`);
}

// =============================================================================
// VOTING
// =============================================================================

/**
 * Upvote a post
 * @param {string} apiKey - The agent's API key
 * @param {string} postId - The post ID
 */
export async function upvote(apiKey, postId) {
  // Check rate limit
  const rateCheck = checkRateLimit(apiKey, 'vote');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const result = await authRequest(apiKey, `/posts/${postId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ direction: 'up' })
  });

  recordAction(apiKey, 'vote');
  console.log(`👍 Moltbook: Upvoted post ${postId}`);
  return result;
}

/**
 * Downvote a post
 * @param {string} apiKey - The agent's API key
 * @param {string} postId - The post ID
 */
export async function downvote(apiKey, postId) {
  // Check rate limit
  const rateCheck = checkRateLimit(apiKey, 'vote');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const result = await authRequest(apiKey, `/posts/${postId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ direction: 'down' })
  });

  recordAction(apiKey, 'vote');
  console.log(`👎 Moltbook: Downvoted post ${postId}`);
  return result;
}

/**
 * Upvote a comment
 * @param {string} apiKey - The agent's API key
 * @param {string} commentId - The comment ID
 */
export async function upvoteComment(apiKey, commentId) {
  // Check rate limit
  const rateCheck = checkRateLimit(apiKey, 'vote');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const result = await authRequest(apiKey, `/comments/${commentId}/upvote`, {
    method: 'POST'
  });

  recordAction(apiKey, 'vote');
  console.log(`👍 Moltbook: Upvoted comment ${commentId}`);
  return result;
}

// =============================================================================
// SOCIAL
// =============================================================================

/**
 * Follow an agent
 * @param {string} apiKey - The agent's API key
 * @param {string} agentName - The agent to follow
 */
export async function follow(apiKey, agentName) {
  // Check rate limit
  const rateCheck = checkRateLimit(apiKey, 'follow');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const result = await authRequest(apiKey, `/agents/${agentName}/follow`, {
    method: 'POST'
  });

  recordAction(apiKey, 'follow');
  console.log(`➕ Moltbook: Followed agent ${agentName}`);
  return result;
}

/**
 * Unfollow an agent
 * @param {string} apiKey - The agent's API key
 * @param {string} agentName - The agent to unfollow
 */
export async function unfollow(apiKey, agentName) {
  const result = await authRequest(apiKey, `/agents/${agentName}/follow`, {
    method: 'DELETE'
  });

  console.log(`➖ Moltbook: Unfollowed agent ${agentName}`);
  return result;
}

/**
 * Get an agent's public profile
 * @param {string} apiKey - The agent's API key
 * @param {string} agentName - The agent name to look up
 */
export async function getAgentProfile(apiKey, agentName) {
  return authRequest(apiKey, `/agents/${agentName}`);
}

/**
 * Get followers
 * @param {string} apiKey - The agent's API key
 */
export async function getFollowers(apiKey) {
  return authRequest(apiKey, '/agents/me/followers');
}

/**
 * Get following
 * @param {string} apiKey - The agent's API key
 */
export async function getFollowing(apiKey) {
  return authRequest(apiKey, '/agents/me/following');
}

// =============================================================================
// HEARTBEAT / ACTIVITY
// =============================================================================

/**
 * Perform a "heartbeat" - browse and potentially engage
 * This is a compound action that:
 * 1. Fetches the feed
 * 2. Optionally upvotes interesting content
 * 3. Returns activity summary
 *
 * @param {string} apiKey - The agent's API key
 * @param {Object} options - Heartbeat options
 * @returns {Object} Activity summary
 */
export async function heartbeat(apiKey, options = {}) {
  const { engageChance = 0.3, maxEngagements = 3 } = options;

  console.log(`💓 Moltbook: Starting heartbeat`);

  // Get feed
  const feed = await getFeed(apiKey, 'hot', 25);
  const posts = feed.posts || [];

  let engagements = 0;
  const engaged = [];

  // Randomly engage with some posts
  for (const post of posts) {
    if (engagements >= maxEngagements) break;
    if (Math.random() > engageChance) continue;

    // Check if we can still vote
    const rateCheck = checkRateLimit(apiKey, 'vote');
    if (!rateCheck.allowed) break;

    // Upvote the post
    await upvote(apiKey, post.id);
    engaged.push({ type: 'upvote', postId: post.id, title: post.title });
    engagements++;

    // Small delay between actions
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`💓 Moltbook: Heartbeat complete - ${engagements} engagements`);

  return {
    feedSize: posts.length,
    engagements,
    engaged
  };
}

// =============================================================================
// SUBMOLTS
// =============================================================================

/**
 * Get list of submolts
 * @param {string} apiKey - The agent's API key
 */
export async function getSubmolts(apiKey) {
  return authRequest(apiKey, '/submolts');
}

/**
 * Get a specific submolt
 * @param {string} apiKey - The agent's API key
 * @param {string} submoltName - The submolt name
 */
export async function getSubmolt(apiKey, submoltName) {
  return authRequest(apiKey, `/submolts/${submoltName}`);
}

/**
 * Check if an error indicates account suspension
 * @param {Error} error - The error to check
 * @returns {boolean}
 */
export function isAccountSuspended(error) {
  return error?.suspended || (error?.status === 403 && error?.message?.toLowerCase().includes('suspended'));
}
