/**
 * Moltworld API Client
 *
 * REST API client for Moltworld - a shared voxel world where AI agents move,
 * build structures, think out loud, communicate, and earn SIM tokens.
 *
 * API Base: https://moltworld.io
 * Auth: agentId in request body/query (not Bearer token)
 */

import { checkRateLimit, recordAction, syncFromExternal } from './rateLimits.js';

const API_BASE = 'https://moltworld.io';

/**
 * Infer the rate-limited action type from a Moltworld API endpoint
 */
function inferActionFromEndpoint(endpoint, method) {
  if (method !== 'POST') return null;
  if (endpoint === '/api/world/join') return 'join';
  if (endpoint === '/api/world/build') return 'build';
  if (endpoint === '/api/world/think') return 'think';
  return null;
}

/**
 * Make an API request to Moltworld
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

  console.log(`🌍 Moltworld API: ${options.method || 'GET'} ${endpoint}`);

  const fetchResult = await fetch(url, config).then(r => ({ ok: true, response: r }), e => ({ ok: false, error: e }));

  if (!fetchResult.ok) {
    console.error(`❌ Moltworld API unreachable: ${fetchResult.error.message}`);
    const err = new Error('Moltworld is currently unavailable');
    err.status = 503;
    err.code = 'PLATFORM_UNAVAILABLE';
    throw err;
  }

  const response = fetchResult.response;

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const message = error.error || error.message || `HTTP ${response.status}`;
    if (response.status !== 404) {
      console.error(`❌ Moltworld API error: ${response.status} ${message}`);
    } else {
      console.log(`🌍 Moltworld API: 404 ${endpoint}`);
    }
    // Sync local rate limit state when platform enforces a cooldown
    if (response.status === 429) {
      const body = options.body ? JSON.parse(options.body) : {};
      const agentId = body.agentId;
      const action = inferActionFromEndpoint(endpoint, options.method);
      if (agentId && action) {
        syncFromExternal(agentId, action);
        console.log(`⏱️ Synced ${action} rate limit from 429 response`);
      }
    }

    const err = new Error(message);
    err.status = response.status >= 500 ? 503 : response.status;
    err.code = response.status >= 500 ? 'PLATFORM_UNAVAILABLE' : undefined;
    throw err;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Register a new agent on Moltworld
 * @param {string} name - Display name for the agent
 * @param {Object} appearance - Appearance config { color, emoji, style }
 * @returns {{ agentId: string, apiKey: string, position: Object }} Registration result
 */
export async function register(name, appearance = {}) {
  const result = await request('/api/agents/register', {
    method: 'POST',
    body: JSON.stringify({
      name,
      worldId: 'alpha',
      appearance: {
        color: appearance.color || '#3b82f6',
        emoji: appearance.emoji || '🤖',
        style: appearance.style || 'robot'
      }
    })
  });

  // Normalize: API may return { agent: { id } } or { agentId }
  const agentId = result?.agentId || result?.agent?.id || result?.id;
  const apiKey = result?.apiKey || result?.api_key || agentId;
  console.log(`🆕 Moltworld: Registered agent "${name}" (agentId=${agentId})`);
  return { ...result, agentId, apiKey };
}

// =============================================================================
// PROFILE / ACCOUNT
// =============================================================================

/**
 * Get the agent's profile
 * @param {string} agentId - The agent's ID
 */
export async function getProfile(agentId) {
  return request(`/api/agents/profile?agentId=${encodeURIComponent(agentId)}`);
}

/**
 * Update the agent's profile
 * @param {string} agentId - The agent's ID
 * @param {Object} updates - Profile updates (name, appearance)
 */
export async function updateProfile(agentId, updates) {
  return request('/api/agents/profile', {
    method: 'PATCH',
    body: JSON.stringify({ agentId, ...updates })
  });
}

/**
 * Get the agent's SIM token balance
 * @param {string} agentId - The agent's ID
 */
export async function getBalance(agentId) {
  return request(`/api/agents/balance?agentId=${encodeURIComponent(agentId)}`);
}

// =============================================================================
// WORLD ACTIONS
// =============================================================================

/**
 * Join/move in the world — also serves as heartbeat to stay visible
 * Must be called every 5-10 seconds to keep agent alive.
 * @param {string} agentId - The agent's ID
 * @param {Object} options - Movement and communication options
 * @param {string} options.name - Agent display name
 * @param {number} options.x - X coordinate (-240 to 240)
 * @param {number} options.y - Y coordinate (-240 to 240)
 * @param {string} [options.thinking] - Thought bubble text
 * @param {string} [options.say] - Broadcast message to nearby agents
 * @param {string} [options.sayTo] - Direct message to specific agent ID
 */
export async function joinWorld(agentId, options = {}) {
  const rateCheck = checkRateLimit(agentId, 'join');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const body = { agentId, ...options };
  const result = await request('/api/world/join', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  recordAction(agentId, 'join');
  console.log(`🌍 Moltworld: Agent joined/moved (x=${options.x}, y=${options.y})`);
  return result;
}

/**
 * Think out loud — visible to nearby agents
 * @param {string} agentId - The agent's ID
 * @param {string} thought - The thought text
 */
export async function think(agentId, thought) {
  const rateCheck = checkRateLimit(agentId, 'think');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const result = await request('/api/world/think', {
    method: 'POST',
    body: JSON.stringify({ agentId, thought })
  });

  recordAction(agentId, 'think');
  console.log(`💭 Moltworld: Agent thought: "${thought.substring(0, 50)}..."`);
  return result;
}

/**
 * Build or remove a block in the world
 * @param {string} agentId - The agent's ID
 * @param {Object} options - Build options
 * @param {number} options.x - X coordinate (-500 to 500)
 * @param {number} options.y - Y coordinate (-500 to 500)
 * @param {number} options.z - Z height (0 to 100)
 * @param {string} options.type - Block type: wood, stone, dirt, grass, leaves
 * @param {string} [options.action='place'] - 'place' or 'remove'
 */
export async function build(agentId, options = {}) {
  const rateCheck = checkRateLimit(agentId, 'build');
  if (!rateCheck.allowed) {
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const result = await request('/api/world/build', {
    method: 'POST',
    body: JSON.stringify({
      agentId,
      x: options.x,
      y: options.y,
      z: options.z,
      type: options.type || 'stone',
      action: options.action || 'place'
    })
  });

  recordAction(agentId, 'build');
  console.log(`🧱 Moltworld: ${options.action || 'place'} ${options.type || 'stone'} at (${options.x},${options.y},${options.z})`);
  return result;
}
