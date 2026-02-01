import { useState, useEffect, useMemo } from 'react';
import {
  Cpu,
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

export default function AgentCard({ agent, onKill, onDelete, onResume, completed, liveOutput, durations }) {
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

  // Calculate remaining time (ETA)
  const remainingTime = useMemo(() => {
    if (!durationEstimate || completed) return null;
    const remaining = durationEstimate.estimatedMs - duration;
    if (remaining <= 0) return { remaining: 0, overBy: Math.abs(remaining), isOvertime: true };
    return { remaining, overBy: 0, isOvertime: false };
  }, [duration, durationEstimate, completed]);

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
        {/* Top row: Agent ID, badges, and actions */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
            <Cpu size={16} aria-hidden="true" className={`flex-shrink-0 ${completed ? 'text-gray-500' : 'text-port-accent animate-pulse'}`} />
            <span className="font-mono text-sm text-gray-400 truncate">{agent.id}</span>
            {isSystemAgent && (
              <span className="px-1.5 py-0.5 text-xs bg-gray-500/20 text-gray-400 rounded flex-shrink-0">SYS</span>
            )}
            {agent.metadata?.model && (
              <span className={`px-2 py-0.5 text-xs rounded flex-shrink-0 ${
                agent.metadata.modelTier === 'heavy' ? 'bg-purple-500/20 text-purple-400' :
                agent.metadata.modelTier === 'light' ? 'bg-green-500/20 text-green-400' :
                'bg-blue-500/20 text-blue-400'
              }`} title={agent.metadata.modelReason}>
                {agent.metadata.model.replace('claude-', '').replace(/-\d+$/, '')}
              </span>
            )}
            {!completed && (
              <span className={`px-2 py-0.5 text-xs rounded animate-pulse flex-shrink-0 ${
                agent.metadata?.phase === 'initializing' ? 'bg-yellow-500/20 text-yellow-400' :
                'bg-port-accent/20 text-port-accent'
              }`}>
                {agent.metadata?.phase === 'initializing' ? 'Initializing' : 'Working'}
              </span>
            )}
          </div>
          {/* Actions - right side */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {(output.length > 0 || completed) && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-gray-500 hover:text-white transition-colors text-xs whitespace-nowrap"
                aria-expanded={expanded}
              >
                {expanded ? 'Hide' : 'Show'}
              </button>
            )}
            {/* Kill button (force SIGKILL) */}
            {!completed && onKill && (
              <button
                onClick={handleKill}
                disabled={killing}
                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-port-error/20 text-port-error hover:bg-port-error/30 transition-colors disabled:opacity-50"
                aria-label="Force kill agent (SIGKILL)"
              >
                {killing ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Skull size={12} aria-hidden="true" />}
                <span className="hidden sm:inline">Kill</span>
              </button>
            )}
            {completed && !isSystemAgent && onResume && (
              <button
                onClick={() => onResume(agent)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
                aria-label="Create new task from this agent's context"
              >
                <RotateCcw size={12} aria-hidden="true" />
                <span className="hidden sm:inline">Resume</span>
              </button>
            )}
            {completed && onDelete && (
              <button
                onClick={() => onDelete(agent.id)}
                className="p-1 text-gray-500 hover:text-port-error transition-colors"
                aria-label="Remove agent"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {/* Second row: Runtime, ETA, and process stats - compact inline display */}
        <div className="flex items-center gap-2 flex-wrap text-xs mb-2">
          {/* Duration with ETA for running agents */}
          {!completed && durationEstimate ? (
            <span
              className="flex items-center gap-1.5 text-gray-500 whitespace-nowrap"
              title={`Based on ${durationEstimate.basedOn} completed ${durationEstimate.taskType} tasks`}
            >
              <Clock size={12} aria-hidden="true" className="flex-shrink-0" />
              <span className="font-mono">{formatDuration(duration)}</span>
              {remainingTime && !remainingTime.isOvertime && (
                <>
                  <span className="text-gray-600">→</span>
                  <span className="font-mono text-port-accent">~{formatDuration(remainingTime.remaining)} left</span>
                </>
              )}
              {remainingTime?.isOvertime && (
                <>
                  <span className="text-gray-600">→</span>
                  <span className="font-mono text-yellow-500">+{formatDuration(remainingTime.overBy)}</span>
                </>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-gray-500 whitespace-nowrap">
              <Clock size={12} aria-hidden="true" className="flex-shrink-0" />
              <span className="font-mono">{formatDuration(duration)}</span>
            </span>
          )}
          {/* Process stats for running agents - inline */}
          {!completed && processStats?.active && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-success/20 text-port-success whitespace-nowrap"
                  title={`PID: ${processStats.pid} | State: ${processStats.state}`}>
              <Activity size={10} aria-hidden="true" className="flex-shrink-0" />
              <span className="font-mono">PID {processStats.pid}</span>
              <span className="text-port-success/70">|</span>
              <span className="font-mono">{processStats.cpu?.toFixed(1)}%</span>
              <span className="text-port-success/70">|</span>
              <span className="font-mono">{processStats.memoryMb}MB</span>
            </span>
          )}
          {/* Show zombie warning if PID exists but process is dead */}
          {!completed && agent.pid && processStats && !processStats.active && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-error/20 text-port-error whitespace-nowrap"
                  title="Process is not running - zombie agent">
              <Skull size={10} aria-hidden="true" className="flex-shrink-0" />
              <span className="font-mono">PID {agent.pid}</span>
              <span>ZOMBIE</span>
            </span>
          )}
        </div>
        <p className="text-white text-sm mb-2">{agent.metadata?.taskDescription || agent.taskId}</p>

        {/* Status / Last output line */}
        {!completed && lastOutput && (
          <div className="text-xs text-gray-500 font-mono truncate bg-port-bg/50 px-2 py-1 rounded">
            {lastOutput.substring(0, 100)}...
          </div>
        )}

        {/* Progress bar and ETA for running agents with estimates */}
        {!completed && durationEstimate && progress !== null && (
          <div className="mt-2">
            <div className="h-1.5 bg-port-border rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-1000 ease-linear ${
                  progress >= 100 ? 'bg-yellow-500' : 'bg-port-accent'
                }`}
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
            <div className="flex justify-between mt-1.5 text-xs">
              <span className="text-gray-500">
                {progress}% complete
              </span>
              {remainingTime && !remainingTime.isOvertime && (
                <span className="text-port-accent font-medium">
                  ETA: ~{formatDuration(remainingTime.remaining)}
                </span>
              )}
              {remainingTime?.isOvertime && (
                <span className="text-yellow-500 font-medium animate-pulse">
                  +{formatDuration(remainingTime.overBy)} over estimate
                </span>
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
