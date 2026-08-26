/**
 * Persistent-mind context rollups and explicit Brain promotion.
 *
 * Raw events remain in the bounded machine-local run-event ledger. Older
 * sealed ranges are represented by provenance-tagged rollups in a separate
 * machine-local cache, so assembling one turn never requires an unbounded JSONL
 * read. A corrupt/unreadable cache fails closed rather than becoming `[]` and
 * overwriting the only summaries of history that has left raw retention.
 */

import { join } from 'path';
import {
  PATHS,
  atomicWrite,
  readJSONFileStrict,
  sha256Text,
} from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import {
  PERSISTENT_MIND_ID,
  PERSISTENT_MIND_ROLLUP_PROMPT_VERSION,
  PERSISTENT_MIND_TRAJECTORY_LIMITS,
  assemblePersistentMindContext,
  buildPersistentMindRollup,
  isStoredPersistentMindRollup,
} from '../lib/persistentMindTrajectory.js';
import {
  appendMindEvent,
  readPersistentMindHistory,
} from './agentRunEventLog.js';
import * as memoryBackend from './memoryBackend.js';

const ROLLUP_PATH = join(PATHS.cos, 'persistent-mind-rollups.json');
const ROLLUP_STORE_SCHEMA_VERSION = 1;
const queueRollupWrite = createFileWriteQueue();

const emptyStore = () => ({ schemaVersion: ROLLUP_STORE_SCHEMA_VERSION, rollups: [] });

async function loadRollupStore() {
  const { ok, value } = await readJSONFileStrict(ROLLUP_PATH, emptyStore());
  if (!ok) throw new Error('Persistent mind rollup cache is unreadable');
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== ROLLUP_STORE_SCHEMA_VERSION || !Array.isArray(value.rollups)
      || value.rollups.some((rollup) => !isStoredPersistentMindRollup(rollup))) {
    throw new Error('Persistent mind rollup cache has an invalid shape');
  }
  return value;
}

export async function readPersistentMindRollups(mindId = PERSISTENT_MIND_ID) {
  const store = await loadRollupStore();
  return store.rollups
    .filter((rollup) => rollup.mindId === mindId)
    .sort((a, b) => a.source.fromSequence - b.source.fromSequence);
}

export function recordPersistentMindRollup(input) {
  const rollup = buildPersistentMindRollup(input);
  return queueRollupWrite(async () => {
    const store = await loadRollupStore();
    const ordered = [...store.rollups.filter((item) => item.id !== rollup.id), rollup]
      .sort((a, b) => a.source.fromSequence - b.source.fromSequence || a.source.toSequence - b.source.toSequence);
    const latestReadyByMind = new Map();
    for (const item of ordered.filter((candidate) => candidate.status === 'ready')) {
      const previous = latestReadyByMind.get(item.mindId);
      if (!previous || item.source.toSequence > previous.source.toSequence) {
        latestReadyByMind.set(item.mindId, item);
      }
    }
    const latestReadyIds = new Set([...latestReadyByMind.values()].map((item) => item.id));
    const tail = ordered
      .filter((item) => !latestReadyIds.has(item.id))
      .slice(-Math.max(0, PERSISTENT_MIND_TRAJECTORY_LIMITS.maxStoredRollups - latestReadyIds.size));
    const keptIds = new Set([...latestReadyIds, ...tail.map((item) => item.id)]);
    const rollups = ordered.filter((item) => keptIds.has(item.id));
    await atomicWrite(ROLLUP_PATH, { schemaVersion: ROLLUP_STORE_SCHEMA_VERSION, rollups });
    return rollup;
  });
}

const latestReadyRollup = (rollups, promptVersion) => rollups
  .filter((rollup) => rollup.status === 'ready' && rollup.provenance.promptVersion === promptVersion)
  .sort((a, b) => a.source.toSequence - b.source.toSequence)
  .at(-1) || null;

const summaryOutcome = (summarize, input) => Promise.resolve()
  .then(() => summarize(input))
  .then(
    (summary) => typeof summary === 'string' && summary.trim()
      ? { ok: true, summary }
      : { ok: false, error: 'Persistent mind summarizer returned no summary text' },
    (error) => ({ ok: false, error: String(error?.message || error || 'Persistent mind summary failed').slice(0, 500) })
  );

/**
 * Assemble context and, when a summarizer is available, incrementally seal the
 * older range that just fell outside the recent verbatim window.
 */
