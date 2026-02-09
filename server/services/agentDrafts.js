/**
 * Agent Drafts Service
 *
 * Persists generated content as drafts per agent.
 * Drafts are stored as JSON files: data/agents/drafts/{agentId}.json
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

const DRAFTS_DIR = join(PATHS.agentPersonalities, 'drafts');

async function getDraftsPath(agentId) {
  await ensureDir(DRAFTS_DIR);
  return join(DRAFTS_DIR, `${agentId}.json`);
}

async function loadDrafts(agentId) {
  const filePath = await getDraftsPath(agentId);
  const content = await readFile(filePath, 'utf-8').catch(() => null);
  if (!content) return [];
  return JSON.parse(content);
}

async function saveDrafts(agentId, drafts) {
  const filePath = await getDraftsPath(agentId);
  await writeFile(filePath, JSON.stringify(drafts, null, 2));
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
export async function createDraft(agentId, draft) {
  const drafts = await loadDrafts(agentId);
  const entry = {
    id: uuidv4(),
    type: draft.type, // 'post' or 'comment'
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
export async function updateDraft(agentId, draftId, updates) {
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
export async function deleteDraft(agentId, draftId) {
  const drafts = await loadDrafts(agentId);
  const filtered = drafts.filter(d => d.id !== draftId);
  if (filtered.length === drafts.length) return false;
  await saveDrafts(agentId, filtered);
  console.log(`🗑️ Draft deleted for agent ${agentId}: ${draftId}`);
  return true;
}
