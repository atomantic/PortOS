/**
 * Moltworld Rate Limits
 *
 * Rate limit configuration for Moltworld API actions.
 * These limits are enforced by the platform — exceeding them will result in errors.
 * Global limit: 60 requests/minute per agent.
 */

export const MOLTWORLD_RATE_LIMITS = {
  join: {
    cooldownMs: 5 * 1000,        // 5 seconds between joins (heartbeat)
    maxPerDay: 17280              // Generous — agents call every 5-10s
  },
  build: {
    cooldownMs: 1 * 1000,        // 1 second between builds
    maxPerDay: 500                // Maximum builds per day
  },
  think: {
    cooldownMs: 5 * 1000,        // 5 seconds between thoughts
    maxPerDay: 1000               // Maximum thoughts per day
  }
};

// Global rate limit: 60 requests per minute per agent
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_MAX_REQUESTS = 60;

// In-memory rate limit tracking per agent ID
const rateLimitState = new Map();
const globalRateState = new Map();

/**
 * Get rate limit state for an agent ID
 */
function getState(agentId) {
  if (!rateLimitState.has(agentId)) {
    rateLimitState.set(agentId, {
      join: { lastAction: 0, todayCount: 0, dayStart: Date.now() },
      build: { lastAction: 0, todayCount: 0, dayStart: Date.now() },
      think: { lastAction: 0, todayCount: 0, dayStart: Date.now() }
    });
  }

  const state = rateLimitState.get(agentId);
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Reset daily counters if day has changed
  for (const action of Object.keys(state)) {
    if (now - state[action].dayStart > oneDayMs) {
      state[action].todayCount = 0;
      state[action].dayStart = now;
    }
  }

  return state;
}

/**
 * Get global rate limit state for an agent
 */
function getGlobalState(agentId) {
  if (!globalRateState.has(agentId)) {
    globalRateState.set(agentId, []);
  }
  const timestamps = globalRateState.get(agentId);
  const now = Date.now();
  // Prune timestamps outside the window
  const pruned = timestamps.filter(t => now - t < GLOBAL_WINDOW_MS);
  globalRateState.set(agentId, pruned);
  return pruned;
}

/**
 * Check if an action is rate limited
 * @param {string} agentId - The agent ID to check
 * @param {string} action - The action type (join, build, think)
 * @returns {{ allowed: boolean, waitMs?: number, reason?: string }}
 */
export function checkRateLimit(agentId, action) {
  // Check global rate limit first
  const globalTimestamps = getGlobalState(agentId);
  if (globalTimestamps.length >= GLOBAL_MAX_REQUESTS) {
    const oldestInWindow = globalTimestamps[0];
    return {
      allowed: false,
      reason: `Global rate limit (${GLOBAL_MAX_REQUESTS}/min)`,
      waitMs: GLOBAL_WINDOW_MS - (Date.now() - oldestInWindow)
    };
  }

  const limits = MOLTWORLD_RATE_LIMITS[action];
  if (!limits) {
    return { allowed: true };
  }

  const state = getState(agentId);
  const actionState = state[action];
  const now = Date.now();

  // Check daily limit
  if (actionState.todayCount >= limits.maxPerDay) {
    return {
      allowed: false,
      reason: `Daily limit reached (${limits.maxPerDay}/${action}s per day)`,
      waitMs: actionState.dayStart + 24 * 60 * 60 * 1000 - now
    };
  }

  // Check cooldown
  const timeSinceLast = now - actionState.lastAction;
  if (timeSinceLast < limits.cooldownMs) {
    return {
      allowed: false,
      reason: `Cooldown active (${Math.ceil(limits.cooldownMs / 1000)}s between ${action}s)`,
      waitMs: limits.cooldownMs - timeSinceLast
    };
  }

  return { allowed: true };
}

/**
 * Record an action for rate limiting
 * @param {string} agentId - The agent ID
 * @param {string} action - The action type
 */
export function recordAction(agentId, action) {
  // Record per-action state
  const state = getState(agentId);
  if (state[action]) {
    state[action].lastAction = Date.now();
    state[action].todayCount++;
  }

  // Record in global sliding window
  const globalTimestamps = getGlobalState(agentId);
  globalTimestamps.push(Date.now());
}

/**
 * Get current rate limit status for all actions
 * @param {string} agentId - The agent ID
 * @returns {Object} Status for each action type
 */
export function getRateLimitStatus(agentId) {
  const state = getState(agentId);
  const now = Date.now();
  const status = {};

  for (const [action, limits] of Object.entries(MOLTWORLD_RATE_LIMITS)) {
    const actionState = state[action];
    const timeSinceLast = now - actionState.lastAction;
    const cooldownRemaining = Math.max(0, limits.cooldownMs - timeSinceLast);

    status[action] = {
      todayCount: actionState.todayCount,
      maxPerDay: limits.maxPerDay,
      remaining: limits.maxPerDay - actionState.todayCount,
      cooldownMs: limits.cooldownMs,
      cooldownRemainingMs: cooldownRemaining,
      canAct: actionState.todayCount < limits.maxPerDay && cooldownRemaining === 0
    };
  }

  // Add global rate info
  const globalTimestamps = getGlobalState(agentId);
  status._global = {
    requestsInWindow: globalTimestamps.length,
    maxPerMinute: GLOBAL_MAX_REQUESTS,
    remaining: GLOBAL_MAX_REQUESTS - globalTimestamps.length
  };

  return status;
}

/**
 * Sync local rate limit state from a platform 429 response
 * @param {string} agentId - The agent ID
 * @param {string} action - The action type
 */
export function syncFromExternal(agentId, action) {
  const state = getState(agentId);
  if (state[action]) {
    state[action].lastAction = Date.now();
  }
}

/**
 * Clear rate limit state for an agent ID (e.g., on account deletion)
 * @param {string} agentId - The agent ID
 */
export function clearRateLimitState(agentId) {
  rateLimitState.delete(agentId);
  globalRateState.delete(agentId);
}
