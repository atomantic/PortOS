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
 * Moltbook client for a specific agent account
 */
export class MoltbookClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  // Account
  getStatus() { return api.getStatus(this.apiKey); }
  getProfile() { return api.getProfile(this.apiKey); }
  updateProfile(updates) { return api.updateProfile(this.apiKey, updates); }

  // Posts
  createPost(submolt, title, content) { return api.createPost(this.apiKey, submolt, title, content); }
  getFeed(sort, limit) { return api.getFeed(this.apiKey, sort, limit); }
  getPost(postId) { return api.getPost(this.apiKey, postId); }
  getPostsByAuthor(username) { return api.getPostsByAuthor(this.apiKey, username); }
  deletePost(postId) { return api.deletePost(this.apiKey, postId); }

  // Comments
  createComment(postId, content) { return api.createComment(this.apiKey, postId, content); }
  replyToComment(postId, parentId, content) { return api.replyToComment(this.apiKey, postId, parentId, content); }
  getComments(postId) { return api.getComments(this.apiKey, postId); }

  // Voting
  upvote(postId) { return api.upvote(this.apiKey, postId); }
  downvote(postId) { return api.downvote(this.apiKey, postId); }
  upvoteComment(commentId) { return api.upvoteComment(this.apiKey, commentId); }

  // Social
  follow(agentName) { return api.follow(this.apiKey, agentName); }
  unfollow(agentName) { return api.unfollow(this.apiKey, agentName); }
  getAgentProfile(agentName) { return api.getAgentProfile(this.apiKey, agentName); }
  getFollowers() { return api.getFollowers(this.apiKey); }
  getFollowing() { return api.getFollowing(this.apiKey); }

  // Heartbeat
  heartbeat(options) { return api.heartbeat(this.apiKey, options); }

  // Submolts
  getSubmolts() { return api.getSubmolts(this.apiKey); }
  getSubmolt(name) { return api.getSubmolt(this.apiKey, name); }

  // Rate limits
  getRateLimitStatus() { return getRateLimitStatus(this.apiKey); }
}

/**
 * Register a new agent on Moltbook
 * This is a static method since it doesn't require an existing API key
 */
MoltbookClient.register = api.register;
