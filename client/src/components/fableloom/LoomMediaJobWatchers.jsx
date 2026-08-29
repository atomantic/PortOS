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

export default function LoomMediaJobWatchers({ jobs, onUpdate, onTerminal }) {
  return Object.entries(jobs).flatMap(([nodeId, nodeJobs]) => (
    ['image', 'video'].map((kind) => {
      const job = nodeJobs?.[kind];
      return job?.jobId ? (
        <LoomMediaJobWatcher
          key={`${nodeId}:${kind}:${job.jobId}`}
          nodeId={nodeId}
          kind={kind}
          job={job}
          onUpdate={onUpdate}
          onTerminal={onTerminal}
        />
      ) : null;
    })
  ));
}
