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

import { createSseRunner } from '../../lib/sseUtils.js';
import { generateStage } from './textStages.js';
import { listIssues, isStageReady } from './issues.js';
import { getSeries } from './series.js';
import { compareIssuesByPosition } from './arcPlanner.js';
import { getSeason } from './seasons.js';

// Shared SSE run-lifecycle keyed by seasonId. This runner keeps its own error
// frame + per-issue catch inside `work`, so the factory's generic catch is only
// the safety net.
const runner = createSseRunner({ logLabel: 'pipeline volume-beats' });

export const VOLUME_BEATS_MODES = Object.freeze(['skip-existing', 'regenerate-all']);

export function isVolumeBeatsRunActive(seasonId) {
  return runner.isActive(seasonId);
}

export function attachClient(seasonId, res) {
  return runner.attachClient(seasonId, res);
}

export function cancelVolumeBeatsRun(seasonId) {
  return runner.cancel(seasonId);
}

/**
 * Kick off the volume beat-sheet chain. Returns the runId immediately;
 * progress lands via SSE. Idempotent when a run is in flight for this volume.
 */
export async function startVolumeBeatsRun(seriesId, seasonId, options = {}) {
  if (runner.isActive(seasonId)) {
    return { runId: runner.runs.get(seasonId).runId, alreadyRunning: true };
  }
  // Validate scope up front — bad ids should 404 before we kick off, not
  // surface as a deferred SSE error frame.
  await getSeries(seriesId);
  await getSeason(seriesId, seasonId);

  const mode = VOLUME_BEATS_MODES.includes(options.mode) ? options.mode : 'skip-existing';

  return runner.start(seasonId, async ({ runId, record, broadcast }) => {
    // Own the error frame here (and swallow) so the factory's generic catch
    // doesn't double-emit; without it an LLM rejection would surface as an
    // unhandledRejection and kill the process.
    try {
      const all = await listIssues({ seriesId });
      const volumeIssues = all
        .filter((i) => i.seasonId === seasonId)
        .sort(compareIssuesByPosition);

      broadcast({
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
          broadcast({
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

        broadcast({
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
            // Soft run-level default (Series Autopilot, #1514) — forwarded
            // alongside the hard providerId so a per-stage pin still wins.
            providerIdDefault: options.providerIdDefault,
            model: options.model,
          });
          generated += 1;
          broadcast({
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
          broadcast({
            type: 'issue:error',
            issueId: issue.id,
            ordinal,
            total,
            error: (err?.message || String(err)).slice(0, 500),
          });
        }
      }

      broadcast({
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
      broadcast({ type: 'error', runId, error: message, failedAt: new Date().toISOString() });
      // Swallow: the error frame above is the terminal handling. The factory's
      // finally marks the run finished and schedules the replay-window cleanup.
    }
  });
}

// Export internals for tests.
export const __testing = { runs: runner.runs };