export async function preparePersistentMindContext({
  mindId = PERSISTENT_MIND_ID,
  identity = '',
  maxChars,
  recentEventLimit = PERSISTENT_MIND_TRAJECTORY_LIMITS.recentContextEvents,
  promptVersion = PERSISTENT_MIND_ROLLUP_PROMPT_VERSION,
  providerId = null,
  model = null,
  summarize = null,
  forceSummary = false,
} = {}) {
  const history = await readPersistentMindHistory(mindId);
  let rollups = await readPersistentMindRollups(mindId);
  const older = history.slice(0, Math.max(0, history.length - Math.max(1, recentEventLimit)));

  if (older.length > 0 && typeof summarize === 'function') {
    const previous = latestReadyRollup(rollups, promptVersion);
    const coveredThrough = previous?.source.toSequence ?? -1;
    const rangeEvents = older.filter((event) => event.sequence > coveredThrough);
    if (rangeEvents.length > 0) {
      const source = {
        fromSequence: previous?.source.fromSequence ?? rangeEvents[0].sequence,
        toSequence: rangeEvents.at(-1).sequence,
        fromEventId: previous?.source.fromEventId ?? rangeEvents[0].eventId,
        toEventId: rangeEvents.at(-1).eventId,
      };
      const rollupId = `${mindId}:${source.fromSequence}-${source.toSequence}:v${promptVersion}`;
      const alreadyAttempted = rollups.some((rollup) => rollup.id === rollupId);
      if (forceSummary || !alreadyAttempted) {
        const outcome = await summaryOutcome(summarize, {
          mindId,
          source,
          events: rangeEvents,
          previousSummary: previous?.summary ?? null,
          previousProvenance: previous?.provenance ?? null,
          promptVersion,
        });
        const rollup = await recordPersistentMindRollup({
          id: rollupId,
          mindId,
          status: outcome.ok ? 'ready' : 'failed',
          summary: outcome.ok ? outcome.summary : null,
          error: outcome.ok ? null : outcome.error,
          source,
          providerId,
          model,
          promptVersion,
        });
        await appendMindEvent({
          kind: 'mind.summary',
          mindId,
          // Keyed on the rollup's own createdAt (unique per attempt), not just
          // rollup.id: a forceSummary retry reuses the same rollup id, and the
          // shared ledger dedupes mind events by eventId regardless of age — an
          // id derived from rollup.id alone would make a successful retry's
          // event silently drop, leaving the replayed trajectory stuck showing
          // the earlier failed attempt forever.
          eventId: `mind-summary-${sha256Text(`${rollup.id}:${rollup.provenance.createdAt}`).slice(0, 32)}`,
          data: {
            rollupId: rollup.id,
            status: rollup.status,
            fromSequence: source.fromSequence,
            toSequence: source.toSequence,
            providerId,
            model,
            promptVersion,
            summaryText: rollup.summary,
            error: rollup.error,
          },
        });
        rollups = await readPersistentMindRollups(mindId);
      }
    }
  }

  return assemblePersistentMindContext({
    mindId,
    identity,
    events: history,
    rollups,
    maxChars,
    recentEventLimit,
    promptVersion,
  });
}

/** Add an attributable comment/idea to the trajectory. */
export function appendPersistentMindAnnotation({
  id,
  mindId = PERSISTENT_MIND_ID,
  turnId = null,
  targetEventId = null,
  text,
  at,
} = {}) {
  if (typeof id !== 'string' || !id.trim() || typeof text !== 'string' || !text.trim()) {
    return Promise.resolve({ appended: false, error: 'Annotation id and text are required' });
  }
  return appendMindEvent({
    kind: 'mind.annotation.accepted',
    mindId,
    turnId,
    at,
    eventId: `mind-annotation:${id.trim()}`,
    data: {
      annotationId: id.trim(),
      targetEventId: typeof targetEventId === 'string' ? targetEventId : null,
      displayText: text.trim(),
      textChars: text.trim().length,
    },
  });
}

/**
 * Promote one user-approved fact into the existing Brain backend. Absence of an
 * explicit `approved: true` is a refusal, not a pending or empty memory.
 */
export async function promotePersistentMindMemory({
  approved,
  mindId = PERSISTENT_MIND_ID,
  turnId = null,
  sourceEventId = null,
  content,
  summary,
  type = 'fact',
  category = 'other',
  tags = [],
  memoryApi = memoryBackend,
} = {}) {
  if (approved !== true) return { success: false, error: 'Explicit user approval is required' };
  if (typeof content !== 'string' || !content.trim()) return { success: false, error: 'Memory content is required' };
  const memory = await memoryApi.createMemory({
    type,
    content: content.trim().slice(0, 10_240),
    summary: typeof summary === 'string' ? summary.trim().slice(0, 500) : undefined,
    category,
    tags: [...new Set(Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string' && tag) : [])].slice(0, 20),
    sourceTaskId: turnId,
    sourceAgentId: mindId,
    status: 'active',
  });
  await appendMindEvent({
    kind: 'mind.memory.promoted',
    mindId,
    turnId,
    eventId: `mind-memory:${memory.id}`,
    data: {
      memoryId: memory.id,
      sourceEventId,
      type,
      category,
      approved: true,
    },
  });
  return { success: true, memory };
}
