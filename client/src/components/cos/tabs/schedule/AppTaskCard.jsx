import { Clock, AlertTriangle, SlidersHorizontal, GitMerge, PauseCircle } from 'lucide-react';
import { timeAgo } from '../../../../utils/formatters';
import useTaskModelPins from '../../../../hooks/useTaskModelPins';
import { describeNextRun, coverageTone, pipelineStages, IMPROVEMENT_DISABLED_TITLE, SAVING_TITLE } from './scheduleConstants';
import TaskHeader from './TaskHeader';
import RunTaskButton from './RunTaskButton';
import TaskModelQuickControls from './TaskModelQuickControls';
import ToggleSwitch from '../../../ToggleSwitch';
import { isCronExpression } from '../../../../utils/cronHelpers';
import Banner from '../../../ui/Banner';

// One scheduled task rendered as a status-rich card. Browsing plus the common
// "retarget the model and run it" loop happen here; the rest of the
// configuration lives in the slide-over drawer (opened via Configure).
// appContext embeds the same card on a selected app's Automation tab: the
// caller owns app-scoped saves/runs and supplies override controls as children.
// Keep global coverage/history and global pin writes out of that context.
export default function AppTaskCard({ taskType, config, apps, onTrigger, onConfigure, onUpdate, providers, providersLoaded = true, activeProviderId, improvementDisabled, orderStep, appContext, children }) {
  // Owned here, not in the controls, so Run can gate on the same `saving` flag —
  // it reads the server-side config, so a run fired mid-write uses the old pins.
  const pins = useTaskModelPins({ taskType, config, providers, activeProviderId, onUpdate });
  const enabledCount = config.enabledAppCount ?? 0;
  const totalCount = config.totalAppCount ?? 0;
  const hasApps = totalCount > 0;
  const coverage = coverageTone(enabledCount, totalCount);
  const coveragePct = hasApps ? Math.round((enabledCount / totalCount) * 100) : 0;
  const displayConfig = appContext ? {
    ...config,
    enabled: appContext.enabled,
    taskMetadata: { ...config.taskMetadata, ...appContext.taskMetadata },
    ...(appContext.interval ? {
      type: isCronExpression(appContext.interval) ? 'cron' : appContext.interval,
      cronExpression: isCronExpression(appContext.interval) ? appContext.interval : undefined,
      perpetual: false,
    } : {}),
  } : config;
  const nextRun = appContext
    ? { text: appContext.cadence, tone: 'text-gray-400' }
    : describeNextRun(config);
  const userInvokable = config.invocation?.userInvokable !== false;
  const invocationDescription = config.invocation?.description || 'Runs as part of another automation and is not directly invokable.';
  // A pipeline task resolves provider/model per stage — a single card-level pin
  // would be ignored, so point at the drawer instead of offering one.
  const stageCount = pipelineStages(config).length;

  return (
    <div className="flex flex-col border border-port-border rounded-lg bg-port-card hover:border-port-border/60 transition-colors">
      {/* `flex flex-col items-stretch` is load-bearing: a stretched <button> centers its
          content box vertically, which floats a short card's body to the middle of the
          card and breaks the top alignment across a row. */}
      <button
        type="button"
        onClick={() => onConfigure(taskType)}
        className="flex-1 flex flex-col items-stretch gap-3 text-left p-4 rounded-t-lg hover:bg-port-card/60 transition-colors"
      >
        <TaskHeader taskType={taskType} config={displayConfig} orderStep={orderStep} />

        {/* Next run */}
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <Clock size={12} className="text-gray-500 shrink-0" />
          <span className={`${nextRun.tone} flex items-center gap-1 min-w-0`} title={nextRun.title}>
            {nextRun.warn && <AlertTriangle size={12} className="shrink-0" />}
            <span className="truncate">{nextRun.text}</span>
          </span>
        </div>

        {/* App coverage — kept prominent with a mini bar */}
        {!appContext && hasApps && (
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
        {!appContext && <div className="text-xs text-gray-500 space-y-0.5">
          <div>
            {config.globalLastRun
              ? `Last run ${timeAgo(config.globalLastRun)} · ${config.globalRunCount || 0}×`
              : 'Never run'}
          </div>
          {/* "waits for" is the ENFORCED gate; the advisory order renders as
              "Run first:" chips in TaskHeader above. Spelling out the
              difference here keeps the two lines from reading as one. */}
          {config.runAfter?.length > 0 && (
            <div className="truncate" title={`Blocked until these run: ${config.runAfter.join(', ')}`}>waits for: {config.runAfter.join(', ')}</div>
          )}
        </div>}
      </button>

      {config.enabled === false && (
        <Banner
          tone="warning"
          icon={PauseCircle}
          title="Global pause active"
          role="status"
          className="mx-4 mb-3"
        >
          Scheduled runs are paused for this task.
        </Banner>
      )}

      {appContext && (
        <div className="flex items-center gap-2 px-4 pb-3">
          <span className="text-xs text-gray-400">Enabled</span>
          <ToggleSwitch
            enabled={appContext.enabled}
            onChange={appContext.onToggle}
            disabled={appContext.saving}
            size="sm"
            ariaLabel={`${taskType} enabled for this app: ${appContext.enabled ? 'on' : 'off'}`}
          />
        </div>
      )}
      {children && <fieldset disabled={appContext?.saving} className="min-w-0 px-4 pb-3 space-y-3">{children}</fieldset>}

      {/* Quick model pins — the drawer's Global defaults, inline */}
      {!appContext && userInvokable && onUpdate && (stageCount > 0 ? (
        <button
          type="button"
          onClick={() => onConfigure(taskType)}
          className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-left text-gray-500 border-t border-port-border hover:text-gray-300 transition-colors"
        >
          <GitMerge size={12} className="shrink-0" />
          Provider/model is set per stage ({stageCount}) — configure
        </button>
      ) : (
        <TaskModelQuickControls pins={pins} providers={providers} loading={!providersLoaded} />
      ))}

      {/* Footer actions */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-port-border">
        {userInvokable ? (
          <>
            <RunTaskButton
              taskType={taskType}
              apps={appContext ? undefined : apps}
              onTrigger={onTrigger}
              installWide={!appContext && config.installWide}
              programmatic={config.programmatic}
              disabledReason={appContext?.saving ? SAVING_TITLE : appContext && !appContext.enabled ? 'Enable this task for this app first' : improvementDisabled ? IMPROVEMENT_DISABLED_TITLE : (pins.saving ? SAVING_TITLE : '')}
            />
            <button
              type="button"
              onClick={() => onConfigure(taskType)}
              aria-expanded={appContext?.expanded}
              aria-label={appContext ? `${appContext.expanded ? 'Hide' : 'Show'} provider and model options for ${taskType}` : undefined}
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
