import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import { toastWorkflowError } from '../components/musicVideo/workflowErrorToast.jsx';
import {
  getMusicVideoProject,
  startMusicVideoProduction,
  resumeMusicVideoProduction,
  stopMusicVideoProduction,
  cancelMusicVideoProduction,
} from '../services/apiMusicVideo.js';

const OUTCOME_TOASTS = {
  completed: () => toast.success('Production run finished — review the draft'),
  'needs-human': (run) => toast.info(`Production needs you: ${run.stopReason || 'check the latest draft'}`),
  'limit-reached': (run) => toast.info(`Production stopped at its limit: ${run.stopReason || ''}`),
  blocked: (run) => toast.info(`Production is blocked: ${run.stopReason || 'no allowed route can continue'}`),
  'needs-replan': () => toast.info('The creative setup changed — resume to continue against the new setup'),
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
  const [busy, setBusy] = useState(false);
  const replaceRef = useRef(replaceProject);
  const lastStatus = useRef(new Map());
  useEffect(() => {
    replaceRef.current = replaceProject;
  });

  useEffect(() => {
    if (!projectId) return undefined;
    const onProduction = (data) => {
      if (data?.projectId !== projectId) return;
      if (data.project) replaceRef.current?.(data.project);
      const run = data.run;
      if (run?.id && lastStatus.current.get(run.id) !== run.status) {
        const seen = lastStatus.current.has(run.id);
        lastStatus.current.set(run.id, run.status);
        if (seen || run.status !== 'running') OUTCOME_TOASTS[run.status]?.(run);
      }
    };
    socket.on('music-video:production', onProduction);
    return () => socket.off('music-video:production', onProduction);
  }, [projectId]);

  // A refusal for an open revision links to it; reload so the banner can show
  // a revision this tab never saw.
  const reload = () => getMusicVideoProject(projectId, { silent: true }).then((next) => replaceRef.current?.(next));

  const call = (request) => {
    setBusy(true);
    return request()
      .then((res) => {
        if (res?.project) replaceRef.current?.(res.project);
        if (res?.run) lastStatus.current.set(res.run.id, res.run.status);
        return res;
      })
      .catch((err) => { toastWorkflowError(err, 'Production request failed', { reload }); return null; })
      .finally(() => setBusy(false));
  };

  const start = (body) => call(() => startMusicVideoProduction(projectId, body, { silent: true }));
  const resume = (runId, body = {}) => call(() => resumeMusicVideoProduction(projectId, runId, body, { silent: true }));
  const stop = (runId) => call(() => stopMusicVideoProduction(projectId, runId, { silent: true }));
  const cancel = (runId) => call(() => cancelMusicVideoProduction(projectId, runId, { silent: true }));

  return { busy, start, resume, stop, cancel };
}
