/**
 * Agent Drafts Service
 *
 * Persists generated content as drafts per agent.
 * Drafts are stored as JSON files: data/agents/drafts/{agentId}.json
 */

import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { atomicWrite, ensureDir, PATHS, readJSONFileStrict, unreadableStoreError } from '../lib/fileUtils.js';
import { isTopLevelEntryName } from '../lib/pathSafety.js';
import { ServerError } from '../lib/errorHandler.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';

// Serializes each load→modify→save per agent so overlapping saves can't clobber each other.
const draftQueue = createKeyCachedQueue();

const DRAFTS_DIR = join(PATHS.agentPersonalities, 'drafts');

function assertValidAgentId(agentId) {
  // agentId comes straight from a query string / body; it names the file, so it
  // must be a single path segment (no `../` walk out of the drafts directory).
  if (!isTopLevelEntryName(agentId)) {
    throw new ServerError('Invalid agentId', { status: 400, code: 'VALIDATION_ERROR' });
  }
}

// Validate before queueing so a bad id is refused without touching the queue.
async function mutateDrafts(agentId, work) {
  assertValidAgentId(agentId);
  return draftQueue(agentId, work);
}

async function getDraftsPath(agentId) {
  assertValidAgentId(agentId);
  await ensureDir(DRAFTS_DIR);
  return join(DRAFTS_DIR, `${agentId}.json`);
}

async function loadDrafts(agentId) {
  const filePath = await getDraftsPath(agentId);
  // Absent initializes to []; an unreadable file throws so no caller can save over it.
  const { ok, value } = await readJSONFileStrict(filePath, []);
  if (!ok) throw unreadableStoreError(filePath);
  return value;
}

async function saveDrafts(agentId, drafts) {
  const filePath = await getDraftsPath(agentId);
  await atomicWrite(filePath, drafts);
}

/**
 * List all drafts for an agent
 */
export async function listDrafts(agentId) {
  const drafts = await loadDrafts(agentId);
  return drafts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Get a single draft by ID
 */
export async function getDraft(agentId, draftId) {
  const drafts = await loadDrafts(agentId);
  return drafts.find(d => d.id === draftId) || null;
}

/**
 * Save a new draft
 */
export function createDraft(agentId, draft) {
  return mutateDrafts(agentId, () => createDraftUnlocked(agentId, draft));
}

async function createDraftUnlocked(agentId, draft) {
  const drafts = await loadDrafts(agentId);
  const entry = {
    id: uuidv4(),
    type: draft.type, // 'post' or 'comment'
    status: 'draft',
    title: draft.title || null,
    content: draft.content,
    submolt: draft.submolt || null,
    postId: draft.postId || null,
    parentId: draft.parentId || null,
    postTitle: draft.postTitle || null,
    accountId: draft.accountId || null,
    createdAt: new Date().toISOString()
  };

  drafts.push(entry);
  await saveDrafts(agentId, drafts);
  console.log(`📋 Draft saved for agent ${agentId}: ${entry.type} "${entry.title || entry.content?.substring(0, 40)}..."`);
  return entry;
}

/**
 * Update an existing draft
 */
export function updateDraft(agentId, draftId, updates) {
  return mutateDrafts(agentId, () => updateDraftUnlocked(agentId, draftId, updates));
}

async function updateDraftUnlocked(agentId, draftId, updates) {
  const drafts = await loadDrafts(agentId);
  const idx = drafts.findIndex(d => d.id === draftId);
  if (idx === -1) return null;

  drafts[idx] = {
    ...drafts[idx],
    ...updates,
    updatedAt: new Date().toISOString()
  };
  await saveDrafts(agentId, drafts);
  return drafts[idx];
}

/**
 * Delete a draft
 */
export function deleteDraft(agentId, draftId) {
  return mutateDrafts(agentId, () => deleteDraftUnlocked(agentId, draftId));
}

async function deleteDraftUnlocked(agentId, draftId) {
  const drafts = await loadDrafts(agentId);
  const filtered = drafts.filter(d => d.id !== draftId);
  if (filtered.length === drafts.length) return false;
  await saveDrafts(agentId, filtered);
  console.log(`🗑️ Draft deleted for agent ${agentId}: ${draftId}`);
  return true;
}
