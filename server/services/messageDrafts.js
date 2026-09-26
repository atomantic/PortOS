
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { atomicWrite, ensureDir, PATHS, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

const DRAFTS_FILE = join(PATHS.messages, 'drafts.json');

// Serialize every read-modify-write of drafts.json onto a single tail so two
// concurrent createDraft/updateDraft/delete calls can't read the same snapshot and
// have one atomic rename clobber the other's just-persisted draft. This matters
// now that Tribe outreach (#2158) permits several draft generations in flight at
// once — each finishing LLM call lands its own createDraft.
const queueWrite = createFileWriteQueue();

async function loadDrafts() {
  await ensureDir(PATHS.messages);
  const content = await tryReadFile(DRAFTS_FILE);
  if (!content) return [];
  const parsed = safeJSONParse(content, [], { context: 'messageDrafts' });
  return Array.isArray(parsed) ? parsed : [];
}

async function saveDrafts(drafts) {
  await atomicWrite(DRAFTS_FILE, drafts);
}

export async function listDrafts(filters = {}) {
  let drafts = await loadDrafts();
  if (filters.accountId) drafts = drafts.filter(d => d.accountId === filters.accountId);
  if (filters.status) {
    // `status` accepts a single value or an array (OR filter), so callers like
    // the review-queue aggregator can push a multi-status query down to the
    // data layer instead of loading every draft and filtering in memory.
    // An explicit empty array means "match no status" → returns nothing,
    // rather than collapsing back to "no filter".
    const wanted = Array.isArray(filters.status) ? filters.status : [filters.status];
    drafts = drafts.filter(d => wanted.includes(d.status));
  }
  return drafts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getDraft(id) {
  const drafts = await loadDrafts();
  return drafts.find(d => d.id === id) || null;
}

export async function createDraft(data) {
  return queueWrite(async () => {
    const drafts = await loadDrafts();
    const draft = {
      id: uuidv4(),
      accountId: data.accountId,
      replyToMessageId: data.replyToMessageId || null,
      threadId: data.threadId || null,
      // Stable per-conversation key + the inbound timestamp it answers, for
      // provenance-scoped dedup (Tribe outreach, #2158) — null for ordinary drafts.
      conversationKey: data.conversationKey || null,
      lastInboundAt: data.lastInboundAt || null,
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
    console.log(`📝 Message draft created: ${draft.id} via ${draft.sendVia}`);
    return draft;
  });
}

export async function updateDraft(id, updates) {
  return queueWrite(async () => {
    const drafts = await loadDrafts();
    const idx = drafts.findIndex(d => d.id === id);
    if (idx === -1) return null;
    if (['sending', 'sent'].includes(drafts[idx].status) || ['sending', 'sent', 'failed'].includes(updates.status)) {
      throw new ServerError('Draft cannot be edited in its current send state', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    const allowed = ['to', 'cc', 'subject', 'body', 'status'];
    for (const key of allowed) {
      if (updates[key] !== undefined) drafts[idx][key] = updates[key];
    }
    drafts[idx].updatedAt = new Date().toISOString();
    await saveDrafts(drafts);
    return drafts[idx];
  });
}

// The eligibility check and transition share the same queue as every draft edit.
// Provider I/O happens after this promise resolves, never while holding the queue.
export async function claimDraftForSend(id) {
  return queueWrite(async () => {
    const drafts = await loadDrafts();
    const draft = drafts.find(d => d.id === id);
    if (!draft) throw new ServerError('Draft not found', { status: 404, code: 'DRAFT_NOT_FOUND' });
    if (draft.status !== 'approved') {
      throw new ServerError('Draft must be approved and not already sending or sent', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    // Keep uncertain delivery blocked after a crash; never silently retry it.
    draft.status = 'sending';
    draft.updatedAt = new Date().toISOString();
    await saveDrafts(drafts);
    return draft;
  });
}

export async function finishDraftSend(id, success) {
  return queueWrite(async () => {
    const drafts = await loadDrafts();
    const draft = drafts.find(d => d.id === id);
    if (!draft) return null;
    if (draft.status !== 'sending') {
      throw new ServerError('Draft is not sending', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    draft.status = success ? 'sent' : 'failed';
    draft.updatedAt = new Date().toISOString();
    await saveDrafts(drafts);
    return draft;
  });
}

export async function approveDraft(id) {
  return updateDraft(id, { status: 'approved' });
}

export async function deleteDraftsByAccountId(accountId) {
  return queueWrite(async () => {
    const drafts = await loadDrafts();
    if (drafts.some(d => d.accountId === accountId && d.status === 'sending')) {
      throw new ServerError('Account has a draft being sent', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    const remaining = drafts.filter(d => d.accountId !== accountId);
    if (remaining.length < drafts.length) {
      await saveDrafts(remaining);
      console.log(`🗑️ Deleted ${drafts.length - remaining.length} drafts for account ${accountId}`);
    }
  });
}

export async function deleteDraft(id) {
  return queueWrite(async () => {
    const drafts = await loadDrafts();
    const idx = drafts.findIndex(d => d.id === id);
    if (idx === -1) return false;
    if (drafts[idx].status === 'sending') {
      throw new ServerError('Draft is being sent', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    drafts.splice(idx, 1);
    await saveDrafts(drafts);
    console.log(`🗑️ Message draft deleted: ${id}`);
    return true;
  });
}
