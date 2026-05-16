/**
 * Pipeline — Volume Beat-Sheet Runner
 *
 * Runs the idea stage sequentially across every issue in a volume so each
 * generation picks up the prior issue's freshly-persisted beats via
 * `buildIdeaContextAugment` (which re-reads neighbors per call). Parallel
 * generation would defeat that — the second issue's prompt would still see
 * the first issue's *synopsis* instead of its newly-written beats.
 *
 * Mirrors `autoRunner.js`: per-volume in-memory record keyed by `seasonId`,
 * SSE progress to attached clients, cancel flag checked between issues.
 *
 * Two modes:
 *   - 'skip-existing' (default): issues whose idea stage is ready/edited with
 *     output stay untouched; only empty/error/draft slots are filled.
 *   - 'regenerate-all': overwrites every issue's beat sheet.
 *
 * Frame shapes broadcast over SSE:
 *   { type: 'start',         runId, seasonId, total, planned: [issueIds] }
 *   { type: 'issue:skip',    issueId, ordinal, total, reason }
 *   { type: 'issue:start',   issueId, issueNumber, issueTitle, ordinal, total }
 *   { type: 'issue:complete',issueId, ordinal, total, status, length, runId }
 *   { type: 'issue:error',   issueId, ordinal, total, error }
 *   { type: 'complete',      runId, generated, skipped, errored, completedAt }
 *   { type: 'canceled',      runId, completedAt }
 *   { type: 'error',         runId, error, failedAt }
 */

import { randomUUID } from 'crypto';
import { broadcastSse, attachSseClient, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { generateStage } from './textStages.js';
import { listIssues, isStageReady } from './issues.js';
import { getSeries } from './series.js';
import { compareIssuesByPosition } from './arcPlanner.js';
import { getSeason } from './seasons.js';

// runs: Map<seasonId, { runId, clients[], lastPayload, cancelRequested, startedAt }>
const runs = new Map();

export const VOLUME_BEATS_MODES = Object.freeze(['skip-existing', 'regenerate-all']);

export function isVolumeBeatsRunActive(seasonId) {
  return runs.has(seasonId);
}

export function attachClient(seasonId, res) {
  return attachSseClient(runs, seasonId, res);
}

export function cancelVolumeBeatsRun(seasonId) {
  const run = runs.get(seasonId);
  if (!run) return false;
  run.cancelRequested = true;
  return true;
}

function broadcast(seasonId, payload) {
  const run = runs.get(seasonId);
  if (!run) return;
  broadcastSse(run, payload);
}

/**
 * Kick off the volume beat-sheet chain. Returns the runId immediately;
 * progress lands via SSE. Idempotent when a run is in flight for this volume.
 */
export async function startVolumeBeatsRun(seriesId, seasonId, options = {}) {
  if (runs.has(seasonId)) {
    return { runId: runs.get(seasonId).runId, alreadyRunning: true };
  }
  // Validate scope up front — bad ids should 404 before we kick off, not
  // surface as a deferred SSE error frame.
  await getSeries(seriesId);
  await getSeason(seriesId, seasonId);

  const mode = VOLUME_BEATS_MODES.includes(options.mode) ? options.mode : 'skip-existing';
  const runId = randomUUID();
  const record = {
    runId,
    clients: [],
    lastPayload: null,
    cancelRequested: false,
    startedAt: new Date().toISOString(),
  };
  runs.set(seasonId, record);

  (async () => {
    // Outer try/catch is the one permitted boundary — without it an LLM
    // rejection would surface as an unhandledRejection and kill the process.
    try {
      const all = await listIssues({ seriesId });
      const volumeIssues = all
        .filter((i) => i.seasonId === seasonId)
        .sort(compareIssuesByPosition);

      broadcast(seasonId, {
        type: 'start',
        runId,
        seasonId,
        mode,
        total: volumeIssues.length,
        planned: volumeIssues.map((i) => i.id),
      });

      let generated = 0;
      let skipped = 0;
      let errored = 0;

      for (let idx = 0; idx < volumeIssues.length; idx += 1) {
        if (record.cancelRequested) break;
        const ordinal = idx + 1;
        const total = volumeIssues.length;
        const issue = volumeIssues[idx];

        if (mode === 'skip-existing' && isStageReady(issue.stages?.idea)) {
          skipped += 1;
          broadcast(seasonId, {
            type: 'issue:skip',
            issueId: issue.id,
            issueNumber: issue.number,
            issueTitle: issue.title,
            ordinal,
            total,
            reason: 'beats already present',
          });
          continue;
        }

        broadcast(seasonId, {
          type: 'issue:start',
          issueId: issue.id,
          issueNumber: issue.number,
          issueTitle: issue.title,
          ordinal,
          total,
        });

        // Per-issue catch so one bad issue doesn't abort the rest of the
        // chain — we surface the error frame and move on. The stage record
        // is already marked 'error' inside generateStage's own catch.
        try {
          const { stage, runId: stageRunId } = await generateStage(issue.id, 'idea', {
            providerId: options.providerId,
            model: options.model,
          });
          generated += 1;
          broadcast(seasonId, {
            type: 'issue:complete',
            issueId: issue.id,
            ordinal,
            total,
            status: stage.status,
            length: stage.output?.length || 0,
            runId: stageRunId,
          });
        } catch (err) {
          errored += 1;
          broadcast(seasonId, {
            type: 'issue:error',
            issueId: issue.id,
            ordinal,
            total,
            error: (err?.message || String(err)).slice(0, 500),
          });
        }
      }

      broadcast(seasonId, {
        type: record.cancelRequested ? 'canceled' : 'complete',
        runId,
        generated,
        skipped,
        errored,
        completedAt: new Date().toISOString(),
      });
      console.log(`✅ Pipeline volume-beats ${record.cancelRequested ? 'canceled' : 'complete'} — season=${seasonId.slice(0, 8)} runId=${runId.slice(0, 8)} generated=${generated} skipped=${skipped} errored=${errored}`);
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 1000);
      console.error(`❌ Pipeline volume-beats failed — season=${seasonId.slice(0, 8)} ${message}`);
      broadcast(seasonId, { type: 'error', runId, error: message, failedAt: new Date().toISOString() });
    } finally {
      closeJobAfterDelay(runs, seasonId);
    }
  })();

  return { runId, alreadyRunning: false };
}

// Export internals for tests.
export const __testing = { runs };
