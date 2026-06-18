/**
 * Pipeline — Auto-runner for the text-stage chain
 *
 * Runs idea → prose → (comicScript + teleplay in parallel) for one issue and
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

import { broadcastSse, createSseRunner } from '../../lib/sseUtils.js';
import { generateStage } from './textStages.js';
import { getIssue, updateIssue, isStageReady } from './issues.js';
import { startEpisodeVideoForIssue, ERR_NO_STORYBOARDS } from './episodeVideo.js';

// Shared SSE run-lifecycle: a `runs` map keyed by issueId, plus the
// coalesce/restart/grace-window/finished/cleanup semantics. This runner keeps
// its own error handling inside `work` (it must flip the issue to
// 'needs-review' and emit a matching error frame), so the factory's generic
// catch is only the safety net.
const runner = createSseRunner({ logLabel: 'pipeline auto-run' });

export function isAutoRunActive(issueId) {
  return runner.isActive(issueId);
}

export function attachClient(issueId, res) {
  return runner.attachClient(issueId, res);
}

export function cancelAutoRun(issueId) {
  return runner.cancel(issueId);
}

function broadcast(issueId, payload) {
  const run = runner.runs.get(issueId);
  if (!run) return;
  broadcastSse(run, payload);
}

/**
 * Kick off the text-stage chain for an issue. Returns the runId immediately;
 * progress lands via SSE. Idempotent in the sense that re-calling while a
 * run is in flight resolves to the existing runId.
 */
