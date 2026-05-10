/**
 * Pipeline — Auto-runner for the text-stage chain
 *
 * Runs idea → prose → (comicScript + tvScript in parallel) for one issue and
 * streams progress to attached SSE clients. Visual stages (comicPages,
 * storyboards, episodeVideo) stay manual — burning GPU minutes on
 * un-reviewed content is too expensive for the MVP.
 *
 * Cancel: in-memory flag checked between stages. The coordinator stops
 * before kicking off the next stage; an already-in-flight LLM call still
 * completes (we don't kill the runner mid-stream).
 *
 * SSE: a single in-memory `runs` map keyed by `issueId`. Late-connecting
 * clients receive the last broadcast frame via `attachSseClient`'s replay
 * grace window in lib/sseUtils.js.
 */

import { randomUUID } from 'crypto';
import { broadcastSse, attachSseClient, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { generateStage } from './textStages.js';
import { getIssue, updateIssue } from './issues.js';

// runs: Map<issueId, { runId, clients[], lastPayload, cancelRequested, startedAt }>
const runs = new Map();

export function isAutoRunActive(issueId) {
  return runs.has(issueId);
}

export function attachClient(issueId, res) {
  return attachSseClient(runs, issueId, res);
}

export function cancelAutoRun(issueId) {
  const run = runs.get(issueId);
  if (!run) return false;
  run.cancelRequested = true;
  return true;
}

function broadcast(issueId, payload) {
  const run = runs.get(issueId);
  if (!run) return;
  broadcastSse(run, payload);
}

/**
 * Kick off the text-stage chain for an issue. Returns the runId immediately;
 * progress lands via SSE. Idempotent in the sense that re-calling while a
 * run is in flight resolves to the existing runId.
 */
export async function startAutoRunTextStages(issueId, options = {}) {
  if (runs.has(issueId)) return { runId: runs.get(issueId).runId, alreadyRunning: true };
  const runId = randomUUID();
  const record = {
    runId,
    clients: [],
    lastPayload: null,
    cancelRequested: false,
    startedAt: new Date().toISOString(),
  };
  runs.set(issueId, record);

  // Kick off the coordinator without awaiting. The outer try/catch is the one
  // permitted boundary use of try/catch in this module — without it an LLM
  // rejection would surface as an unhandledRejection on Node ≥15 and kill the
  // process. See ~/.claude skill `nodejs-async-event-listener-unhandled-rejection`.
  (async () => {
    await updateIssue(issueId, { status: 'running' }).catch(() => null);
    broadcast(issueId, { type: 'start', runId, stages: ['idea', 'prose', 'comicScript', 'tvScript'] });

    try {
      // Stage 1: idea — skip if already ready/edited and not force-rerun
      if (!record.cancelRequested) {
        await runStageIfNeeded(issueId, 'idea', options);
      }
      // Stage 2: prose — depends on idea
      if (!record.cancelRequested) {
        await runStageIfNeeded(issueId, 'prose', options);
      }
      // Stage 3: comicScript + tvScript in parallel — both depend only on prose
      if (!record.cancelRequested) {
        await Promise.all([
          runStageIfNeeded(issueId, 'comicScript', options),
          runStageIfNeeded(issueId, 'tvScript', options),
        ]);
      }

      const status = record.cancelRequested ? 'needs-review' : 'needs-review';
      await updateIssue(issueId, { status }).catch(() => null);
      broadcast(issueId, {
        type: record.cancelRequested ? 'canceled' : 'complete',
        runId,
        completedAt: new Date().toISOString(),
      });
      console.log(`✅ Pipeline auto-run ${record.cancelRequested ? 'canceled' : 'complete'} — issue=${issueId.slice(0, 8)} runId=${runId.slice(0, 8)}`);
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 1000);
      console.error(`❌ Pipeline auto-run failed — issue=${issueId.slice(0, 8)} ${message}`);
      await updateIssue(issueId, { status: 'needs-review' }).catch(() => null);
      broadcast(issueId, { type: 'error', runId, error: message, failedAt: new Date().toISOString() });
    } finally {
      // Hold the SSE list open briefly so late-attaching clients still see
      // the terminal frame via replay (matches mediaJobQueue's behavior).
      closeJobAfterDelay(runs, issueId);
    }
  })();

  return { runId, alreadyRunning: false };
}

async function runStageIfNeeded(issueId, stageId, options) {
  const issue = await getIssue(issueId);
  const cur = issue.stages?.[stageId];
  // Skip if the user has already populated this stage and we aren't forced.
  // 'edited' = user typed into the editor; 'ready' = LLM filled and user
  // hasn't asked to rerun. Both are good — fall through to the next stage.
  if (!options.force && cur && (cur.status === 'ready' || cur.status === 'edited') && cur.output) {
    broadcast(issueId, { type: 'skip', stage: stageId, reason: 'already populated' });
    return;
  }
  broadcast(issueId, { type: 'stage:start', stage: stageId });
  const { stage } = await generateStage(issueId, stageId, options);
  broadcast(issueId, {
    type: 'stage:complete',
    stage: stageId,
    status: stage.status,
    length: stage.output?.length || 0,
  });
}

// Export internals for tests.
export const __testing = { runs };
