/**
 * CoS Agent Feedback Module
 *
 * Per-agent feedback capture + aggregation and the task-type classifier.
 * Extracted from the former monolithic cosAgents.js (issue #2530).
 *
 * The `cosAgents.js` barrel that used to re-export this module is retired
 * (#3450) — callers import from here directly.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cosEvents, emitLog } from './cosEvents.js';
import { loadState, saveState, withStateLock } from './cosState.js';
import { atomicWrite, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { loadAgentIndex, getAgentDir } from './cosAgentIndex.js';
import {
  loadCompletionOrderIndex,
  markCompletionFeedbackResolved,
  projectArchivedAgent,
  recordArchivedCompletions,
} from './cosAgentCompletionIndex.js';
import { ServerError } from '../lib/errorHandler.js';
import { recordUserAction } from './userActions.js';
import {
  FEEDBACK_RATINGS,
  feedbackArchiveDate,
  hasValidAgentFeedback,
  isAgentFeedbackEligible,
  isAgentFeedbackTarget,
  isAgentFeedbackUpdateTarget,
  isFeedbackRating,
} from '../lib/cosAgentFeedback.js';
import {
  listPendingAgentFeedbackRefs,
  removePendingAgentFeedbackRef,
  upsertPendingAgentFeedbackRef,
} from './cosAgentFeedbackStore.js';

const ARCHIVE_READ_BATCH_SIZE = 50;
const hasValidFeedback = hasValidAgentFeedback;

// Completed agents are written to their date-bucket archive before they age out
// of live state. Feedback statistics therefore have to read both stores and
// de-duplicate by agent id; reading state alone makes almost all historical
// ratings disappear from the learning view as soon as normal retention runs.
async function loadArchivedAgentsWithFeedback() {
  const idx = await loadAgentIndex();
  const entries = [...idx.entries()];
  const agents = [];

  // Match the archive reader's bounded fan-out so a long-lived install does not
  // open every metadata file at once.
  for (let i = 0; i < entries.length; i += ARCHIVE_READ_BATCH_SIZE) {
    const batch = entries.slice(i, i + ARCHIVE_READ_BATCH_SIZE);
    const reads = batch.map(async ([agentId, dateBucket]) => {
      const content = await tryReadFile(join(getAgentDir(agentId, dateBucket), 'metadata.json'));
      if (!content) return null;
      const raw = safeJSONParse(content, null);
      return hasValidFeedback(raw) ? { ...raw, id: raw.id || raw.agentId || agentId } : null;
    });
    const settled = await Promise.allSettled(reads);
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) agents.push(result.value);
    }
  }

  return agents;
}

async function readArchivedAgent(agentId, dateBucket) {
  const metadataPath = join(getAgentDir(agentId, dateBucket), 'metadata.json');
  const read = await readFile(metadataPath, 'utf8').then(
    (content) => ({ content }),
    (error) => ({ error }),
  );
  if (read.error) {
    return { kind: read.error.code === 'ENOENT' ? 'missing' : 'read-failed', metadataPath };
  }
  const { content } = read;
  const raw = safeJSONParse(content, null, { allowArray: false });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'read-failed', metadataPath };
  }
  return {
    kind: 'found',
    metadataPath,
    agent: { ...raw, id: raw.id || raw.agentId || agentId },
  };
}

function unavailableFeedbackRef(ref, reason) {
  return {
    id: ref.agentId,
    agentId: ref.agentId,
    archiveDate: ref.archiveDate || null,
    availability: 'unavailable',
    unavailableReason: reason,
  };
}

/**
 * The durable references to consider, paired with live state.
 *
 * Enrollment happens here rather than only on the `agent:completed` event so a
 * live completion stays discoverable when the event arrived during a restart
 * window or before the migration ran — every reader of the pending set needs
 * that, so it belongs on the one path all of them take.
 */
async function collectPendingFeedbackRefs() {
  const state = await loadState();
  const refs = await listPendingAgentFeedbackRefs();
  const refsById = new Map(refs.map((ref) => [ref.agentId, ref]));
  const liveById = new Map(Object.entries(state?.agents || {}).map(([id, agent]) => [agent.id || id, agent]));

  for (const [agentId, agent] of liveById) {
    if (!isAgentFeedbackEligible(agent)) continue;
    const ref = { agentId, archiveDate: feedbackArchiveDate(agent) };
    refsById.set(agentId, ref);
    await upsertPendingAgentFeedbackRef(ref);
  }

  return { refsById, liveById };
}

/**
 * Reconcile the durable references with live state and indexed archive records.
 * The only broad read here is live state plus the referenced archive files; it
 * never scans the historical archive looking for work.
 */
