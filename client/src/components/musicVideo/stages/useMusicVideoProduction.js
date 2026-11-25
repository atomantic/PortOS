/**
 * Server-owned production run (#9066): start a browserless plan → frames → clips → reviewed-draft run
 * with an allowed provider/model pool and explicit limits, and Stop / Resume / Cancel it.
 *
 * Applies the project pushed on `music-video:production` and toasts terminal outcomes. Returns `{
 * busy, start(body), resume(runId, body?), stop(runId), cancel(runId) }`. Use when: The Music Video
 * production panel.
 */

import toast from '../../ui/Toast';
import useMusicVideoRun from './useMusicVideoRun.js';
import {
  startMusicVideoProduction,
  resumeMusicVideoProduction,
  stopMusicVideoProduction,
  cancelMusicVideoProduction,
} from '../../../services/apiMusicVideo.js';

const OUTCOME_TOASTS = {
  completed: () => toast.success('Production run finished — review the draft'),
  'needs-human': (run) => toast.info(`Production needs you: ${run.stopReason || 'check the latest draft'}`),
  'limit-reached': (run) => toast.info(`Production stopped at its limit: ${run.stopReason || ''}`),
  blocked: (run) => toast.info(`Production is blocked: ${run.stopReason || 'no allowed route can continue'}`),
  'needs-replan': () => toast.info('The creative setup changed — resume to continue against the new setup'),
  'awaiting-video': () => toast.info('Every shot has its still. Resume production to make the clips'),
  failed: (run) => toast.error(`Production failed: ${run.stopReason || run.error || 'unknown error'}`),
};

/**
 * Server-owned production run (#9066). Only an explicit `start`/`resume` runs
 * anything; the server dispatches every frame, clip and revision itself, so
 * this hook only applies the project it pushes over `music-video:production`
 * (no polling) and reports terminal outcomes.
 *
 * Returns `{ busy, start(body), resume(runId, body?), stop(runId), cancel(runId) }`.
 */
export default function useMusicVideoProduction({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const { busy, call } = useMusicVideoRun({
    projectId,
    event: 'music-video:production',
    toasts: OUTCOME_TOASTS,
    errorLabel: 'Production request failed',
    replaceProject,
  });

  const start = (body) => call(() => startMusicVideoProduction(projectId, body, { silent: true }));
  const resume = (runId, body = {}) => call(() => resumeMusicVideoProduction(projectId, runId, body, { silent: true }));
  const stop = (runId) => call(() => stopMusicVideoProduction(projectId, runId, { silent: true }));
  const cancel = (runId) => call(() => cancelMusicVideoProduction(projectId, runId, { silent: true }));

  return { busy, start, resume, stop, cancel };
}
