import { Link } from 'react-router';
import { Activity, Clock, Hourglass, MessageSquare, Skull, Terminal } from 'lucide-react';
import { formatDateTime, formatDurationMs, formatMonthDay, formatTimeOfDay } from '../../../utils/formatters';

const ETA_PRESENTATION = {
  inline: {
    remaining: {
      prefix: '~',
      suffix: ' left',
      durationKey: 'remaining',
      className: 'font-mono text-port-accent',
    },
    overtime: {
      prefix: '+',
      suffix: '',
      durationKey: 'overBy',
      className: 'font-mono text-yellow-500',
    },
  },
  footer: {
    remaining: {
      prefix: 'ETA: ~',
      suffix: '',
      durationKey: 'remaining',
      className: 'text-port-accent font-medium',
    },
    overtime: {
      prefix: '+',
      suffix: ' over estimate',
      durationKey: 'overBy',
      className: 'text-yellow-500 font-medium animate-pulse',
    },
  },
};

function AgentEtaLabel({ remainingTime, variant }) {
  if (!remainingTime) return null;
  const outcome = remainingTime.isOvertime ? 'overtime' : 'remaining';
  const presentation = ETA_PRESENTATION[variant][outcome];
  return (
    <span className={presentation.className}>
      {presentation.prefix}{formatDurationMs(remainingTime[presentation.durationKey])}{presentation.suffix}
    </span>
  );
}

export function AgentRuntimeStatus({
  inactive,
  durationEstimate,
  duration,
  remainingTime,
  completed,
  completedAt,
  processStats,
  tuiSessionId,
  noShellReason,
  prefillReason,
  prefillLabel,
  remote,
  onOpenPrompt,
  pid,
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs mb-2">
      {!inactive && durationEstimate ? (
        <span
          className="flex items-center gap-1.5 text-gray-500 whitespace-nowrap"
          title={`Based on ${durationEstimate.basedOn} completed ${durationEstimate.taskType} tasks (avg: ${formatDurationMs(durationEstimate.avgMs)}, est: ${formatDurationMs(durationEstimate.estimatedMs)})`}
        >
          <Clock size={12} aria-hidden="true" className="shrink-0" />
          <span className="font-mono">{formatDurationMs(duration)}</span>
          {remainingTime && (
            <>
              <span className="text-gray-600">→</span>
              <AgentEtaLabel remainingTime={remainingTime} variant="inline" />
            </>
          )}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-gray-500 whitespace-nowrap">
          <Clock size={12} aria-hidden="true" className="shrink-0" />
          <span className="font-mono">{formatDurationMs(duration)}</span>
        </span>
      )}
      {completed && completedAt && (
        <>
          <span className="text-gray-600">|</span>
          <span className="text-gray-500 whitespace-nowrap" title={formatDateTime(completedAt)}>
            {formatMonthDay(completedAt)}{' '}
            {formatTimeOfDay(completedAt)}
          </span>
        </>
      )}
      {!inactive && processStats?.active && (
        <span
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-success/20 text-port-success whitespace-nowrap"
          title={`PID: ${processStats.pid} | State: ${processStats.state}`}
        >
          <Activity size={10} aria-hidden="true" className="shrink-0" />
          <span className="font-mono">PID {processStats.pid}</span>
          <span className="text-port-success/70">|</span>
          <span className="font-mono">{processStats.cpu?.toFixed(1)}%</span>
          <span className="text-port-success/70">|</span>
          <span className="font-mono">{processStats.memoryMb}MB</span>
        </span>
      )}
      {!inactive && tuiSessionId && (
        <Link
          to={`/shell?session=${encodeURIComponent(tuiSessionId)}`}
          className="flex items-center gap-1.5 px-3 py-1 rounded font-semibold bg-emerald-500 text-black hover:bg-emerald-400 shadow-sm ring-1 ring-emerald-400/50 whitespace-nowrap transition-colors"
          title="Open the live TUI shell to inspect and interact with this agent"
        >
          <Terminal size={14} aria-hidden="true" className="shrink-0" />
          <span>Open Shell</span>
          <span className="font-mono text-[10px] text-port-on-success">{tuiSessionId.slice(0, 6)}</span>
        </Link>
      )}
      {!inactive && noShellReason && (
        <span
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-border/40 text-gray-400 whitespace-nowrap"
          title={noShellReason}
        >
          <Terminal size={10} aria-hidden="true" className="shrink-0" />
          <span>No shell</span>
        </span>
      )}
      {!inactive && prefillReason && (
        <span
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-warning/20 text-port-warning whitespace-nowrap"
          title={prefillReason}
        >
          <Hourglass size={10} aria-hidden="true" className="shrink-0" />
          <span>Long prefill ~{prefillLabel}</span>
        </span>
      )}
      {!remote && (
        <button
          onClick={onOpenPrompt}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-border/40 text-gray-400 hover:bg-port-border/60 hover:text-white whitespace-nowrap"
          title="View the prompt this agent was given at spawn"
        >
          <MessageSquare size={10} aria-hidden="true" className="shrink-0" />
          <span>Prompt</span>
        </button>
      )}
      {!inactive && pid && processStats && !processStats.active && (
        <span
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-port-error/20 text-port-error whitespace-nowrap"
          title="Process is not running - zombie agent"
        >
          <Skull size={10} aria-hidden="true" className="shrink-0" />
          <span className="font-mono">PID {pid}</span>
          <span>ZOMBIE</span>
        </span>
      )}
    </div>
  );
}

export function AgentProgress({ inactive, durationEstimate, progress, remainingTime }) {
  return !inactive && durationEstimate && progress !== null && (
    <div className="mt-2">
      <div className="h-1.5 bg-port-border rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-1000 ease-linear ${
            remainingTime?.isOvertime ? 'bg-yellow-500' : 'bg-port-accent'
          }`}
          style={{ width: `${Math.min(progress, 99)}%` }}
        />
      </div>
      <div className="flex justify-between mt-1.5 text-xs">
        <span className="text-gray-500">{progress}% complete</span>
        <AgentEtaLabel remainingTime={remainingTime} variant="footer" />
      </div>
    </div>
  );
}
