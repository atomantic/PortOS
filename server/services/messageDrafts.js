/**
 * Messages drafts: create, edit, approve and send drafts with a send-attempt audit trail.
 *
 * Storage: `file-primary` — `data/messages/drafts.json`, machine-local, never
 * federated; covered by the existing backup. Send-attempt history is capped at 20
 * per draft; startup marks abandoned sends `delivery_unknown` without contacting a
 * provider, and such a draft stays locked until the operator records the outcome.
 */
import { join } from 'path';
import { isDeepStrictEqual } from 'util';
import { z } from 'zod';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { atomicWrite, ensureDir, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { escapeRegExp } from '../lib/textUtils.js';

const DRAFTS_FILE = join(PATHS.messages, 'drafts.json');
const MISSING_STORE = Symbol('missing drafts');
// Older drafts lack send audit fields. Keep their extra fields unchanged while
// rejecting records that recovery or reconciliation cannot safely operate on.
const draftStoreSchema = z.array(z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  sendAttemptId: z.string().min(1).nullish(),
  sendAttempts: z.array(z.object({ id: z.string().min(1) }).passthrough()).nullish()
}).passthrough().refine(draft => draft.status !== 'delivery_unknown'
  || (draft.sendAttemptId && draft.sendAttempts?.some(attempt => attempt.id === draft.sendAttemptId))));

// Serialize every read-modify-write of drafts.json onto a single tail so two
// concurrent createDraft/updateDraft/delete calls can't read the same snapshot and
// have one atomic rename clobber the other's just-persisted draft. This matters
// now that Tribe outreach (#2158) permits several draft generations in flight at
// once — each finishing LLM call lands its own createDraft.
const queueWrite = createFileWriteQueue();
const activeAttempts = new Map();
const MAX_SEND_ATTEMPTS = 20;

// Called only under queueWrite. A persisted send with no live dispatcher is
// ambiguous even if it never reached the transport. Never retry it at boot.
// `ensure: false` (erasure helpers) never creates the messages dir: with no
// store there is nothing to erase, and a read must not write into data/.
async function loadDrafts({ ensure = true } = {}) {
  if (ensure) await ensureDir(PATHS.messages);
  const { ok, value } = await readJSONFileStrict(DRAFTS_FILE, MISSING_STORE, { logError: false });
  if (ok && value === MISSING_STORE) return [];
  const parsed = ok && draftStoreSchema.safeParse(value);
  if (!parsed?.success) {
    throw new ServerError('Message drafts storage is unavailable or invalid; original data preserved', {
      status: 503, code: 'MESSAGE_DRAFTS_UNAVAILABLE'
    });
  }
  // Validate without projecting the records: future/legacy audit fields survive.
  const drafts = value;
  let recovered = false;
  for (const draft of drafts) {
    if (draft.status !== 'sending' || activeAttempts.has(draft.id)) continue;
    const now = new Date().toISOString();
    draft.sendAttemptId ||= uuidv4();
    draft.sendAttempts = (draft.sendAttempts || []).slice(-MAX_SEND_ATTEMPTS);
    let attempt = draft.sendAttempts.find(a => a.id === draft.sendAttemptId);
    if (!attempt) {
      attempt = { id: draft.sendAttemptId, startedAt: draft.updatedAt || null };
      draft.sendAttempts = [...draft.sendAttempts, attempt].slice(-MAX_SEND_ATTEMPTS);
    }
    attempt.outcome = 'delivery_unknown';
    attempt.interruptedAt = now;
    draft.status = 'delivery_unknown';
    draft.updatedAt = now;
    recovered = true;
  }
  if (recovered) await saveDrafts(drafts);
  return drafts;
}

async function saveDrafts(drafts) {
  await atomicWrite(DRAFTS_FILE, drafts);
}

// Boot and request-time recovery share the same queue and active-attempt guard.
export async function initializeMessageDrafts() {
  await queueWrite(loadDrafts);
}

