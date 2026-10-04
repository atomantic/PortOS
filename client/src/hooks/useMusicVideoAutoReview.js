import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import { toastWorkflowError } from '../components/musicVideo/workflowErrorToast.jsx';
import {
  getMusicVideoProject,
  startMusicVideoAutoReview,
  resumeMusicVideoAutoReview,
  stopMusicVideoAutoReview,
  cancelMusicVideoAutoReview,
} from '../services/apiMusicVideo.js';

const OUTCOME_TOASTS = {
  passed: (run) => toast.success(`Auto-review passed after ${run.attempts.length} attempt${run.attempts.length === 1 ? '' : 's'}`),
  'needs-human': (run) => toast.info(`Auto-review needs you: ${run.stopReason || 'watch the latest draft'}`),
  'limit-reached': (run) => toast.info(`Auto-review stopped at its limit: ${run.stopReason || ''}`),
  failed: (run) => toast.error(`Auto-review failed: ${run.stopReason || run.error || 'unknown error'}`),
};

/**
 * Opt-in automatic review/retries (#8988). A run is started only by the
 * director, with explicit limits on reviews (`maxAttempts`) and paid
 * generations (`maxGenerations`); the server then renders the draft window,
 * reviews it, and revises only the flagged sections, reporting each step over
 * the `music-video:auto-review` socket event. This hook applies the pushed
 * project, and — while the board is open — submits the sections a run hands
 * out through the board's normal scene lanes (`submitSections`, from
 * `useMusicVideoRevisions`), tagged with the run's revision so the server's
 * enqueue guard charges them against the spend limit.
 *
 * Returns `{ busy, action, start(startSec, endSec, limits, reviewer), resume(runId, limits?), stop(runId), cancel(runId) }`
 * — `action` is the latest step the server reported for this project's run.
 */
export default function useMusicVideoAutoReview({ project, replaceProject, submitSections } = {}) {
  const projectId = project?.id || null;
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState(null);
  const handlers = useRef({ replaceProject, submitSections });
  const lastStatus = useRef(new Map());
  useEffect(() => {
    handlers.current = { replaceProject, submitSections };
  });

  useEffect(() => {
    if (!projectId) return undefined;
    setAction(null);
    const onAutoReview = (data) => {
      if (data?.projectId !== projectId) return;
      const { replaceProject: replace, submitSections: submit } = handlers.current;
      if (data.project) replace?.(data.project);
      setAction(data.action || null);
      // Only a RUNNING run's hand-out is submitted — never one that raced a pause.
      // A run a production owns (#9066) is dispatched by the server, not the board.
      if (data.action?.type === 'generate' && data.run?.status === 'running' && !data.run.productionRunId
        && data.action.sections?.length && submit) {
        // The hand-out is the only thing driving a board-owned run forward, so a
        // throw here must not vanish: say so and point at Continue (#9940).
        // (The executor runs synchronously, so the hand-out starts this tick.)
        new Promise((resolve) => resolve(submit(data.project, data.action.sections, data.action.revisionId))).then((n) => {
          if (n) toast.info(`Auto-review: generating ${n} revised section${n === 1 ? '' : 's'}`);
        }).catch((err) => {
          console.error(`❌ Music Video auto-review hand-out failed: ${err?.message || 'unknown error'}`);
          toast.error(`Auto-review could not start its revised sections (${err?.message || 'unexpected error'}) — use Continue under "Needs attention" to try again.`);
        });
      }
      const run = data.run;
      if (run?.id && lastStatus.current.get(run.id) !== run.status) {
        const seen = lastStatus.current.has(run.id);
        lastStatus.current.set(run.id, run.status);
        if (seen || run.status !== 'running') OUTCOME_TOASTS[run.status]?.(run);
      }
    };
    socket.on('music-video:auto-review', onAutoReview);
    return () => socket.off('music-video:auto-review', onAutoReview);
  }, [projectId]);

  // A refusal for an open revision links to it; reload so the banner can show
  // a revision this tab never saw.
  const reload = () => getMusicVideoProject(projectId, { silent: true }).then((next) => handlers.current.replaceProject?.(next));

  const call = (request) => {
    setBusy(true);
    return request()
      .then((res) => {
        if (res?.project) handlers.current.replaceProject?.(res.project);
        if (res?.run) lastStatus.current.set(res.run.id, res.run.status);
        return res;
      })
      .catch((err) => { toastWorkflowError(err, 'Auto-review request failed', { reload }); return null; })
      .finally(() => setBusy(false));
  };

  const start = (startSec, endSec, limits, { providerId = null, model = null } = {}) =>
    call(() => startMusicVideoAutoReview(projectId, {
      startSec, endSec, limits, ...(providerId ? { providerId } : {}), ...(model ? { model } : {}),
    }, { silent: true }));
  const resume = (runId, limits) => call(() => resumeMusicVideoAutoReview(projectId, runId, limits ? { limits } : {}, { silent: true }));
  const stop = (runId) => call(() => stopMusicVideoAutoReview(projectId, runId, { silent: true }));
  const cancel = (runId) => call(() => cancelMusicVideoAutoReview(projectId, runId, { silent: true }));

  return { busy, action, start, resume, stop, cancel };
}
