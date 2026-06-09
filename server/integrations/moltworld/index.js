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
 * Create a Moltworld client for a specific agent account
 */
export function createMoltworldClient(apiKey, agentId) {
  return {
    apiKey,
    agentId,
    // World actions
    joinWorld: (options) => api.joinWorld(agentId, options),
    think: (thought) => api.think(agentId, thought),
    build: (options) => api.build(agentId, options),
    // Profile
    getProfile: () => api.getProfile(agentId),
    updateProfile: (updates) => api.updateProfile(agentId, updates),
    // Balance
    getBalance: () => api.getBalance(agentId),
    // Rate limits
    getRateLimitStatus: () => getRateLimitStatus(agentId),
  };
}

/** @deprecated Use createMoltworldClient() */
export const MoltworldClient = createMoltworldClient;

/**
 * Register a new agent on Moltworld (doesn't require an existing agent ID)
 */
export const registerMoltworldAgent = api.register;