export async function getPendingAgentFeedback({ includeUnavailable = false } = {}) {
  const { refsById, liveById } = await collectPendingFeedbackRefs();

  const idx = refsById.size > 0 ? await loadAgentIndex() : new Map();
  const agents = [];
  const unavailable = [];
  // This path already paid for the archive read, so hand what it learned to the
  // eligibility projection the scalar/paged readers answer from.
  const learned = [];

  for (const ref of refsById.values()) {
    const live = liveById.get(ref.agentId);
    if (live) {
      if (isAgentFeedbackEligible(live)) {
        agents.push(live);
        continue;
      }

      // A rated live record is not actionable, but retain its reference until
      // the same rating is durable in the archive. This prevents archive
      // eviction from resurrecting a rating obligation after a partial write.
      if (isAgentFeedbackTarget(live) && hasValidFeedback(live)) {
        const archived = await readArchivedAgent(ref.agentId, idx.get(ref.agentId) || ref.archiveDate);
        if (archived.kind === 'found' && hasValidFeedback(archived.agent)) {
          await removePendingAgentFeedbackRef(ref.agentId);
        }
        continue;
      }

      await removePendingAgentFeedbackRef(ref.agentId);
      continue;
    }

    const archiveDate = idx.get(ref.agentId) || ref.archiveDate;
    if (!archiveDate) {
      if (includeUnavailable) unavailable.push(unavailableFeedbackRef(ref, 'deleted'));
      continue;
    }

    const archived = await readArchivedAgent(ref.agentId, archiveDate);
    if (archived.kind === 'read-failed') {
      // An indexed reference with an unreadable metadata file is not proof that
      // the run was deleted. Keep it pending and let History show the failure.
      if (includeUnavailable) unavailable.push(unavailableFeedbackRef({ ...ref, archiveDate }, 'read-failed'));
      continue;
    }
    if (archived.kind === 'missing') {
      if (includeUnavailable) unavailable.push(unavailableFeedbackRef({ ...ref, archiveDate }, 'deleted'));
      continue;
    }
    if (idx.has(ref.agentId)) learned.push([ref.agentId, projectArchivedAgent(archived.agent)]);
    if (!isAgentFeedbackTarget(archived.agent) || hasValidFeedback(archived.agent)) {
      await removePendingAgentFeedbackRef(ref.agentId);
      continue;
    }
    agents.push(archived.agent);
  }

  if (learned.length > 0) await recordArchivedCompletions(learned);
  return { agents, unavailable, count: agents.length };
}

/**
 * Which pending references are still actionable, resolved WITHOUT reading the
 * archive: a live record answers from state, an archived one from the
 * completion-order projection. Only a reference the projection has never seen —
 * a fresh federation import, or an install that has not run the backfill — costs
 * one metadata read, and that read teaches the projection so the next call is
 * free. Deliberately read-only apart from live enrollment: the scalar badge and
 * the paged list must not reconcile the durable store, which
 * `getPendingAgentFeedback` owns.
 */
async function resolveEligiblePendingFeedback() {
  const { refsById, liveById } = await collectPendingFeedbackRefs();
  if (refsById.size === 0) return [];
  const idx = await loadAgentIndex();
  const order = await loadCompletionOrderIndex();
  const eligible = [];
  const learned = [];

  for (const ref of refsById.values()) {
    const live = liveById.get(ref.agentId);
    if (live) {
      if (isAgentFeedbackEligible(live)) eligible.push({ agentId: ref.agentId, agent: live });
      continue;
    }

    const archiveDate = idx.get(ref.agentId) || ref.archiveDate;
    if (!archiveDate) continue;

    // The projection's keyspace is the index's, so consult it only for an id the
    // index still owns — anything else would be learned and immediately pruned.
    const indexed = idx.has(ref.agentId);
    const projected = indexed ? order.get(ref.agentId) : null;
    if (projected) {
      if (projected.feedbackEligible) eligible.push({ agentId: ref.agentId, archiveDate });
      continue;
    }

    const archived = await readArchivedAgent(ref.agentId, archiveDate);
    if (archived.kind !== 'found') continue;
    if (indexed) learned.push([ref.agentId, projectArchivedAgent(archived.agent)]);
    if (isAgentFeedbackTarget(archived.agent) && !hasValidFeedback(archived.agent)) {
      eligible.push({ agentId: ref.agentId, archiveDate, agent: archived.agent });
    }
  }

  if (learned.length > 0) await recordArchivedCompletions(learned);
  return eligible;
}

