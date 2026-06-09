/**
 * Moltbook Integration
 *
 * This module provides integration with Moltbook - an AI agent social platform.
 * It's designed to be self-contained for easy extraction into a standalone app.
 *
 * @module integrations/moltbook
 */

// Re-export all API functions (including isAccountSuspended)
export * from './api.js';

// Re-export rate limit utilities
export {
  MOLTBOOK_RATE_LIMITS,
  checkRateLimit,
  recordAction,
  getRateLimitStatus,
  clearRateLimitState
} from './rateLimits.js';

// Export a convenience client class for stateful usage
import * as api from './api.js';
import { getRateLimitStatus } from './rateLimits.js';

/**
 * Create a Moltbook client for a specific agent account
 */
export function createMoltbookClient(apiKey) {
  let aiConfig = null;
  const client = {
    apiKey,
    get aiConfig() { return aiConfig; },
    set aiConfig(v) { aiConfig = v; },
    // Account
    getStatus: () => api.getStatus(apiKey),
    getProfile: () => api.getProfile(apiKey),
    updateProfile: (updates) => api.updateProfile(apiKey, updates),
    // Posts
    createPost: (submolt, title, content) => api.createPost(apiKey, submolt, title, content, aiConfig),
    getFeed: (sort, limit) => api.getFeed(apiKey, sort, limit),
    getPost: (postId) => api.getPost(apiKey, postId),
    getPostsByAuthor: (username) => api.getPostsByAuthor(apiKey, username),
    deletePost: (postId) => api.deletePost(apiKey, postId),
    // Comments
    createComment: (postId, content) => api.createComment(apiKey, postId, content, aiConfig),
    replyToComment: (postId, parentId, content) => api.replyToComment(apiKey, postId, parentId, content, aiConfig),
    getComments: (postId) => api.getComments(apiKey, postId),
    // Voting
    upvote: (postId) => api.upvote(apiKey, postId),
    downvote: (postId) => api.downvote(apiKey, postId),
    upvoteComment: (commentId) => api.upvoteComment(apiKey, commentId),
    // Social
    follow: (agentName) => api.follow(apiKey, agentName),
    unfollow: (agentName) => api.unfollow(apiKey, agentName),
    getAgentProfile: (agentName) => api.getAgentProfile(apiKey, agentName),
    getFollowers: () => api.getFollowers(apiKey),
    getFollowing: () => api.getFollowing(apiKey),
    // Heartbeat
    heartbeat: (options) => api.heartbeat(apiKey, options),
    // Submolts
    getSubmolts: () => api.getSubmolts(apiKey),
    getSubmolt: (name) => api.getSubmolt(apiKey, name),
    // Rate limits
    getRateLimitStatus: () => getRateLimitStatus(apiKey),
  };
  return client;
}

/** @deprecated Use createMoltbookClient() */
export const MoltbookClient = createMoltbookClient;

/**
 * Register a new agent on Moltbook (doesn't require an existing API key)
 */
export const registerMoltbookAgent = api.register;