export async function listDrafts(filters = {}) {
  let drafts = await queueWrite(loadDrafts);
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
  const drafts = await queueWrite(loadDrafts);
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
      sendAttemptId: null,
      sendAttempts: [],
      generatedBy: data.generatedBy || 'manual',
      // Non-PII provenance ids so Privacy Center erasure can find this draft later.
      ...(data.privacyMeta ? { privacyMeta: data.privacyMeta } : {}),
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
    if (['sending', 'delivery_unknown', 'sent'].includes(drafts[idx].status) || ['sending', 'delivery_unknown', 'sent', 'failed'].includes(updates.status)) {
      throw new ServerError('Draft cannot be edited in its current send state', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    // Approval is send intent for the content the approver saw (#13055): an
    // edit to who or what gets sent drops it unless the same update re-approves.
    const contentChanged = ['to', 'cc', 'subject', 'body']
      .some((key) => updates[key] !== undefined && !isDeepStrictEqual(updates[key], drafts[idx][key]));
    const allowed = ['to', 'cc', 'subject', 'body', 'status'];
    for (const key of allowed) {
      if (updates[key] !== undefined) drafts[idx][key] = updates[key];
    }
    if (contentChanged && drafts[idx].status === 'approved' && updates.status !== 'approved') drafts[idx].status = 'draft';
    drafts[idx].updatedAt = new Date().toISOString();
    await saveDrafts(drafts);
    return drafts[idx];
  });
}

