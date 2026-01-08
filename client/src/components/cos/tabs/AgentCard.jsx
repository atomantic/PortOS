import { useState, useEffect, useMemo } from 'react';
import {
  Cpu,
  Square,
  Trash2,
  CheckCircle,
  AlertCircle,
  RotateCcw,
  Loader2,
  Skull,
  Activity,
  Clock,
  Brain
} from 'lucide-react';
import * as api from '../../../services/api';

// Extract task type from description (matches server-side extractTaskType)
function extractTaskType(description) {
  if (!description) return 'general';
  const d = description.toLowerCase();
  if (d.includes('fix') || d.includes('bug') || d.includes('error') || d.includes('issue')) return 'bug-fix';
  if (d.includes('refactor') || d.includes('clean up') || d.includes('improve') || d.includes('optimize')) return 'refactor';
  if (d.includes('test')) return 'testing';
  if (d.includes('document') || d.includes('readme') || d.includes('docs')) return 'documentation';
  if (d.includes('review') || d.includes('audit')) return 'code-review';
  if (d.includes('mobile') || d.includes('responsive')) return 'mobile-responsive';
  if (d.includes('security') || d.includes('vulnerability')) return 'security';
  if (d.includes('performance') || d.includes('speed')) return 'performance';
  if (d.includes('ui') || d.includes('ux') || d.includes('design') || d.includes('style')) return 'ui-ux';
  if (d.includes('api') || d.includes('endpoint') || d.includes('route')) return 'api';
  if (d.includes('database') || d.includes('migration')) return 'database';
  if (d.includes('deploy') || d.includes('ci') || d.includes('cd')) return 'devops';
  if (d.includes('investigate') || d.includes('debug')) return 'investigation';
  if (d.includes('self-improvement') || d.includes('feature idea')) return 'self-improvement';
  return 'feature';
}

