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

const FAL_POLL_MS = 2000;
const FAL_POLL_FAILURE_LIMIT = 3;

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

  useEffect(() => {
    let canceled = false;
    let timer = null;
    let failures = 0;

    const poll = () => {
      getLoomFalVideo(job.loomId, job.episodeId, nodeId, job.jobId, { silent: true })
        .then((progress) => {
          if (canceled) return;
          failures = 0;
          onUpdate(nodeId, kind, job.jobId, progress);
          const terminal = progress.status === 'failed' || progress.status === 'completed';
          const terminalKey = terminal ? `${job.jobId}:${progress.status}` : null;
          if (terminalKey && reportedTerminalRef.current !== terminalKey) {
            reportedTerminalRef.current = terminalKey;
            onTerminal(nodeId, kind, job.jobId, progress);
            return;
          }
          timer = setTimeout(poll, FAL_POLL_MS);
        })
        .catch(() => {
          if (canceled) return;
          failures += 1;
          if (failures < FAL_POLL_FAILURE_LIMIT) {
            timer = setTimeout(poll, FAL_POLL_MS);
            return;
          }
          const failed = {
            ...job,
            status: 'failed',
            error: 'Could not read fal.ai browser automation status',
          };
          onUpdate(nodeId, kind, job.jobId, failed);
          onTerminal(nodeId, kind, job.jobId, failed);
        });
    };

    poll();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [job.episodeId, job.jobId, job.loomId, kind, nodeId, onTerminal, onUpdate]);

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
