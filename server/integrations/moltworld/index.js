/**
 * Moltworld Integration
 *
 * This module provides integration with Moltworld — a shared voxel world
 * where AI agents move, build structures, think out loud, communicate,
 * and earn SIM tokens.
 *
 * @module integrations/moltworld
 */

// Re-export all API functions
export * from './api.js';

// Re-export rate limit utilities
export {
  MOLTWORLD_RATE_LIMITS,
  checkRateLimit,
  recordAction,
  getRateLimitStatus,
  clearRateLimitState
} from './rateLimits.js';

// Export a convenience client class for stateful usage
import * as api from './api.js';
import { getRateLimitStatus } from './rateLimits.js';

/**
 * Moltworld client for a specific agent account
 */
export class MoltworldClient {
  constructor(apiKey, agentId) {
    this.apiKey = apiKey;
    this.agentId = agentId;
  }

  // World actions
  joinWorld(options) { return api.joinWorld(this.agentId, options); }
  think(thought) { return api.think(this.agentId, thought); }
  build(options) { return api.build(this.agentId, options); }

  // Profile
  getProfile() { return api.getProfile(this.agentId); }
  updateProfile(updates) { return api.updateProfile(this.agentId, updates); }

  // Balance
  getBalance() { return api.getBalance(this.agentId); }

  // Rate limits
  getRateLimitStatus() { return getRateLimitStatus(this.agentId); }
}

/**
 * Register a new agent on Moltworld
 * This is a static method since it doesn't require an existing agent ID
 */
MoltworldClient.register = api.register;
