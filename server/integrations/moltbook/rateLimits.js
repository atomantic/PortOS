/**
 * Moltbook Rate Limits
 *
 * Rate limit configuration for Moltbook API actions.
 * These limits are enforced by the platform - exceeding them will result in errors.
 */

export const MOLTBOOK_RATE_LIMITS = {
  post: {
    cooldownMs: 30 * 60 * 1000, // 30 minutes between posts
    maxPerDay: 48               // Maximum posts per day
  },
  comment: {
    cooldownMs: 20 * 1000,      // 20 seconds between comments
    maxPerDay: 50               // Maximum comments per day
  },
  vote: {
    cooldownMs: 1 * 1000,       // 1 second between votes
    maxPerDay: 200              // Maximum votes per day
  },
  follow: {
    cooldownMs: 5 * 1000,       // 5 seconds between follows
    maxPerDay: 100              // Maximum follows per day
  }
};

// In-memory rate limit tracking per API key
const rateLimitState = new Map();

/**
 * Get rate limit state for an API key
 */
function getState(apiKey) {
  if (!rateLimitState.has(apiKey)) {
    rateLimitState.set(apiKey, {
      post: { lastAction: 0, todayCount: 0, dayStart: Date.now() },
      comment: { lastAction: 0, todayCount: 0, dayStart: Date.now() },
      vote: { lastAction: 0, todayCount: 0, dayStart: Date.now() },
      follow: { lastAction: 0, todayCount: 0, dayStart: Date.now() }
    });
  }

  const state = rateLimitState.get(apiKey);
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
 * Check if an action is rate limited
 * @param {string} apiKey - The API key to check
 * @param {string} action - The action type (post, comment, vote, follow)
 * @returns {{ allowed: boolean, waitMs?: number, reason?: string }}
 */
export function checkRateLimit(apiKey, action) {
  const limits = MOLTBOOK_RATE_LIMITS[action];
  if (!limits) {
    return { allowed: true };
  }

  const state = getState(apiKey);
  const actionState = state[action];
  const now = Date.now();

  // Check daily limit
  if (actionState.todayCount >= limits.maxPerDay) {
    return {
      allowed: false,
      reason: `Daily limit reached (${limits.maxPerDay}/${action}s per day)`,
      waitMs: state[action].dayStart + 24 * 60 * 60 * 1000 - now
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
 * @param {string} apiKey - The API key
 * @param {string} action - The action type
 */
export function recordAction(apiKey, action) {
  const state = getState(apiKey);
  if (state[action]) {
    state[action].lastAction = Date.now();
    state[action].todayCount++;
  }
}

/**
 * Get current rate limit status for all actions
 * @param {string} apiKey - The API key
 * @returns {Object} Status for each action type
 */
export function getRateLimitStatus(apiKey) {
  const state = getState(apiKey);
  const now = Date.now();
  const status = {};

  for (const [action, limits] of Object.entries(MOLTBOOK_RATE_LIMITS)) {
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

  return status;
}

/**
 * Clear rate limit state for an API key (e.g., on account deletion)
 * @param {string} apiKey - The API key
 */
export function clearRateLimitState(apiKey) {
  rateLimitState.delete(apiKey);
}
