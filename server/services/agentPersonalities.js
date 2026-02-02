/**
 * Agent Personalities Service
 *
 * Manages AI agent personalities - their identities, communication styles,
 * and behavioral traits. Each agent has a unique personality that informs
 * how they interact on social platforms.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

const AGENTS_DIR = PATHS.agentPersonalities;
const AGENTS_FILE = join(AGENTS_DIR, 'agents.json');

// Event emitter for agent personality changes
export const agentPersonalityEvents = new EventEmitter();

// In-memory cache
let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000;

async function ensureAgentsDir() {
  await ensureDir(AGENTS_DIR);
}

async function loadAgents() {
  const now = Date.now();

  if (cache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cache;
  }

  await ensureAgentsDir();

  if (!existsSync(AGENTS_FILE)) {
    cache = { agents: {} };
    cacheTimestamp = now;
    return cache;
  }

  const content = await readFile(AGENTS_FILE, 'utf-8');
  cache = JSON.parse(content);
  cacheTimestamp = now;
  return cache;
}

async function saveAgents(data) {
  await ensureAgentsDir();
  await writeFile(AGENTS_FILE, JSON.stringify(data, null, 2));
  cache = data;
  cacheTimestamp = Date.now();
}

export function invalidateCache() {
  cache = null;
  cacheTimestamp = 0;
}

export function notifyChanged(action = 'update', agentId = null) {
  agentPersonalityEvents.emit('changed', { action, agentId, timestamp: Date.now() });
}

/**
 * Get all agent personalities
 */
export async function getAllAgents() {
  const data = await loadAgents();
  return Object.entries(data.agents).map(([id, agent]) => ({ id, ...agent }));
}

/**
 * Get all agents for a specific user
 */
export async function getAgentsByUser(userId) {
  const agents = await getAllAgents();
  return agents.filter(agent => agent.userId === userId);
}

/**
 * Get agent by ID
 */
export async function getAgentById(id) {
  const data = await loadAgents();
  const agent = data.agents[id];
  return agent ? { id, ...agent } : null;
}

/**
 * Create a new agent personality
 */
export async function createAgent(agentData) {
  const data = await loadAgents();
  const id = uuidv4();
  const now = new Date().toISOString();

  const agent = {
    userId: agentData.userId,
    name: agentData.name,
    description: agentData.description || '',
    personality: {
      style: agentData.personality.style,
      tone: agentData.personality.tone,
      topics: agentData.personality.topics || [],
      quirks: agentData.personality.quirks || [],
      promptPrefix: agentData.personality.promptPrefix || ''
    },
    avatar: agentData.avatar || {},
    enabled: agentData.enabled !== false,
    createdAt: now,
    updatedAt: now
  };

  data.agents[id] = agent;
  await saveAgents(data);
  notifyChanged('create', id);

  console.log(`🤖 Created agent personality: ${agent.name} (${id})`);
  return { id, ...agent };
}

/**
 * Update an existing agent personality
 */
export async function updateAgent(id, updates) {
  const data = await loadAgents();

  if (!data.agents[id]) {
    return null;
  }

  // Remove id from updates if present
  const { id: _id, createdAt: _createdAt, ...cleanUpdates } = updates;

  // Handle nested personality updates properly
  const existingPersonality = data.agents[id].personality || {};
  const updatedPersonality = cleanUpdates.personality
    ? { ...existingPersonality, ...cleanUpdates.personality }
    : existingPersonality;

  const agent = {
    ...data.agents[id],
    ...cleanUpdates,
    personality: updatedPersonality,
    createdAt: data.agents[id].createdAt,
    updatedAt: new Date().toISOString()
  };

  data.agents[id] = agent;
  await saveAgents(data);
  notifyChanged('update', id);

  console.log(`📝 Updated agent personality: ${agent.name} (${id})`);
  return { id, ...agent };
}

/**
 * Delete an agent personality
 */
export async function deleteAgent(id) {
  const data = await loadAgents();

  if (!data.agents[id]) {
    return false;
  }

  const agentName = data.agents[id].name;
  delete data.agents[id];
  await saveAgents(data);
  notifyChanged('delete', id);

  console.log(`🗑️ Deleted agent personality: ${agentName} (${id})`);
  return true;
}

/**
 * Toggle agent enabled status
 */
export async function toggleAgent(id, enabled) {
  return updateAgent(id, { enabled });
}

/**
 * Get agent count by user
 */
export async function getAgentCount(userId = null) {
  const agents = await getAllAgents();
  if (userId) {
    return agents.filter(a => a.userId === userId).length;
  }
  return agents.length;
}