// The eligibility check and transition share the same queue as every draft edit.
// Provider I/O happens after this promise resolves, never while holding the queue.
export async function claimDraftForSend(id, validateClaim) {
  return queueWrite(async () => {
    const drafts = await loadDrafts();
    const draft = drafts.find(d => d.id === id);
    if (!draft) throw new ServerError('Draft not found', { status: 404, code: 'DRAFT_NOT_FOUND' });
    if (draft.status !== 'approved') {
      throw new ServerError('Draft must be approved and not already sending or sent', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    validateClaim?.(draft);
    // Keep uncertain delivery blocked after a crash; never silently retry it.
    draft.status = 'sending';
    draft.updatedAt = new Date().toISOString();
    draft.sendAttemptId = uuidv4();
    draft.sendAttempts = [...(draft.sendAttempts || []), {
      id: draft.sendAttemptId, startedAt: draft.updatedAt, outcome: 'sending'
    }].slice(-MAX_SEND_ATTEMPTS);
    await saveDrafts(drafts);
    activeAttempts.set(id, draft.sendAttemptId);
    return draft;
  });
}

// `outcome` is true (delivered), false (definitely not delivered, may be re-approved)
// or 'delivery_unknown' (the transport cannot say — same state a crash leaves, and
// it likewise needs a human to check the mailbox before the draft can move again).
export async function finishDraftSend(id, attemptId, outcome) {
  return queueWrite(async () => {
    const drafts = await loadDrafts();
    const draft = drafts.find(d => d.id === id);
    if (!draft) return null;
    if (draft.status !== 'sending' || draft.sendAttemptId !== attemptId || activeAttempts.get(id) !== attemptId) {
      throw new ServerError('Draft is not sending', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    draft.status = outcome === 'delivery_unknown' ? 'delivery_unknown' : outcome === true ? 'sent' : 'failed';
    draft.updatedAt = new Date().toISOString();
    const attempt = draft.sendAttempts.find(a => a.id === attemptId);
    attempt.outcome = draft.status;
    attempt.finishedAt = draft.updatedAt;
    await saveDrafts(drafts);
    return draft;
  });
}

// Only the dispatcher releases its own lease, after all transport I/O settles.
// A failed terminal write remains sending on disk and is recovered on next read.
export function releaseDraftSend(id, attemptId) {
  if (activeAttempts.get(id) === attemptId) activeAttempts.delete(id);
}

export async function reconcileDraftSend(id, { attemptId, outcome }) {
  return queueWrite(async () => {
    const drafts = await loadDrafts();
    const draft = drafts.find(d => d.id === id);
    if (!draft) throw new ServerError('Draft not found', { status: 404, code: 'DRAFT_NOT_FOUND' });
    if (activeAttempts.has(id) || draft.status !== 'delivery_unknown' || draft.sendAttemptId !== attemptId) {
      throw new ServerError('Draft delivery cannot be reconciled in its current state', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    if (!['sent', 'not_sent'].includes(outcome)) {
      throw new ServerError('Confirm sent or not sent after checking your mailbox', { status: 400 });
    }
    const now = new Date().toISOString();
    const attempt = draft.sendAttempts.find(a => a.id === attemptId);
    attempt.reconciliation = outcome;
    attempt.reconciledAt = now;
    draft.status = outcome === 'sent' ? 'sent' : 'draft';
    draft.updatedAt = now;
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
    if (drafts.some(d => d.accountId === accountId && ['sending', 'delivery_unknown'].includes(d.status))) {
      throw new ServerError('Account has a draft sending or awaiting delivery reconciliation', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
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
    if (['sending', 'delivery_unknown'].includes(drafts[idx].status)) {
      throw new ServerError('Draft is sending or awaiting delivery reconciliation', { status: 409, code: 'DRAFT_STATE_CONFLICT' });
    }
    drafts.splice(idx, 1);
    await saveDrafts(drafts);
    console.log(`🗑️ Message draft deleted: ${id}`);
    return true;
  });
}

// Privacy Center drafts hold decrypted vault PII in plaintext (#17233).
const PRIVACY_GENERATORS = ['privacy-optout', 'privacy-change'];
const UNSENT_STATUSES = ['draft', 'approved', 'failed'];
export const PRIVACY_DRAFT_REDACTION_NOTICE = '[Privacy draft body redacted after erasure]';

const isPrivacyDraft = d => PRIVACY_GENERATORS.includes(d.generatedBy);
// sending/delivery_unknown drafts are owned by the send lifecycle: never touch them.
const isSendLocked = d => ['sending', 'delivery_unknown'].includes(d.status);

/**
 * Erase privacy-originated drafts selected by `predicate`: unsent ones are
 * deleted (so they cannot be sent after erasure/consent withdrawal), sent ones
 * keep their audit trail with the body replaced by a fixed notice. `onlyUnsent`
 * (consent revocation) leaves sent drafts alone. Send-locked drafts are skipped.
 */
export async function erasePrivacyDrafts(predicate, { onlyUnsent = false, generatedBy = PRIVACY_GENERATORS } = {}) {
  return queueWrite(async () => {
    const drafts = await loadDrafts({ ensure: false });
    const result = { deleted: 0, redacted: 0, skipped: 0 };
    const remaining = [];
    for (const d of drafts) {
      if (!isPrivacyDraft(d) || !generatedBy.includes(d.generatedBy) || !predicate(d)) { remaining.push(d); continue; }
      if (isSendLocked(d)) { result.skipped += 1; remaining.push(d); continue; }
      if (UNSENT_STATUSES.includes(d.status)) { result.deleted += 1; continue; }
      if (!onlyUnsent && d.status === 'sent' && d.body !== PRIVACY_DRAFT_REDACTION_NOTICE) {
        d.body = PRIVACY_DRAFT_REDACTION_NOTICE;
        d.updatedAt = new Date().toISOString();
        result.redacted += 1;
      }
      remaining.push(d);
    }
    if (result.deleted || result.redacted) {
      await saveDrafts(remaining);
      console.log(`🗑️ Privacy draft erasure: deleted=${result.deleted} redacted=${result.redacted} skipped=${result.skipped}`);
    }
    return result;
  });
}

/**
 * Scrub decrypted `values` out of every privacy draft, including legacy ones
 * that predate `privacyMeta` and tagged ones whose meta names no vault record
 * (opt-out drafts disclose several fields). Mirrors
 * privacyPromptScrub: whole-token match, `[redacted]` replacement.
 */
export async function scrubLegacyPrivacyDraftValues(values) {
  const needles = [...new Set((values || []).filter(v => typeof v === 'string' && v.trim()))];
  if (needles.length === 0) return 0;
  const alternatives = needles.sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, 'gu');
  return queueWrite(async () => {
    const drafts = await loadDrafts({ ensure: false });
    let changed = 0;
    for (const d of drafts) {
      if (!isPrivacyDraft(d) || isSendLocked(d)) continue;
      const body = typeof d.body === 'string' ? d.body.replace(pattern, '[redacted]') : d.body;
      const subject = typeof d.subject === 'string' ? d.subject.replace(pattern, '[redacted]') : d.subject;
      if (body === d.body && subject === d.subject) continue;
      d.body = body;
      d.subject = subject;
      d.updatedAt = new Date().toISOString();
      if (d.status === 'approved') d.status = 'draft';
      changed += 1;
    }
    if (changed) await saveDrafts(drafts);
    return changed;
  });
}