export async function startAutoRunTextStages(issueId, options = {}) {
  if (runner.isActive(issueId)) {
    return { runId: runner.runs.get(issueId).runId, alreadyRunning: true };
  }
  // Which script stages to adapt from prose. Defaults to both (manual auto-run
  // from the UI); callers targeting a single format (e.g. Series Autopilot on a
  // comic-only series) pass `scripts: ['comicScript']` to skip the off-target
  // stage and its LLM call. Unknown entries are filtered out.
  const VALID_SCRIPTS = ['comicScript', 'teleplay'];
  const scripts = Array.isArray(options.scripts) && options.scripts.length
    ? VALID_SCRIPTS.filter((s) => options.scripts.includes(s))
    : VALID_SCRIPTS;

  return runner.start(issueId, async ({ runId, record }) => {
    await updateIssue(issueId, { status: 'running' }).catch(() => null);
    broadcast(issueId, { type: 'start', runId, stages: ['idea', 'prose', ...scripts] });

    // Own the error frame + status flip here (and swallow) so the factory's
    // generic catch doesn't double-emit; without it an LLM rejection would
    // surface as an unhandledRejection on Node ≥15 and kill the process.
    try {
      // Stage 1: idea — skip if already ready/edited and not force-rerun
      if (!record.cancelRequested) {
        await runStageIfNeeded(issueId, 'idea', options);
      }
      // Stage 2: prose — depends on idea. SKIP when the issue arrived
      // script-first (an imported comic seeds stages.comicScript ready with
      // prose empty): forward-generating prose here would synthesize content
      // the authored script was never derived from, burn tokens, and — because
      // editorialAnalysis prefers prose — make the Reader Map analyze the
      // generated prose instead of the user's verbatim script. A backport
      // (Create → Importer) is the deliberate way to fill prose from the
      // script. `force` still regenerates.
      let scriptFirstSkip = false;
      if (!record.cancelRequested) {
        const proseIssue = await getIssue(issueId);
        const proseEmpty = !isStageReady(proseIssue.stages?.prose);
        const scriptAuthored = isStageReady(proseIssue.stages?.comicScript)
          || isStageReady(proseIssue.stages?.teleplay);
        if (proseEmpty && scriptAuthored && !options.force) {
          scriptFirstSkip = true;
          broadcast(issueId, { type: 'skip', stage: 'prose', reason: 'script already authored (imported script-first) — not back-filling prose' });
        } else {
          await runStageIfNeeded(issueId, 'prose', options);
        }
      }
      // Stage 3: comicScript + teleplay in parallel — both derive from prose.
      // When prose was skipped (script-first import), a script stage that ISN'T
      // already authored has no source to adapt — generating it would burn an
      // LLM call on empty prose and persist a bogus 'ready' stage. Skip those;
      // the authored script runs through runStageIfNeeded and is skipped as
      // already-ready. `force` still regenerates everything.
      if (!record.cancelRequested) {
        await Promise.all(scripts.map(async (stageId) => {
          if (scriptFirstSkip && !options.force) {
            const iss = await getIssue(issueId);
            if (!isStageReady(iss.stages?.[stageId])) {
              broadcast(issueId, { type: 'skip', stage: stageId, reason: 'no prose to adapt (imported script-first)' });
              return;
            }
          }
          return runStageIfNeeded(issueId, stageId, options);
        }));
      }

      // Optional Stage 4: episode video. Gated behind `includeVideo: true` so
      // the default auto-run still stops before burning GPU minutes. The CD
      // pipeline runs entirely server-side and takes minutes per scene — we
      // fire-and-forget the kickoff and surface the cdProjectId via SSE so
      // the UI can switch to polling the CD project for progress.
      if (options.includeVideo && !record.cancelRequested) {
        broadcast(issueId, { type: 'stage:start', stage: 'episodeVideo' });
        const kickoff = await startEpisodeVideoForIssue(issueId, {
          aspectRatio: options.aspectRatio,
          quality: options.quality,
          modelId: options.modelId,
        }).catch((err) => {
          if (err?.code === ERR_NO_STORYBOARDS) {
            broadcast(issueId, { type: 'skip', stage: 'episodeVideo', reason: 'storyboards stage has no scenes — fill it in first' });
            return null;
          }
          broadcast(issueId, { type: 'stage:error', stage: 'episodeVideo', error: (err?.message || String(err)).slice(0, 500) });
          return null;
        });
        if (kickoff) {
          broadcast(issueId, {
            type: 'stage:complete',
            stage: 'episodeVideo',
            cdProjectId: kickoff.cdProjectId,
            scenes: kickoff.scenes,
            reused: kickoff.reused,
          });
        }
      }

      await updateIssue(issueId, { status: 'needs-review' }).catch(() => null);
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
      // Swallow: the error frame + status flip above are the terminal handling.
      // The factory's finally marks the run finished and schedules the replay
      // grace-window cleanup.
    }
  });
}

async function runStageIfNeeded(issueId, stageId, options) {
  const issue = await getIssue(issueId);
  if (!options.force && isStageReady(issue.stages?.[stageId])) {
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

/**
 * Boot-time recovery for issues stuck in `status: 'running'`.
 *
 * The in-memory `runs` map is lost on server restart — there's no way to
 * reattach SSE to the dead run, and the issue would remain stuck in
 * `running` forever (the UI shows a spinner that never resolves).
 *
 * On boot, walk every issue and demote any `running` to `needs-review` (the
 * same terminal state a normal-completion path lands on). Idempotent. Fires
 * as a fire-and-forget side effect; failures are logged but never escalated
 * — the listIssues call has its own error handling and an exception here
 * shouldn't block server startup.
 *
 * Mirrors writers-room/evaluator.js#recoverStuckAnalyses.
 */
export async function recoverStuckAutoRuns() {
  const { listIssues } = await import('./issues.js');
  const all = await listIssues().catch(() => []);
  const stuck = all.filter((i) => i.status === 'running');
  if (stuck.length === 0) return 0;
  for (const issue of stuck) {
    await updateIssue(issue.id, { status: 'needs-review' }).catch(() => null);
  }
  console.log(`📝 pipeline: recovered ${stuck.length} stuck auto-run${stuck.length === 1 ? '' : 's'} on boot`);
  return stuck.length;
}

// Export internals for tests.
export const __testing = { runs: runner.runs };
