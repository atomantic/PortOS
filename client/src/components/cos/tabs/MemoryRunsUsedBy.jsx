import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import * as api from '../../../services/api';
import { formatDateTime } from '../../../utils/formatters';

/**
 * "Used by recent runs" — agent runs whose prompt included this memory, from a
 * bounded scan of recent run records (GET /api/memory/:id/runs, #10495).
 */
export default function MemoryRunsUsedBy({ memoryId }) {
  const [runs, setRuns] = useState(null);

  useEffect(() => {
    let active = true;
    setRuns(null);
    api.getMemoryRuns(memoryId, { silent: true })
      .then(res => { if (active) setRuns(res?.runs || []); })
      .catch(() => { if (active) setRuns([]); });
    return () => { active = false; };
  }, [memoryId]);

  if (!runs || runs.length === 0) return null;
  return (
    <div>
      <span className="block text-sm text-gray-400 mb-2">Used by recent runs</span>
      <ul className="space-y-1 text-xs text-gray-400">
        {runs.map(run => (
          <li key={run.runId} className="flex flex-wrap items-center gap-2">
            {run.agentId
              ? <Link to={`/cos/agents/${encodeURIComponent(run.agentId)}`} className="font-mono text-port-accent hover:text-port-accent/80">{run.agentId.slice(0, 8)}</Link>
              : <span className="font-mono">{run.runId.slice(0, 8)}</span>}
            {run.startTime && <span>{formatDateTime(run.startTime)}</span>}
            {run.success === false && <span className="text-port-error">failed</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
