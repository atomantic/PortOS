import { Clock, AlertTriangle, SlidersHorizontal, GitMerge } from 'lucide-react';
import { timeAgo } from '../../../../utils/formatters';
import useTaskModelPins from '../../../../hooks/useTaskModelPins';
import { describeNextRun, coverageTone, pipelineStages, IMPROVEMENT_DISABLED_TITLE, SAVING_TITLE } from './scheduleConstants';
import TaskHeader from './TaskHeader';
import RunTaskButton from './RunTaskButton';
import TaskModelQuickControls from './TaskModelQuickControls';

// One scheduled task rendered as a status-rich card. Browsing plus the common
// "retarget the model and run it" loop happen here; the rest of the
// configuration lives in the slide-over drawer (opened via Configure).
export default function AppTaskCard({ taskType, config, apps, onTrigger, onConfigure, onUpdate, providers, activeProviderId, improvementDisabled }) {
  // Owned here, not in the controls, so Run can gate on the same `saving` flag —
  // it reads the server-side config, so a run fired mid-write uses the old pins.
  const pins = useTaskModelPins({ taskType, config, providers, activeProviderId, onUpdate });
  const enabledCount = config.enabledAppCount ?? 0;
  const totalCount = config.totalAppCount ?? 0;
  const hasApps = totalCount > 0;
  const coverage = coverageTone(enabledCount, totalCount);
  const coveragePct = hasApps ? Math.round((enabledCount / totalCount) * 100) : 0;
  const nextRun = describeNextRun(config);
  const userInvokable = config.invocation?.userInvokable !== false;
  const invocationDescription = config.invocation?.description || 'Runs as part of another automation and is not directly invokable.';
  // A pipeline task resolves provider/model per stage — a single card-level pin
  // would be ignored, so point at the drawer instead of offering one.
  const stageCount = pipelineStages(config).length;

  return (
    <div className="flex flex-col border border-port-border rounded-lg bg-port-card hover:border-port-border/60 transition-colors">
      <button
        type="button"
        onClick={() => onConfigure(taskType)}
        className="flex-1 text-left p-4 space-y-3 rounded-t-lg hover:bg-port-card/60 transition-colors"
      >
        <TaskHeader taskType={taskType} config={config} />

        {/* Next run */}
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <Clock size={12} className="text-gray-500 shrink-0" />
          <span className={`${nextRun.tone} flex items-center gap-1 min-w-0`} title={nextRun.title}>
            {nextRun.warn && <AlertTriangle size={12} className="shrink-0" />}
            <span className="truncate">{nextRun.text}</span>
          </span>
        </div>

        {/* App coverage — kept prominent with a mini bar */}
        {hasApps && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-400">App coverage</span>
              <span className={coverage.text}>{enabledCount}/{totalCount} apps</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-port-border/60 overflow-hidden">
              <div className={`h-full rounded-full ${coverage.bar}`} style={{ width: `${coveragePct}%` }} />
            </div>
          </div>
        )}

        {/* Last run + dependencies */}
        <div className="text-xs text-gray-500 space-y-0.5">
          <div>
            {config.globalLastRun
              ? `Last run ${timeAgo(config.globalLastRun)} · ${config.globalRunCount || 0}×`
              : 'Never run'}
          </div>
          {config.runAfter?.length > 0 && (
            <div className="truncate">after: {config.runAfter.join(', ')}</div>
          )}
        </div>
      </button>

      {/* Quick model pins — the drawer's Global defaults, inline */}
      {userInvokable && onUpdate && (stageCount > 0 ? (
        <button
          type="button"
          onClick={() => onConfigure(taskType)}
          className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-left text-gray-500 border-t border-port-border hover:text-gray-300 transition-colors"
        >
          <GitMerge size={12} className="shrink-0" />
          Provider/model is set per stage ({stageCount}) — configure
        </button>
      ) : (
        <TaskModelQuickControls pins={pins} providers={providers} />
      ))}

      {/* Footer actions */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-port-border">
        {userInvokable ? (
          <>
            <RunTaskButton
              taskType={taskType}
              apps={apps}
              onTrigger={onTrigger}
              installWide={config.installWide}
              disabledReason={improvementDisabled ? IMPROVEMENT_DISABLED_TITLE : (pins.saving ? SAVING_TITLE : '')}
            />
            <button
              type="button"
              onClick={() => onConfigure(taskType)}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm rounded text-gray-300 hover:text-white hover:bg-port-border/50 transition-colors"
            >
              <SlidersHorizontal size={13} />
              Configure
            </button>
          </>
        ) : (
          <span className="text-xs text-port-warning/80" title={invocationDescription}>
            {config.invocation?.label || 'Automation-only'} — runs from its parent automation
          </span>
        )}
      </div>
    </div>
  );
}