export default function AgentCard({ agent, onTerminate, onKill, onDelete, onResume, completed, liveOutput, durations }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [fullOutput, setFullOutput] = useState(null);
  const [loadingOutput, setLoadingOutput] = useState(false);
  const [processStats, setProcessStats] = useState(null);
  const [killing, setKilling] = useState(false);

  // Determine if this is a system agent (health check, etc.)
  const isSystemAgent = agent.taskId?.startsWith('sys-') || agent.id?.startsWith('sys-');

  // Update duration display for running agents
  useEffect(() => {
    if (completed) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [completed]);

  // Fetch process stats for running agents
  useEffect(() => {
    if (completed) return;

    const fetchStats = async () => {
      const stats = await api.getCosAgentStats(agent.id).catch(() => null);
      setProcessStats(stats);
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000); // Update every 5 seconds
    return () => clearInterval(interval);
  }, [completed, agent.id]);

  const handleKill = async () => {
    if (!onKill) return;
    setKilling(true);
    await onKill(agent.id);
    setKilling(false);
  };

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

  // Calculate duration estimate for running agents
  const durationEstimate = useMemo(() => {
    if (completed || !durations) return null;

    const taskType = extractTaskType(agent.metadata?.taskDescription);
    const typeData = durations[taskType];
    const overallData = durations._overall;

    if (typeData && typeData.avgDurationMs) {
      return {
        estimatedMs: typeData.avgDurationMs,
        basedOn: typeData.completed,
        taskType,
        isTypeSpecific: true
      };
    }

    if (overallData && overallData.avgDurationMs) {
      return {
        estimatedMs: overallData.avgDurationMs,
        basedOn: overallData.completed,
        taskType: 'all tasks',
        isTypeSpecific: false
      };
    }

    return null;
  }, [completed, durations, agent.metadata?.taskDescription]);

  // Calculate progress percentage
  const progress = useMemo(() => {
    if (!durationEstimate) return null;
    const percent = Math.min(100, Math.round((duration / durationEstimate.estimatedMs) * 100));
    return percent;
  }, [duration, durationEstimate]);

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
            <Cpu size={16} aria-hidden="true" className={completed ? 'text-gray-500' : 'text-port-accent animate-pulse'} />
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
                'bg-port-accent/20 text-port-accent'
              }`}>
                {agent.metadata?.phase === 'initializing' ? 'Initializing' : 'Working'}
              </span>
            )}
            {/* Process stats for running agents */}
            {!completed && processStats?.active && (
              <span className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-port-success/20 text-port-success"
                    title={`PID: ${processStats.pid} | State: ${processStats.state}`}>
                <Activity size={10} aria-hidden="true" />
                PID {processStats.pid} | {processStats.cpu?.toFixed(1)}% | {processStats.memoryMb}MB
              </span>
            )}
            {/* Show zombie warning if PID exists but process is dead */}
            {!completed && agent.pid && processStats && !processStats.active && (
              <span className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-port-error/20 text-port-error"
                    title="Process is not running - zombie agent">
                <Skull size={10} aria-hidden="true" />
                PID {agent.pid} ZOMBIE
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Duration with estimate for running agents */}
            {!completed && durationEstimate ? (
              <span
                className="flex items-center gap-1 text-sm text-gray-500"
                title={`Based on ${durationEstimate.basedOn} completed ${durationEstimate.taskType} tasks`}
              >
                <Clock size={12} aria-hidden="true" />
                {formatDuration(duration)} / ~{formatDuration(durationEstimate.estimatedMs)}
              </span>
            ) : (
              <span className="text-sm text-gray-500">{formatDuration(duration)}</span>
            )}
            {(output.length > 0 || completed) && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-gray-500 hover:text-white transition-colors text-xs"
                aria-expanded={expanded}
              >
                {expanded ? 'Hide' : 'Show'} Output
              </button>
            )}
            {/* Terminate button (graceful) */}
            {!completed && onTerminate && (
              <button
                onClick={() => onTerminate(agent.id)}
                className="text-gray-500 hover:text-port-warning transition-colors"
                aria-label="Terminate agent (graceful SIGTERM)"
              >
                <Square size={14} aria-hidden="true" />
              </button>
            )}
            {/* Kill button (force SIGKILL) */}
            {!completed && onKill && (
              <button
                onClick={handleKill}
                disabled={killing}
                className="text-gray-500 hover:text-port-error transition-colors disabled:opacity-50"
                aria-label="Force kill agent (SIGKILL)"
              >
                {killing ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <Skull size={14} aria-hidden="true" />}
              </button>
            )}
            {completed && !isSystemAgent && onResume && (
              <button
                onClick={() => onResume(agent)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
                aria-label="Create new task from this agent's context"
              >
                <RotateCcw size={12} aria-hidden="true" />
                Resume
              </button>
            )}
            {completed && onDelete && (
              <button
                onClick={() => onDelete(agent.id)}
                className="text-gray-500 hover:text-port-error transition-colors"
                aria-label="Remove agent"
              >
                <Trash2 size={14} aria-hidden="true" />
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

        {/* Progress bar for running agents with estimates */}
        {!completed && durationEstimate && progress !== null && (
          <div className="mt-2">
            <div className="h-1 bg-port-border rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-1000 ease-linear ${
                  progress >= 100 ? 'bg-yellow-500' : 'bg-port-accent'
                }`}
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
            <div className="flex justify-between mt-1 text-xs text-gray-600">
              <span>{progress}% of typical duration</span>
              {progress >= 100 && (
                <span className="text-yellow-500">Running longer than average</span>
              )}
            </div>
          </div>
        )}

        {agent.result && (
          <div className="flex items-center gap-4 flex-wrap">
            <div className={`text-sm flex items-center gap-2 ${agent.result.success ? 'text-port-success' : 'text-port-error'}`}>
              {agent.result.success ? (
                <><CheckCircle size={14} aria-hidden="true" /> Completed successfully</>
              ) : (
                <><AlertCircle size={14} aria-hidden="true" /> {agent.result.error || 'Failed'}</>
              )}
            </div>
            {/* Memory extraction status */}
            {agent.result.success && (
              <div className={`text-sm flex items-center gap-1 ${
                agent.memoryExtraction?.created > 0 ? 'text-purple-400' :
                agent.memoryExtraction?.pendingApproval > 0 ? 'text-yellow-400' : 'text-gray-500'
              }`} title={agent.memoryExtraction?.extractedAt ? `Extracted at ${new Date(agent.memoryExtraction.extractedAt).toLocaleString()}` : 'No memories extracted'}>
                <Brain size={14} aria-hidden="true" />
                {agent.memoryExtraction?.created > 0 ? (
                  <span>{agent.memoryExtraction.created} memor{agent.memoryExtraction.created === 1 ? 'y' : 'ies'}</span>
                ) : agent.memoryExtraction?.pendingApproval > 0 ? (
                  <span>{agent.memoryExtraction.pendingApproval} pending</span>
                ) : (
                  <span className="opacity-50">No memories</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Expanded output view */}
      {expanded && (
        <div className="border-t border-port-border bg-port-bg/50 p-3">
          {loadingOutput ? (
            <div className="flex items-center gap-2 text-gray-500 text-sm">
              <Loader2 size={14} aria-hidden="true" className="animate-spin" />
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
