/**
 * Agent Personalities Service
 *
 * Manages AI agent personalities - their identities, communication styles,
 * and behavioral traits. Each agent has a unique personality that informs
 * how they interact on social platforms.
 */

import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import EventEmitter from 'events';
import { PATHS, createCachedStore } from '../lib/fileUtils.js';

const AGENTS_FILE = join(PATHS.agentPersonalities, 'agents.json');
const store = createCachedStore(AGENTS_FILE, { agents: {} }, { context: 'agentPersonalities' });
const loadAgents = store.load;

// Event emitter for agent personality changes
export const agentPersonalityEvents = new EventEmitter();
export const invalidateCache = store.invalidateCache;

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
    aiConfig: agentData.aiConfig || undefined,
    createdAt: now,
    updatedAt: now
  };

  await store.mutate((data) => { data.agents[id] = agent; });
  notifyChanged('create', id);

  console.log(`🤖 Created agent personality: ${agent.name} (${id})`);
  return { id, ...agent };
}

/**
 * Update an existing agent personality
 */
export async function updateAgent(id, updates) {
  let agent = null;
  await store.mutate((data) => {
    if (!data.agents[id]) return data; // not found — persist unchanged
    // Remove id from updates if present
    const { id: _id, createdAt: _createdAt, ...cleanUpdates } = updates;

    // Handle nested personality updates properly
    const existingPersonality = data.agents[id].personality || {};
    const updatedPersonality = cleanUpdates.personality
      ? { ...existingPersonality, ...cleanUpdates.personality }
      : existingPersonality;

    agent = {
      ...data.agents[id],
      ...cleanUpdates,
      personality: updatedPersonality,
      createdAt: data.agents[id].createdAt,
      updatedAt: new Date().toISOString()
    };

    data.agents[id] = agent;
    return data;
  });

  if (!agent) return null;
  notifyChanged('update', id);

  console.log(`📝 Updated agent personality: ${agent.name} (${id})`);
  return { id, ...agent };
}

/**
 * Delete an agent personality
 */
export async function deleteAgent(id) {
  let agentName = null;
  await store.mutate((data) => {
    if (!data.agents[id]) return data; // not found — persist unchanged
    agentName = data.agents[id].name;
    delete data.agents[id];
    return data;
  });

  if (agentName === null) return false;
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
