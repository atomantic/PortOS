import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';

const DRAFTS_FILE = join(PATHS.messages, 'drafts.json');

async function loadDrafts() {
  await ensureDir(PATHS.messages);
  const content = await readFile(DRAFTS_FILE, 'utf-8').catch(() => null);
  if (!content) return [];
  const parsed = safeJSONParse(content, [], { context: 'messageDrafts' });
  return Array.isArray(parsed) ? parsed : [];
}

async function saveDrafts(drafts) {
  await ensureDir(PATHS.messages);
  await writeFile(DRAFTS_FILE, JSON.stringify(drafts, null, 2));
}

export async function listDrafts(filters = {}) {
  let drafts = await loadDrafts();
  if (filters.accountId) drafts = drafts.filter(d => d.accountId === filters.accountId);
  if (filters.status) drafts = drafts.filter(d => d.status === filters.status);
  return drafts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getDraft(id) {
  const drafts = await loadDrafts();
  return drafts.find(d => d.id === id) || null;
}

export async function createDraft(data) {
  const drafts = await loadDrafts();
  const draft = {
    id: uuidv4(),
    accountId: data.accountId,
    replyToMessageId: data.replyToMessageId || null,
    threadId: data.threadId || null,
    to: data.to || [],
    cc: data.cc || [],
    subject: data.subject || '',
    body: data.body || '',
    status: 'draft',
    generatedBy: data.generatedBy || 'manual',
    sendVia: data.sendVia || 'api',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  drafts.push(draft);
  await saveDrafts(drafts);
  console.log(`📝 Message draft created: "${draft.subject}" via ${draft.sendVia}`);
  return draft;
}

export async function updateDraft(id, updates) {
  const drafts = await loadDrafts();
  const idx = drafts.findIndex(d => d.id === id);
  if (idx === -1) return null;
  const allowed = ['to', 'cc', 'subject', 'body', 'status'];
  for (const key of allowed) {
    if (updates[key] !== undefined) drafts[idx][key] = updates[key];
  }
  drafts[idx].updatedAt = new Date().toISOString();
  await saveDrafts(drafts);
  return drafts[idx];
}

export async function approveDraft(id) {
  return updateDraft(id, { status: 'approved' });
}

export async function deleteDraftsByAccountId(accountId) {
  const drafts = await loadDrafts();
  const remaining = drafts.filter(d => d.accountId !== accountId);
  if (remaining.length < drafts.length) {
    await saveDrafts(remaining);
    console.log(`🗑️ Deleted ${drafts.length - remaining.length} drafts for account ${accountId}`);
  }
}

export async function deleteDraft(id) {
  const drafts = await loadDrafts();
  const idx = drafts.findIndex(d => d.id === id);
  if (idx === -1) return false;
  drafts.splice(idx, 1);
  await saveDrafts(drafts);
  console.log(`🗑️ Message draft deleted: ${id}`);
  return true;
}
