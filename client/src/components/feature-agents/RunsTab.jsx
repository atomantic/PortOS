import { useState, useEffect } from 'react';
import { Play, ChevronDown, ChevronRight } from 'lucide-react';
import * as api from '../../services/api';
import BrailleSpinner from '../BrailleSpinner';

function timeAgo(dateStr) {
  if (!dateStr) return 'unknown';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function RunsTab({ agent }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    api.getFeatureAgentRuns(agent.id, 50).then(data => {
      setRuns(data || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [agent.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <BrailleSpinner text="Loading runs" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="text-center py-16">
        <Play size={48} className="mx-auto text-gray-600 mb-4" />
        <h3 className="text-lg font-medium text-gray-400 mb-2">No Runs Yet</h3>
        <p className="text-sm text-gray-600">Activate the agent or trigger a manual run to see history here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((run, i) => (
        <div key={run.id || i} className="bg-port-card border border-port-border rounded-lg">
          <button
            onClick={() => setExpanded(prev => ({ ...prev, [i]: !prev[i] }))}
            className="w-full flex items-center gap-3 p-3 text-left hover:bg-port-border/30 rounded-lg transition-colors"
          >
            {expanded[i] ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />}
            <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${
              run.status === 'working' ? 'bg-port-success/10 text-port-success' :
              run.status === 'idle-no-work' ? 'bg-port-warning/10 text-port-warning' :
              run.status === 'error' ? 'bg-port-error/10 text-port-error' :
              'bg-gray-500/10 text-gray-400'
            }`}>
              {run.status || 'unknown'}
            </span>
            <span className="text-sm text-gray-300 flex-1 truncate">{run.summary || 'No summary'}</span>
            <span className="text-xs text-gray-600 shrink-0">{timeAgo(run.completedAt)}</span>
          </button>

          {expanded[i] && (
            <div className="px-4 pb-3 space-y-2 border-t border-port-border mt-1 pt-2">
              {run.filesChanged?.length > 0 && (
                <div>
                  <span className="text-xs text-gray-500">Files changed:</span>
                  <div className="mt-1 space-y-0.5">
                    {run.filesChanged.map((f, j) => (
                      <div key={j} className="text-xs font-mono text-gray-400">{f}</div>
                    ))}
                  </div>
                </div>
              )}
              {run.learnings && (
                <div>
                  <span className="text-xs text-gray-500">Learnings:</span>
                  <p className="text-xs text-gray-400 mt-1">{run.learnings}</p>
                </div>
              )}
              {run.playwrightResults && (
                <div>
                  <span className="text-xs text-gray-500">Playwright results:</span>
                  <p className="text-xs text-gray-400 mt-1">{JSON.stringify(run.playwrightResults)}</p>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
