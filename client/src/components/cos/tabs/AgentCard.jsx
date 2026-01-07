import { useState, useEffect } from 'react';
import {
  Cpu,
  Square,
  Trash2,
  CheckCircle,
  AlertCircle,
  RotateCcw,
  Loader2
} from 'lucide-react';
import * as api from '../../../services/api';

export default function AgentCard({ agent, onTerminate, onDelete, onResume, completed, liveOutput }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [fullOutput, setFullOutput] = useState(null);
  const [loadingOutput, setLoadingOutput] = useState(false);

  // Determine if this is a system agent (health check, etc.)
  const isSystemAgent = agent.taskId?.startsWith('sys-') || agent.id?.startsWith('sys-');

  // Update duration display for running agents
  useEffect(() => {
    if (completed) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [completed]);

  // Fetch full output when expanded for completed agents
  useEffect(() => {
    if (expanded && completed && !fullOutput && !loadingOutput) {
      setLoadingOutput(true);
      api.getCosAgent(agent.id)
        .then(data => {
          setFullOutput(data.output || []);
        })
        .catch(() => {
          // Fall back to agent's stored output
          setFullOutput(agent.output || []);
        })
        .finally(() => setLoadingOutput(false));
    }
  }, [expanded, completed, agent.id, fullOutput, loadingOutput, agent.output]);

  const duration = agent.completedAt
    ? new Date(agent.completedAt) - new Date(agent.startedAt)
    : now - new Date(agent.startedAt);

  const formatDuration = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  // For running agents, use live output; for completed, use fetched full output or stored
  const output = completed
    ? (fullOutput || agent.output || [])
    : (liveOutput || agent.output || []);
  const lastOutput = output.length > 0 ? output[output.length - 1]?.line : null;

  return (
    <div className={`bg-port-card border rounded-lg overflow-hidden ${
      completed
        ? isSystemAgent ? 'border-port-border opacity-50' : 'border-port-border opacity-75'
        : 'border-port-accent/50'
    }`}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Cpu size={16} className={completed ? 'text-gray-500' : 'text-port-accent animate-pulse'} />
            <span className="font-mono text-sm text-gray-400">{agent.id}</span>
            {isSystemAgent && (
              <span className="px-1.5 py-0.5 text-xs bg-gray-500/20 text-gray-400 rounded">SYS</span>
            )}
            {agent.metadata?.model && (
              <span className={`px-2 py-0.5 text-xs rounded ${
                agent.metadata.modelTier === 'heavy' ? 'bg-purple-500/20 text-purple-400' :
                agent.metadata.modelTier === 'light' ? 'bg-green-500/20 text-green-400' :
                'bg-blue-500/20 text-blue-400'
              }`} title={agent.metadata.modelReason}>
                {agent.metadata.model.replace('claude-', '').replace(/-\d+$/, '')}
              </span>
            )}
            {!completed && (
              <span className={`px-2 py-0.5 text-xs rounded animate-pulse ${
                agent.metadata?.phase === 'initializing' ? 'bg-yellow-500/20 text-yellow-400' :
                agent.metadata?.phase === 'working' ? 'bg-port-accent/20 text-port-accent' :
                'bg-port-accent/20 text-port-accent'
              }`}>
                {agent.metadata?.phase === 'initializing' ? 'Initializing' :
                 agent.metadata?.phase === 'working' ? 'Working' :
                 'Running'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">{formatDuration(duration)}</span>
            {(output.length > 0 || completed) && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-gray-500 hover:text-white transition-colors text-xs"
              >
                {expanded ? 'Hide' : 'Show'} Output
              </button>
            )}
            {!completed && onTerminate && (
              <button
                onClick={() => onTerminate(agent.id)}
                className="text-gray-500 hover:text-port-error transition-colors"
                title="Terminate"
              >
                <Square size={14} />
              </button>
            )}
            {completed && !isSystemAgent && onResume && (
              <button
                onClick={() => onResume(agent)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
                title="Create new task from this agent's context"
              >
                <RotateCcw size={12} />
                Resume
              </button>
            )}
            {completed && onDelete && (
              <button
                onClick={() => onDelete(agent.id)}
                className="text-gray-500 hover:text-port-error transition-colors"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
        <p className="text-white text-sm mb-2">{agent.metadata?.taskDescription || agent.taskId}</p>

        {/* Status / Last output line */}
        {!completed && lastOutput && (
          <div className="text-xs text-gray-500 font-mono truncate bg-port-bg/50 px-2 py-1 rounded">
            {lastOutput.substring(0, 100)}...
          </div>
        )}

        {agent.result && (
          <div className={`text-sm flex items-center gap-2 ${agent.result.success ? 'text-port-success' : 'text-port-error'}`}>
            {agent.result.success ? (
              <><CheckCircle size={14} /> Completed successfully</>
            ) : (
              <><AlertCircle size={14} /> {agent.result.error || 'Failed'}</>
            )}
          </div>
        )}
      </div>

      {/* Expanded output view */}
      {expanded && (
        <div className="border-t border-port-border bg-port-bg/50 p-3">
          {loadingOutput ? (
            <div className="flex items-center gap-2 text-gray-500 text-sm">
              <Loader2 size={14} className="animate-spin" />
              Loading full output...
            </div>
          ) : output.length > 0 ? (
            <pre className="text-xs font-mono text-gray-400 whitespace-pre-wrap">
              {output.map((o, i) => (
                <div key={i} className="py-0.5">
                  {o.line}
                </div>
              ))}
            </pre>
          ) : (
            <div className="text-gray-500 text-sm">No output captured</div>
          )}
        </div>
      )}
    </div>
  );
}