export async function getPendingAgentFeedbackCount() {
  return (await resolveEligiblePendingFeedback()).length;
}

/**
 * One bounded page of pending feedback, newest agent id first — the same order
 * and cursor the route used when it sliced the fully-hydrated list. Only the
 * returned rows are read off disk.
 */
export async function getPendingAgentFeedbackPage({ limit = 25, cursor } = {}) {
  const eligible = await resolveEligiblePendingFeedback();
  const remaining = eligible
    .filter((entry) => !cursor || entry.agentId < cursor)
    .sort((a, b) => (a.agentId < b.agentId ? 1 : a.agentId > b.agentId ? -1 : 0));

  const items = [];
  for (const entry of remaining.slice(0, limit)) {
    if (entry.agent) { items.push(entry.agent); continue; }
    const archived = await readArchivedAgent(entry.agentId, entry.archiveDate);
    if (archived.kind === 'found') items.push(archived.agent);
  }

  return {
    items,
    total: eligible.length,
    nextCursor: remaining.length > limit ? remaining[limit - 1].agentId : null,
  };
}

// Submit feedback for a completed agent.
//
// The operator-action ledger write (#5594) happens AFTER the state lock releases,
// not inside it: a rating is a human verdict every caller should record, so it
// belongs at this one boundary rather than in the HTTP route — but nesting a DB
// write inside the CoS state lock would hold the lock across an I/O round trip
// for a log line. The lock's own failures still reject before anything is logged.
export async function submitAgentFeedback(agentId, feedback) {
  if (!isFeedbackRating(feedback?.rating)) {
    throw new ServerError(`rating must be one of: ${FEEDBACK_RATINGS.join(', ')}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  // The durable reference is removed only after the source metadata write. Keep
  // that small store mutation outside the CoS state lock so a database/file I/O
  // round trip never serializes unrelated agent state updates.
  const result = await withStateLock(async () => {
    const state = await loadState();
    const feedbackData = {
      rating: feedback.rating,
      comment: feedback.comment || null,
      submittedAt: new Date().toISOString()
    };

    // Try state first (recently completed agents still in state)
    if (state.agents[agentId]) {
      const agent = state.agents[agentId];
      if (!isAgentFeedbackUpdateTarget(agent)) {
        throw new ServerError('Can only submit feedback for completed agents', { status: 400, code: 'INVALID_STATE' });
      }
      state.agents[agentId] = { ...agent, feedback: feedbackData };
      await saveState(state);

      // Also update on-disk metadata. The live state write is authoritative for
      // the current card, but the pending reference is cleared only after the
      // source archive carries the same rating, so eviction cannot resurrect it.
      const dateBucket = feedbackArchiveDate(agent);
      const archived = await readArchivedAgent(agentId, dateBucket);
      if (archived.kind === 'found') {
        await atomicWrite(archived.metadataPath, { ...archived.agent, feedback: feedbackData });
      }

      emitLog('info', `Feedback received for agent ${agentId}: ${feedback.rating}`, { agentId, rating: feedback.rating });
      cosEvents.emit('agent:feedback', { agentId, feedback: feedbackData });
      return { success: true, agent: state.agents[agentId], feedbackData, clearPendingRef: archived.kind === 'found' };
    }

    // Agent not in state — look up from disk via index
    const idx = await loadAgentIndex();
    const dateStr = idx.get(agentId);
    if (!dateStr) throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });

    const archived = await readArchivedAgent(agentId, dateStr);
    if (archived.kind !== 'found') throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
    if (!isAgentFeedbackUpdateTarget(archived.agent)) {
      throw new ServerError('Can only submit feedback for completed agents', { status: 400, code: 'INVALID_STATE' });
    }

    const updated = { ...archived.agent, feedback: feedbackData };
    await atomicWrite(archived.metadataPath, updated);

    emitLog('info', `Feedback received for agent ${agentId}: ${feedback.rating}`, { agentId, rating: feedback.rating });
    cosEvents.emit('agent:feedback', { agentId, feedback: feedbackData });
    return { success: true, agent: { ...updated, id: agentId }, feedbackData, clearPendingRef: true };
  });

  const { feedbackData, clearPendingRef, ...response } = result;
  if (clearPendingRef) await removePendingAgentFeedbackRef(agentId);
  // A rated archive is no longer an eligible target; clearing the projected bit
  // keeps the scalar badge correct without re-reading the record.
  await markCompletionFeedbackResolved(agentId);
  await recordUserAction({
    type: 'cos.agent.feedback',
    target: agentId,
    targetName: response.agent?.metadata?.taskDescription,
    summary: `Rated agent ${agentId} ${feedbackData.rating}`,
    payload: {
      agentId,
      taskId: response.agent?.taskId ?? null,
      rating: feedbackData.rating,
      comment: feedbackData.comment,
      taskType: extractTaskType(response.agent?.metadata?.taskDescription),
    },
    source: { service: 'cosAgentFeedback', fn: 'submitAgentFeedback' },
    happenedAt: feedbackData.submittedAt,
    dedupeKey: `cos.agent.feedback:${agentId}:${feedbackData.submittedAt}`,
  });
  return response;
}

// Get aggregated feedback statistics
export async function getFeedbackStats() {
  const state = await loadState();
  const archived = await loadArchivedAgentsWithFeedback();
  const byAgentId = new Map(archived.map(agent => [agent.id, agent]));

  // Live state is freshest, but only overwrite an archived rating when the live
  // record actually carries valid feedback. This preserves a durable rating if
  // a prior best-effort live-state update did not make it into both stores.
  for (const [agentId, agent] of Object.entries(state.agents)) {
    if (hasValidFeedback(agent)) byAgentId.set(agent.id || agentId, agent);
  }

  const withFeedback = [...byAgentId.values()];
  const positive = withFeedback.filter(a => a.feedback.rating === 'positive').length;
  const negative = withFeedback.filter(a => a.feedback.rating === 'negative').length;
  const neutral = withFeedback.filter(a => a.feedback.rating === 'neutral').length;

  // Group by task type
  const byTaskType = {};
  withFeedback.forEach(a => {
    const taskType = extractTaskType(a.metadata?.taskDescription);
    if (!byTaskType[taskType]) {
      byTaskType[taskType] = { positive: 0, negative: 0, neutral: 0, total: 0 };
    }
    byTaskType[taskType][a.feedback.rating]++;
    byTaskType[taskType].total++;
  });

  // Recent feedback (last 10 with comments)
  const recentWithComments = withFeedback
    .filter(a => a.feedback.comment)
    .sort((a, b) => new Date(b.feedback.submittedAt) - new Date(a.feedback.submittedAt))
    .slice(0, 10)
    .map(a => ({
      agentId: a.id,
      taskDescription: a.metadata?.taskDescription,
      rating: a.feedback.rating,
      comment: a.feedback.comment,
      submittedAt: a.feedback.submittedAt
    }));

  const satisfactionRate = withFeedback.length > 0
    ? Math.round((positive / withFeedback.length) * 100)
    : null;

  return {
    total: withFeedback.length,
    positive,
    negative,
    neutral,
    satisfactionRate,
    byTaskType,
    recentWithComments
  };
}

let feedbackEventsInitialized = false;

/** Register future-completion enrollment without doing any cold-start provider work. */
export function initializeAgentFeedback() {
  if (feedbackEventsInitialized) return;
  feedbackEventsInitialized = true;
  cosEvents.on('agent:completed', (agent) => {
    if (!isAgentFeedbackEligible(agent)) return;
    upsertPendingAgentFeedbackRef({
      agentId: agent.id,
      archiveDate: feedbackArchiveDate(agent),
    }).catch((err) => {
      console.error(`❌ Failed to enroll CoS feedback for ${agent.id}: ${err.message}`);
    });
  });
}

// Helper to extract task type from description (mirrors client-side logic)
export function extractTaskType(description) {
  if (!description) return 'general';
  const d = description.toLowerCase();
  if (d.includes('fix') || d.includes('bug') || d.includes('error') || d.includes('issue')) return 'bug-fix';
  if (d.includes('refactor') || d.includes('clean up') || d.includes('improve') || d.includes('optimize')) return 'refactor';
  if (d.includes('test')) return 'testing';
  if (d.includes('document') || d.includes('readme') || d.includes('docs')) return 'documentation';
  if (d.includes('review') || d.includes('audit')) return 'code-review';
  if (d.includes('mobile') || d.includes('responsive')) return 'mobile-responsive';
  if (d.includes('security') || d.includes('vulnerability')) return 'security';
  if (d.includes('performance') || d.includes('speed')) return 'performance';
  if (d.includes('ui') || d.includes('ux') || d.includes('design') || d.includes('style')) return 'ui-ux';
  if (d.includes('api') || d.includes('endpoint') || d.includes('route')) return 'api';
  if (d.includes('database') || d.includes('migration')) return 'database';
  if (d.includes('deploy') || d.includes('ci') || d.includes('cd')) return 'devops';
  if (d.includes('investigate') || d.includes('debug')) return 'investigation';
  if (d.includes('self-improvement') || d.includes('feature idea')) return 'self-improvement';
  return 'feature';
}
