/**
 * One subscription per active FableLoom scene-media job.
 *
 * The page owns the job map so the canvas card and editor rail consume the
 * same lifecycle instead of mounting duplicate socket subscriptions. Watchers
 * forward snapshots and report each terminal result once; the page then owns
 * notifications and the optimistic final-media swap.
 */

import { useEffect, useRef } from 'react';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { getLoomFalVideo } from '../../services/api';
import socket from '../../services/socket';
import { subscribeVisibility } from '../../hooks/useVisibilityEvent';

function LoomMediaJobWatcher({ nodeId, kind, job, onUpdate, onTerminal }) {
  const progress = useMediaJobProgress(job.jobId, { kind });
  const reportedTerminalRef = useRef(null);

  useEffect(() => {
    if (!job.jobId || progress.status === 'unknown') return;
    onUpdate(nodeId, kind, job.jobId, progress);

    const terminal = progress.status === 'failed'
      || progress.status === 'canceled'
      || (progress.status === 'completed' && (kind === 'video' || progress.filename));
    const terminalKey = terminal ? `${job.jobId}:${progress.status}` : null;
    if (!terminalKey || reportedTerminalRef.current === terminalKey) return;
    reportedTerminalRef.current = terminalKey;
    onTerminal(nodeId, kind, job.jobId, progress);
  }, [job.jobId, kind, nodeId, onTerminal, onUpdate, progress]);

  return null;
}

function LoomFalBrowserJobWatcher({ nodeId, kind, job, onUpdate, onTerminal }) {
  const reportedTerminalRef = useRef(null);
  const callbacks = useRef({ onUpdate, onTerminal });
  callbacks.current = { onUpdate, onTerminal };

  useEffect(() => {
    let canceled = false;
    let revision = 0;
    const matches = (progress) => progress?.id === job.jobId
      && progress.loomId === job.loomId && progress.episodeId === job.episodeId
      && progress.nodeId === nodeId;
    const apply = (progress) => {
      if (canceled || !matches(progress) || reportedTerminalRef.current === job.jobId) return;
      const terminal = progress.status === 'failed' || progress.status === 'completed';
      // Latch before callbacks: parent updates may unmount this watcher.
      if (terminal) reportedTerminalRef.current = job.jobId;
      callbacks.current.onUpdate(nodeId, kind, job.jobId, progress);
      if (terminal) callbacks.current.onTerminal(nodeId, kind, job.jobId, progress);
    };
    const read = () => {
      if (canceled || reportedTerminalRef.current === job.jobId) return;
      const started = ++revision;
      getLoomFalVideo(job.loomId, job.episodeId, nodeId, job.jobId, { silent: true })
        .then((progress) => {
          if (started === revision) apply(progress);
        })
        .catch(() => {
          // A failed status read is not a failed render. Keep listening and
          // retry at the next reconnect or tab show, without a polling timer.
        });
    };
    const onChange = (progress) => {
      if (!matches(progress)) return;
      revision += 1; // An older HTTP snapshot must not overwrite this event.
      apply(progress);
    };
    const onConnect = () => {
      if (document.visibilityState !== 'hidden') read();
    };
    let lastVisibility = document.visibilityState;
    const unsubscribeVisibility = subscribeVisibility((state) => {
      const changed = state !== lastVisibility;
      lastVisibility = state;
      if (changed && state === 'visible') read();
    });

    socket.on('fableloom:fal-video:changed', onChange);
    socket.on('connect', onConnect);
    read();
    return () => {
      canceled = true;
      unsubscribeVisibility();
      socket.off('fableloom:fal-video:changed', onChange);
      socket.off('connect', onConnect);
    };
  }, [job.episodeId, job.jobId, job.loomId, kind, nodeId]);

  return null;
}

export default function LoomMediaJobWatchers({ jobs, onUpdate, onTerminal }) {
  return Object.entries(jobs).flatMap(([nodeId, nodeJobs]) => (
    ['image', 'video'].map((kind) => {
      const job = nodeJobs?.[kind];
      return job?.jobId ? (
        job.source === 'fal-browser' ? (
          <LoomFalBrowserJobWatcher
            key={`${nodeId}:${kind}:${job.jobId}`}
            nodeId={nodeId}
            kind={kind}
            job={job}
            onUpdate={onUpdate}
            onTerminal={onTerminal}
          />
        ) : (
          <LoomMediaJobWatcher
            key={`${nodeId}:${kind}:${job.jobId}`}
            nodeId={nodeId}
            kind={kind}
            job={job}
            onUpdate={onUpdate}
            onTerminal={onTerminal}
          />
        )
      ) : null;
    })
  ));
}
