import { useEffect, useRef, useState } from 'react';
import socket from '../../../services/socket';
import { getMusicVideoProject } from '../../../services/apiMusicVideo.js';
import { toastWorkflowError } from '../workflowErrorToast.jsx';

export default function useMusicVideoRun({ projectId, event, toasts, errorLabel, replaceProject, onEvent }) {
  const [busy, setBusy] = useState(false);
  const handlers = useRef({ replaceProject, onEvent, toasts });
  const scopeRef = useRef(null);

  useEffect(() => {
    handlers.current = { replaceProject, onEvent, toasts };
  }, [replaceProject, onEvent, toasts]);

  useEffect(() => {
    setBusy(false);
    if (!projectId) return undefined;

    const scope = { projectId, event, statuses: new Map(), pending: 0 };
    scopeRef.current = scope;
    const receive = (data) => {
      if (scopeRef.current !== scope || data?.projectId !== projectId) return;
      const current = handlers.current;
      if (data.project) current.replaceProject?.(data.project);
      current.onEvent?.(data);
      const run = data.run;
      if (!run?.id || scope.statuses.get(run.id) === run.status) return;
      const seen = scope.statuses.has(run.id);
      scope.statuses.set(run.id, run.status);
      if (seen || run.status !== 'running') current.toasts[run.status]?.(run);
    };

    socket.on(event, receive);
    return () => {
      scopeRef.current = null;
      socket.off(event, receive);
    };
  }, [projectId, event]);

  const call = async (request, { inline = false } = {}) => {
    const scope = scopeRef.current;
    if (scope?.projectId !== projectId || scope?.event !== event) return null;
    const isCurrent = () => scopeRef.current === scope;
    scope.pending += 1;
    setBusy(true);

    try {
      const response = await request();
      if (!isCurrent()) return null;
      if (response?.project) handlers.current.replaceProject?.(response.project);
      if (response?.run?.id) scope.statuses.set(response.run.id, response.run.status);
      return response;
    } catch (error) {
      if (!isCurrent()) return null;
      if (inline) throw error;
      toastWorkflowError(error, errorLabel, {
        reload: async () => {
          const next = await getMusicVideoProject(projectId, { silent: true });
          if (isCurrent()) handlers.current.replaceProject?.(next);
        },
      });
      return null;
    } finally {
      scope.pending -= 1;
      if (isCurrent() && scope.pending === 0) setBusy(false);
    }
  };

  return { busy, call };
}
