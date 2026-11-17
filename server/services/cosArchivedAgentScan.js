/**
 * One shared read of the archived agent `metadata.json` files behind the CoS
 * Learning tab's stats (#16593): `scanArchivedAgents()` feeds both the feedback
 * stats and the reviewer verdict stats, so opening the tab reads each record once.
 *
 * Each record is kept between requests as a small projection (its verdicts and,
 * when rated, its feedback, description and precomputed task type), never the
 * whole record: archived metadata can carry megabyte-scale summaries. A new or re-dated
 * index entry is read fresh; any archive write calls `invalidateArchivedRecord`,
 * whose epoch bump resets the cache, so a changed record is re-read. Concurrent
 * callers at one epoch share a single pass. Nothing is filled until a stat asks.
 */

import { join } from 'node:path';
import { safeJSONParse, tryReadFileStrict } from '../lib/fileUtils.js';
import { hasValidAgentFeedback } from '../lib/cosAgentFeedback.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import { extractTaskType } from '../lib/taskTypeBucket.js';
import { archivedRecordCacheEpoch, getAgentDir, loadAgentIndex } from './cosAgentIndex.js';

// Bounded fan-out so a long-lived install does not open every metadata file at once.
const ARCHIVE_READ_BATCH_SIZE = 50;
const scanFlight = createSingleFlight();
let cache = { epoch: -1, index: null, byId: new Map() };

/** The task-type bucket a rated run counts under in the feedback stats. */
export function feedbackTaskType(agent) {
  return extractTaskType({
    description: agent?.metadata?.taskDescription,
    metadata: agent?.metadata,
    taskType: agent?.metadata?.taskType,
  });
}

function project(agentId, date, raw) {
  return {
    date,
    verdicts: Array.isArray(raw?.metadata?.reviewVerdicts) ? raw.metadata.reviewVerdicts : null,
    feedbackAgent: hasValidAgentFeedback(raw)
      ? {
        id: raw.id || raw.agentId || agentId,
        feedback: raw.feedback,
        metadata: { taskDescription: raw.metadata?.taskDescription },
        feedbackTaskType: feedbackTaskType(raw),
      }
      : null,
  };
}

async function readArchive() {
  const epoch = archivedRecordCacheEpoch();
  const index = await loadAgentIndex();
  if (cache.epoch !== epoch || cache.index !== index) cache = { epoch, index, byId: new Map() };
  const { byId } = cache;
  for (const agentId of byId.keys()) if (!index.has(agentId)) byId.delete(agentId);
  const missing = [...index.entries()].filter(([agentId, date]) => byId.get(agentId)?.date !== date);
  let unreadable = 0;
  for (let i = 0; i < missing.length; i += ARCHIVE_READ_BATCH_SIZE) {
    await Promise.all(missing.slice(i, i + ARCHIVE_READ_BATCH_SIZE).map(async ([agentId, date]) => {
      const { ok, value } = await tryReadFileStrict(join(getAgentDir(agentId, date), 'metadata.json'));
      // Unreadable or unparseable is counted, not cached, so it is retried next time;
      // an absent file is cached as a record with nothing to contribute.
      if (!ok) { unreadable++; return; }
      const raw = value ? safeJSONParse(value, null, { allowArray: false }) : null;
      if (value && !raw) { unreadable++; return; }
      byId.set(agentId, project(agentId, date, raw));
    }));
  }
  return { byId, unreadable };
}

/**
 * `{ byId: Map<agentId, { date, verdicts, feedbackAgent }>, unreadable }`, where
 * `unreadable` counts archived records that could not be read on this pass.
 */
export function scanArchivedAgents() {
  return scanFlight.run(archivedRecordCacheEpoch(), readArchive);
}
