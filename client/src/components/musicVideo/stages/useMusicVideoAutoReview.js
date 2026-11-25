/**
 * Opt-in automatic review/retries (#8988): start a run over a draft window with explicit review
 * (`maxAttempts`) and paid-generation (`maxGenerations`) limits plus a vision reviewer.
 *
 * Applies the project pushed on `music-video:auto-review` and reports outcomes; the server generates
 * a run's revised sections itself (#10014), so the board never submits them and a run completes with
 * no tab open. Returns `{ busy, action, start(startSec, endSec, limits, reviewer), resume(runId,
 * limits?), stop(runId), cancel(runId) }`. Use when: The Music Video excerpt panel.
 */

import { useEffect, useState } from 'react';
import toast from '../../ui/Toast';
import useMusicVideoRun from './useMusicVideoRun.js';
import {
  startMusicVideoAutoReview,
  resumeMusicVideoAutoReview,
  stopMusicVideoAutoReview,
  cancelMusicVideoAutoReview,
} from '../../../services/apiMusicVideo.js';

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
 * reviews it, revises only the flagged sections and generates them itself
 * (#10014) — so a run completes with no tab open and a tab never submits a
 * second copy. It reports each step over the `music-video:auto-review` socket
 * event; this hook only applies the pushed project and surfaces outcomes.
 *
 * Returns `{ busy, action, start(startSec, endSec, limits, reviewer), resume(runId, limits?), stop(runId), cancel(runId) }`
 * — `action` is the latest step the server reported for this project's run.
 */
export default function useMusicVideoAutoReview({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const [action, setAction] = useState(null);
  useEffect(() => {
    setAction(null);
  }, [projectId]);

  const { busy, call } = useMusicVideoRun({
    projectId,
    event: 'music-video:auto-review',
    toasts: OUTCOME_TOASTS,
    errorLabel: 'Auto-review request failed',
    replaceProject,
    onEvent: (data) => setAction(data.action || null),
  });

  const start = (startSec, endSec, limits, { providerId = null, model = null } = {}) =>
    call(() => startMusicVideoAutoReview(projectId, {
      startSec, endSec, limits, ...(providerId ? { providerId } : {}), ...(model ? { model } : {}),
    }, { silent: true }));
  const resume = (runId, limits) => call(() => resumeMusicVideoAutoReview(projectId, runId, limits ? { limits } : {}, { silent: true }));
  const stop = (runId) => call(() => stopMusicVideoAutoReview(projectId, runId, { silent: true }));
  const cancel = (runId) => call(() => cancelMusicVideoAutoReview(projectId, runId, { silent: true }));

  return { busy, action, start, resume, stop, cancel };
}
