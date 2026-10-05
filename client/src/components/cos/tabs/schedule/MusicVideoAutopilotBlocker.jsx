import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import socket from '../../../../services/socket';
import { listMusicVideoProjectSummaries } from '../../../../services/apiMusicVideo';
import { scheduledRunBlocker } from '../../../../lib/musicVideoAutonomous';

/**
 * Names the project the Autonomous run schedule is parked on (#10156): every
 * later fire declines while a scheduled run awaits approval, needs the director
 * or is stopped, so without this the schedule just looks like it does nothing.
 * Loads once, then follows `music-video:autonomous` pushes — no polling.
 */
export default function MusicVideoAutopilotBlocker() {
  const [blockers, setBlockers] = useState({});

  useEffect(() => {
    let live = true;
    const apply = (project) => setBlockers((prev) => {
      const next = { ...prev };
      const blocker = scheduledRunBlocker(project);
      if (blocker) next[project.id] = blocker;
      else delete next[project?.id];
      return next;
    });
    listMusicVideoProjectSummaries({ limit: 200 }, { silent: true })
      .then((page) => { if (live) (page?.items || []).forEach(apply); })
      .catch(() => {});
    const onRun = (data) => { if (data?.project) apply(data.project); };
    socket.on('music-video:autonomous', onRun);
    return () => { live = false; socket.off('music-video:autonomous', onRun); };
  }, []);

  const parked = Object.values(blockers);
  if (parked.length === 0) return null;
  return (
    <div role="status" className="space-y-1 text-xs text-port-warning">
      {parked.map((b) => (
        <p key={b.projectId} className="flex items-start gap-1.5 min-w-0">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            Waiting on {b.summary}. New runs start once it is cleared.{' '}
            <Link to={b.link} className="underline text-port-accent">Open project</Link>
          </span>
        </p>
      ))}
    </div>
  );
}
