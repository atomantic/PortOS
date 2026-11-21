/**
 * Wire format for the CoS archive's completion-order projection.
 *
 * Wire format + projection rule for the CoS archive completion-order sidecar
 * (`data/cos/agents/index.order.json`). `projectArchivedAgent` reduces an archived record to its
 * completion timestamp plus a completed / still-needs-feedback bitfield; `encodeCompletionOrder` /
 * `decodeCompletionOrder` round-trip the versioned document, decoding anything unrecognized as empty
 * so the readers repair it by re-reading the day. Shared by the runtime index and the one-shot
 * backfill migration so the two cannot drift.
 *
 * `data/cos/agents/index.json` maps agentId → YYYY-MM-DD and nothing else, so
 * ordering a page of completed runs meant reading every `metadata.json` in each
 * visited day. The sidecar this module encodes carries the two facts the readers
 * actually need — when a run completed, and whether its archived record is still
 * an unrated feedback target — so pagination and the feedback badge answer from
 * memory and hydrate only the rows they return.
 *
 * Pure so the runtime index (`server/services/cos/cosAgentCompletionIndex.js`) and
 * the one-shot backfill (`scripts/migrations/406-…`) cannot drift on the
 * encoding or on what "eligible" means.
 *
 * The projection is DERIVED: every entry is rebuildable from the metadata it
 * describes, so an absent, truncated, or unrecognized-version file decodes to an
 * empty map rather than an error, and the readers fall back to reading the day.
 */

import { isAgentHandoff } from '../agent/agentOutcome.js';
import { hasValidAgentFeedback, isAgentFeedbackTarget } from './cosAgentFeedback.js';

/** Bumped when the encoded tuple changes shape; an unknown version decodes as absent. */
export const COMPLETION_ORDER_VERSION = 2;

// A compact bitfield rather than named keys: this file carries one entry per
// archived run, and a 10k-run install pays for every byte of key repetition.
export const COMPLETION_FLAG_COMPLETED = 1;
export const COMPLETION_FLAG_FEEDBACK_ELIGIBLE = 2;
export const COMPLETION_FLAG_SUCCESS = 4;
export const COMPLETION_FLAG_HANDOFF = 8;

const stringOrNull = (value) => (typeof value === 'string' && value ? value : null);

/**
 * Project one archived metadata record down to what the readers need. `status`
 * defaults to `completed` exactly as the archive reader does, so a record
 * written before the field was persisted is not misfiled as non-completed.
 */
export function projectArchivedAgent(agent) {
  const record = { ...agent, status: agent?.status || 'completed' };
  return {
    completedAt: typeof record.completedAt === 'string' ? record.completedAt : null,
    completed: record.status === 'completed',
    feedbackEligible: isAgentFeedbackTarget(record) && !hasValidAgentFeedback(record),
    // Filter + aggregate facts (#17309): while-away stats, app history and task-id lookups answer
    // from these without parsing metadata.json. Descriptions and transcripts stay out on purpose.
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
    taskId: stringOrNull(record.taskId ?? record.metadata?.taskId),
    app: stringOrNull(record.metadata?.app),
    taskApp: stringOrNull(record.metadata?.taskApp),
    success: record.result?.success === true,
    handoff: isAgentHandoff(record),
    resultDuration: Number.isFinite(record.result?.duration) ? record.result.duration : null,
  };
}

/** True when two projections say the same thing — the write-skip check. */
export function sameCompletionProjection(a, b) {
  return !!a && !!b && a.completedAt === b.completedAt
    && a.completed === b.completed && a.feedbackEligible === b.feedbackEligible
    && a.startedAt === b.startedAt && a.taskId === b.taskId && a.app === b.app && a.taskApp === b.taskApp
    && a.success === b.success && a.handoff === b.handoff && a.resultDuration === b.resultDuration;
}

/** Encode an agentId → projection Map into the on-disk document. */
export function encodeCompletionOrder(projections) {
  const entries = {};
  for (const [agentId, entry] of projections) {
    entries[agentId] = [
      entry.completedAt || null,
      (entry.completed ? COMPLETION_FLAG_COMPLETED : 0)
        | (entry.feedbackEligible ? COMPLETION_FLAG_FEEDBACK_ELIGIBLE : 0)
        | (entry.success ? COMPLETION_FLAG_SUCCESS : 0)
        | (entry.handoff ? COMPLETION_FLAG_HANDOFF : 0),
      entry.startedAt ?? null,
      entry.taskId ?? null,
      entry.app ?? null,
      entry.taskApp ?? null,
      entry.resultDuration ?? null,
    ];
  }
  return { version: COMPLETION_ORDER_VERSION, entries };
}

/**
 * Decode the on-disk document. Anything unrecognized — a missing file, a
 * truncated write, a document a NEWER install wrote — yields an empty map, which
 * the readers repair by re-reading the days they visit.
 */
export function decodeCompletionOrder(raw) {
  const projections = new Map();
  if (!raw || typeof raw !== 'object' || raw.version !== COMPLETION_ORDER_VERSION) return projections;
  const encoded = raw.entries;
  if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded)) return projections;
  for (const [agentId, value] of Object.entries(encoded)) {
    if (!Array.isArray(value) || value.length < 7) continue;
    const [completedAt, flags, startedAt, taskId, app, taskApp, resultDuration] = value;
    if (completedAt !== null && typeof completedAt !== 'string') continue;
    if (!Number.isInteger(flags)) continue;
    if (![startedAt, taskId, app, taskApp].every(field => field === null || typeof field === 'string')) continue;
    if (resultDuration !== null && !Number.isFinite(resultDuration)) continue;
    projections.set(agentId, {
      completedAt: completedAt || null,
      completed: (flags & COMPLETION_FLAG_COMPLETED) !== 0,
      feedbackEligible: (flags & COMPLETION_FLAG_FEEDBACK_ELIGIBLE) !== 0,
      startedAt, taskId, app, taskApp, resultDuration,
      success: (flags & COMPLETION_FLAG_SUCCESS) !== 0,
      handoff: (flags & COMPLETION_FLAG_HANDOFF) !== 0,
    });
  }
  return projections;
}
