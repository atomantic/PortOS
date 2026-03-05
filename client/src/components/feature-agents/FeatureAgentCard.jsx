import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Pause, Square, Zap, Trash2 } from 'lucide-react';
import { STATUS_COLORS, STATUS_BG, PRIORITY_COLORS, SCHEDULE_LABELS, timeAgo } from './constants';

export default function FeatureAgentCard({ agent, onStart, onPause, onResume, onStop, onTrigger, onDelete }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const statusColor = STATUS_COLORS[agent.status] || 'text-gray-400';
  const statusBg = STATUS_BG[agent.status] || 'bg-gray-400/10';
  const priorityColor = PRIORITY_COLORS[agent.priority] || 'text-gray-400';

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-5 hover:border-port-accent/30 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <Link to={`/feature-agents/${agent.id}/overview`} className="flex-1 min-w-0">
          <h3 className="text-white font-medium truncate hover:text-port-accent transition-colors">
            {agent.name}
          </h3>
          <p className="text-sm text-gray-500 mt-1 line-clamp-2">{agent.description}</p>
        </Link>
        <div className="flex items-center gap-2 ml-3 shrink-0">
          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusColor} ${statusBg}`}>
            {agent.status}
          </span>
          <span className={`text-xs ${priorityColor}`}>{agent.priority}</span>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-gray-500 mb-3">
        <span>Runs: {agent.runCount || 0}</span>
        <span>Last: {timeAgo(agent.lastRunAt)}</span>
        <span>{SCHEDULE_LABELS[agent.schedule?.mode] || 'Continuous'}</span>
        {agent.git?.branchName && (
          <span className="text-gray-600 truncate max-w-[200px]">{agent.git.branchName}</span>
        )}
      </div>

      {agent.goals?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {agent.goals.slice(0, 3).map((goal, i) => (
            <span key={i} className="text-[10px] bg-port-border/50 text-gray-400 rounded px-1.5 py-0.5 truncate max-w-[200px]">
              {goal}
            </span>
          ))}
          {agent.goals.length > 3 && (
            <span className="text-[10px] text-gray-600">+{agent.goals.length - 3} more</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-1 pt-2 border-t border-port-border">
        {agent.status === 'draft' && (
          <button onClick={() => onStart(agent.id)} className="flex items-center gap-1 px-2 py-1 text-xs text-port-success hover:bg-port-success/10 rounded transition-colors">
            <Play size={12} /> Start
          </button>
        )}
        {agent.status === 'active' && (
          <>
            <button onClick={() => onPause(agent.id)} className="flex items-center gap-1 px-2 py-1 text-xs text-port-warning hover:bg-port-warning/10 rounded transition-colors">
              <Pause size={12} /> Pause
            </button>
            <button onClick={() => onTrigger(agent.id)} className="flex items-center gap-1 px-2 py-1 text-xs text-port-accent hover:bg-port-accent/10 rounded transition-colors">
              <Zap size={12} /> Trigger
            </button>
          </>
        )}
        {agent.status === 'paused' && (
          <button onClick={() => onResume(agent.id)} className="flex items-center gap-1 px-2 py-1 text-xs text-port-success hover:bg-port-success/10 rounded transition-colors">
            <Play size={12} /> Resume
          </button>
        )}
        {(agent.status === 'active' || agent.status === 'paused') && (
          <button onClick={() => onStop(agent.id)} className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:bg-port-border/50 rounded transition-colors">
            <Square size={12} /> Stop
          </button>
        )}
        <div className="flex-1" />
        {confirmingDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Delete?</span>
            <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
              <button
                onClick={() => { onDelete(agent.id); setConfirmingDelete(false); }}
                className="px-2 py-1 bg-port-error/20 text-port-error hover:bg-port-error/30 text-xs"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="px-2 py-1 bg-port-card text-gray-400 hover:bg-port-border/50 text-xs border-l border-port-border"
              >
                No
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirmingDelete(true)} className="flex items-center gap-1 px-2 py-1 text-xs text-port-error hover:bg-port-error/10 rounded transition-colors">
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
