import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import {
  cancelAutonomousMusicVideo,
  resumeAutonomousMusicVideo,
  stopAutonomousMusicVideo,
} from '../services/apiMusicVideo.js';

const OUTCOME_TOASTS = {
  'awaiting-approval': (run) => toast.info(`Autonomous music video is waiting for your approval of the ${run.awaiting || 'last'} step`),
  'needs-human': (run) => toast.info(`Autonomous music video needs you: ${run.error || 'check the run'}`),
  completed: () => toast.success('Autonomous music video finished — review it'),
  failed: (run) => toast.error(`Autonomous music video failed: ${run.error || 'unknown error'}`),
};

/**
 * Fully-autonomous run (prompt → lyrics → Suno song → video). Starting one is
 * the Music Video page's create flow; this hook owns what happens afterwards:
 * it applies the project the server pushes over `music-video:autonomous` (no
 * polling) and toasts the outcomes that need the director.
 *
 * Returns `{ busy, resume(edits?), stop(), cancel() }`.
 */
export default function useAutonomousMusicVideo({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const [busy, setBusy] = useState(false);
  const replaceRef = useRef(replaceProject);
  const lastStatus = useRef({ id: null, status: null }); // a project has one run
  useEffect(() => {
    replaceRef.current = replaceProject;
  });

  useEffect(() => {
    if (!projectId) return undefined;
    const onAutonomous = (data) => {
      if (data?.projectId !== projectId) return;
      if (data.project) replaceRef.current?.(data.project);
      const run = data.run;
      if (run?.id && lastStatus.current.status !== run.status) {
        const seen = lastStatus.current.id === run.id;
        lastStatus.current = { id: run.id, status: run.status };
        if (seen || run.status !== 'running') OUTCOME_TOASTS[run.status]?.(run);
      }
    };
    socket.on('music-video:autonomous', onAutonomous);
    return () => socket.off('music-video:autonomous', onAutonomous);
  }, [projectId]);

  const call = (request) => {
    setBusy(true);
    return request()
      .then((res) => {
        if (res?.project) replaceRef.current?.(res.project);
        if (res?.run) lastStatus.current = { id: res.run.id, status: res.run.status };
        return res;
      })
      .catch((err) => { toast.error(err?.message || 'Autonomous run request failed'); return null; })
      .finally(() => setBusy(false));
  };

  const resume = (edits = {}) => call(() => resumeAutonomousMusicVideo(projectId, edits, { silent: true }));
  const stop = () => call(() => stopAutonomousMusicVideo(projectId, { silent: true }));
  const cancel = () => call(() => cancelAutonomousMusicVideo(projectId, { silent: true }));

  return { busy, resume, stop, cancel };
}
