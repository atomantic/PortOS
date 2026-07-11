import { useState, useEffect } from 'react';
import { RotateCcw, AlertCircle } from 'lucide-react';
import CronInput from '../../../CronInput';
import { AGENT_OPTIONS, DEFAULT_REVIEW_STOP_MODE, PR_AUTHOR_FILTER_OPTIONS, ISSUE_AUTHOR_FILTER_OPTIONS, ISSUE_AUTHOR_FILTER_TASK_TYPES, SWARM_COUNT_OPTIONS, SWARM_TASK_TYPES } from '../../constants';
import ReviewerPicker from '../../ReviewerPicker';
import Banner from '../../../ui/Banner';
import InfoTooltip from '../../../ui/InfoTooltip';
import { FormField } from '../../../ui/FormField';
import { formatDateTime } from '../../../../utils/formatters';
import { useCodeReviewDefaults } from '../../../../hooks/useCodeReviewDefaults';
import ToggleSwitch from '../../../ToggleSwitch';
import { filterSelectableModels } from '../../../../utils/providers';
import PromptEditor from './PromptEditor';
import RunTaskButton from './RunTaskButton';
import { INTERVAL_DESCRIPTIONS, toggleMetadataField } from './scheduleConstants';

export default function GlobalConfigControls({ taskType, config, onUpdate, onTrigger, onReset, category: _category, providers, apps, updating, setUpdating, allTaskTypes, improvementDisabled }) {
  const reviewDefaults = useCodeReviewDefaults();
  const [selectedType, setSelectedType] = useState(config.type);
  const [selectedProviderId, setSelectedProviderId] = useState(config.providerId || '');
  const [selectedModel, setSelectedModel] = useState(config.model || '');
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptValue, setPromptValue] = useState(config.prompt || '');

  useEffect(() => {
    setSelectedType(config.type);
    setSelectedProviderId(config.providerId || '');
    setSelectedModel(config.model || '');
    if (!editingPrompt) {
      setPromptValue(config.prompt || '');
    }
  }, [config.type, config.providerId, config.model, config.prompt, editingPrompt]);

  const activeApps = apps?.filter(app => !app.archived) || [];

  const [cronEditing, setCronEditing] = useState(false);
  const [recheckEditing, setRecheckEditing] = useState(false);

  const handleTypeChange = async (newType) => {
    if (newType === 'cron') {
      setCronEditing(true);
      setSelectedType('cron');
      return;
    }
    if (newType === 'perpetual') {
      // Don't null recheckCron — switching to perpetual keeps any prior cadence.
      setCronEditing(false);
      setUpdating(true);
      setSelectedType('perpetual');
      await onUpdate(taskType, { type: 'perpetual' }).catch(() => {
        setSelectedType(config.type);
      });
      setUpdating(false);
      return;
    }
    setCronEditing(false);
    setUpdating(true);
    setSelectedType(newType);
    await onUpdate(taskType, { type: newType, cronExpression: null }).catch(() => {
      setSelectedType(config.type);
    });
    setUpdating(false);
  };

  const handleCronSave = async (expr) => {
    setUpdating(true);
    await onUpdate(taskType, { type: 'cron', cronExpression: expr }).catch(() => {
      setSelectedType(config.type);
    });
    setCronEditing(false);
    setUpdating(false);
  };

  const handleRecheckCronSave = async (expr) => {
    setUpdating(true);
    // Switching to perpetual together with its recheck cadence in one PUT so a
    // freshly-picked perpetual type lands with the cadence already set.
    await onUpdate(taskType, { type: 'perpetual', recheckCron: expr }).catch(() => {
      setSelectedType(config.type);
    });
    setRecheckEditing(false);
    setUpdating(false);
  };

  const isPaused = !config.enabled;

  const handleToggleEnabled = async () => {
    setUpdating(true);
    await onUpdate(taskType, { enabled: isPaused });
    setUpdating(false);
  };

  const handleProviderChange = async (newProviderId) => {
    setUpdating(true);
    setSelectedProviderId(newProviderId);
    setSelectedModel('');
    const providerId = newProviderId === '' ? null : newProviderId;
    await onUpdate(taskType, { providerId, model: null }).catch(() => {
      setSelectedProviderId(config.providerId || '');
      setSelectedModel(config.model || '');
    });
    setUpdating(false);
  };

  const handleModelChange = async (newModel) => {
    setUpdating(true);
    setSelectedModel(newModel);
    const model = newModel === '' ? null : newModel;
    await onUpdate(taskType, { model }).catch(() => {
      setSelectedModel(config.model || '');
    });
    setUpdating(false);
  };

  const handlePrAuthorFilterChange = async (value) => {
    setUpdating(true);
    // Send the full merged taskMetadata — updateTaskInterval replaces the
    // object wholesale, and loadSchedule re-merges defaults on read.
    await onUpdate(taskType, {
      taskMetadata: { ...(config.taskMetadata || {}), prAuthorFilter: value }
    });
    setUpdating(false);
  };

  const handleIssueAuthorFilterChange = async (value) => {
    setUpdating(true);
    await onUpdate(taskType, {
      taskMetadata: { ...(config.taskMetadata || {}), issueAuthorFilter: value }
    });
    setUpdating(false);
  };

  const handleSwarmCountChange = async (value) => {
    setUpdating(true);
    // 0 = off, 2..6 = swarm size (server keeps both; 1/out-of-range are dropped).
    // taskMetadata is replaced wholesale server-side, so spread the existing keys.
    await onUpdate(taskType, {
      taskMetadata: { ...(config.taskMetadata || {}), swarmCount: value }
    });
    setUpdating(false);
  };

  const handleSavePrompt = async () => {
    setUpdating(true);
    const prompt = promptValue.trim() === '' ? null : promptValue;
    await onUpdate(taskType, { prompt }).catch(() => {
      setPromptValue(config.prompt || '');
    });
    setEditingPrompt(false);
    setUpdating(false);
  };

  const selectedProvider = providers?.find(p => p.id === (selectedProviderId || ''));
  const availableModels = filterSelectableModels(selectedProvider?.models);
  const status = config.status || {};

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <label className="text-sm text-gray-400">Global Pause</label>
          <InfoTooltip label="What does Global Pause do?">
            When paused, no scheduled runs will execute for this task — even if individual apps are enabled.
          </InfoTooltip>
        </div>
        <ToggleSwitch
          enabled={isPaused}
          onChange={handleToggleEnabled}
          disabled={updating}
          ariaLabel={isPaused ? 'Resume runs' : 'Pause all runs'}
        />
      </div>
      {isPaused && (
        <Banner icon={AlertCircle} align="center">
          All scheduled runs are paused for this task
        </Banner>
      )}

      <FormField label="Interval Type" labelClassName="text-sm text-gray-400 block mb-2">
        <select
          value={selectedType}
          onChange={(e) => handleTypeChange(e.target.value)}
          disabled={updating}
          className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
        >
          <option value="rotation">Rotation (runs in task queue)</option>
          <option value="daily">Daily (once per day)</option>
          <option value="weekly">Weekly (once per week)</option>
          <option value="once">Once (run once then stop)</option>
          <option value="on-demand">On Demand (manual trigger only)</option>
          <option value="cron">Cron (custom schedule)</option>
          <option value="perpetual">Perpetual (drain until done, then recheck)</option>
        </select>
        {(selectedType === 'cron' && (cronEditing || config.type === 'cron')) ? (
          <CronInput
            value={config.cronExpression || '0 7 * * *'}
            onSave={handleCronSave}
            onCancel={() => { setCronEditing(false); setSelectedType(config.type); }}
            className="mt-2"
          />
        ) : (
          <p className="text-xs text-gray-500 mt-1">{INTERVAL_DESCRIPTIONS[selectedType]}</p>
        )}
      </FormField>

      {selectedType === 'perpetual' && (
        <div>
          <label className="text-sm text-gray-400 block mb-2">Recheck Cadence</label>
          {(recheckEditing || config.recheckCron) ? (
            <CronInput
              value={config.recheckCron || '0 9 * * *'}
              onSave={handleRecheckCronSave}
              onCancel={() => setRecheckEditing(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setRecheckEditing(true)}
              disabled={updating}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-left text-sm text-gray-300 hover:border-gray-500"
            >
              Daily (default) — click to set a custom recheck schedule
            </button>
          )}
          <p className="text-xs text-gray-500 mt-1">
            Runs back-to-back while actionable work remains, then parks and re-probes on this schedule.
            The check is programmatic (no LLM) — e.g. claim-issue counts open, claimable issues; an issue
            the agent tags <code>needs-input</code> is excluded so the drain converges.
          </p>
          {(() => {
            // claim-issue/claim-work park PER-APP, so prefer the per-app aggregate
            // (config.perpetual) over the global status.reason — which always reads
            // 'perpetual-drain' for app-scoped tasks even when every app is parked.
            const p = config.perpetual;
            if (p && (p.trackedAppCount > 0 || p.globalParked)) {
              const allParked = p.globalParked || (p.trackedAppCount > 0 && p.parkedAppCount === p.trackedAppCount);
              if (allParked) {
                const scope = p.trackedAppCount > 0 ? `${p.trackedAppCount} app(s) parked` : 'Parked';
                return (
                  <p className="text-xs text-port-warning mt-1">
                    {scope}{p.parkReason ? ` (${p.parkReason})` : ''}{p.nextRecheckAt ? ` — next recheck ${formatDateTime(p.nextRecheckAt)}` : ''}
                  </p>
                );
              }
              const partial = p.parkedAppCount > 0 ? ` — ${p.parkedAppCount}/${p.trackedAppCount} app(s) parked` : '';
              return <p className="text-xs text-port-success mt-1">Draining — actionable work available{partial}</p>;
            }
            // Global (non-app) perpetual task: the global status.reason is accurate.
            if (status.reason === 'perpetual-parked') {
              return (
                <p className="text-xs text-port-warning mt-1">
                  Parked{status.parkReason ? ` (${status.parkReason})` : ''}{status.nextRunAt ? ` — rechecks ${formatDateTime(status.nextRunAt)}` : ''}
                </p>
              );
            }
            if (status.reason === 'perpetual-drain' || status.reason === 'perpetual-recheck') {
              return <p className="text-xs text-port-success mt-1">Draining — actionable work available</p>;
            }
            return null;
          })()}
        </div>
      )}

      {!config.taskMetadata?.pipeline?.stages?.length && (
        <>
          <FormField label="Provider (optional)" labelClassName="text-sm text-gray-400 block mb-2">
            <select
              value={selectedProviderId}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={updating}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
            >
              <option value="">Default (active provider)</option>
              {providers?.map(provider => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">Leave as default to use the currently active provider</p>
          </FormField>

          <FormField label="Model (optional)" labelClassName="text-sm text-gray-400 block mb-2">
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={updating}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
            >
              <option value="">Default model</option>
              {selectedModel && !availableModels.includes(selectedModel) && (
                <option value={selectedModel}>{selectedModel}</option>
              )}
              {availableModels.map(model => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">Leave as default to use the provider's default model</p>
          </FormField>
        </>
      )}

      {taskType === 'pr-watcher' && (
        <div>
          <label htmlFor={`pr-author-filter-${taskType}`} className="text-sm text-gray-400 block mb-2">PR Author Filter</label>
          <select
            id={`pr-author-filter-${taskType}`}
            value={config.taskMetadata?.prAuthorFilter || 'any'}
            onChange={(e) => handlePrAuthorFilterChange(e.target.value)}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {PR_AUTHOR_FILTER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {PR_AUTHOR_FILTER_OPTIONS.find(o => o.value === (config.taskMetadata?.prAuthorFilter || 'any'))?.description}
            {' '}Edit the prompt below to control what the agent does for each opened PR (it can use <code>{'{prData}'}</code>, <code>{'{repoFullName}'}</code>, <code>{'{defaultBranch}'}</code>).
          </p>
        </div>
      )}

      {ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`issue-author-filter-${taskType}`} className="text-sm text-gray-400 block mb-2">Issue Author Filter</label>
          <select
            id={`issue-author-filter-${taskType}`}
            value={config.taskMetadata?.issueAuthorFilter || 'self'}
            onChange={(e) => handleIssueAuthorFilterChange(e.target.value)}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {ISSUE_AUTHOR_FILTER_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {ISSUE_AUTHOR_FILTER_OPTIONS.find(o => o.value === (config.taskMetadata?.issueAuthorFilter || 'self'))?.description}.
            {' '}This is the global default — individual apps can override it below.
          </p>
        </div>
      )}

      {SWARM_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`swarm-count-${taskType}`} className="text-sm text-gray-400 block mb-2">Swarm Mode</label>
          <select
            id={`swarm-count-${taskType}`}
            value={config.taskMetadata?.swarmCount || 0}
            onChange={(e) => handleSwarmCountChange(Number(e.target.value))}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {SWARM_COUNT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {SWARM_COUNT_OPTIONS.find(o => o.value === (config.taskMetadata?.swarmCount || 0))?.description}.
            {' '}Mirrors slashdo <code>/do:next --swarm</code> — each run partitions independent issues, fans out one worktree agent per issue, and serializes the merges. GitHub/GitLab issue trackers only.
          </p>
        </div>
      )}

      <PromptEditor
        config={config}
        promptValue={promptValue}
        setPromptValue={setPromptValue}
        editingPrompt={editingPrompt}
        setEditingPrompt={setEditingPrompt}
        handleSavePrompt={handleSavePrompt}
        updating={updating}
        activeApps={activeApps}
      />

      <div>
        <label className="text-sm text-gray-400 block mb-2">Agent Options</label>
        <div className="space-y-2">
          {AGENT_OPTIONS.map(({ field, label, description }) => {
            const enabled = config.taskMetadata?.[field] ?? false;
            const managed = config.managedAgentOptions?.includes(field);
            const lockedHint = `${label} is managed internally by this task — the agent's prompt handles it.`;
            return (
              <button
                key={field}
                type="button"
                disabled={updating || managed}
                aria-pressed={enabled}
                aria-label={managed
                  ? `${label} (managed by task)`
                  : `${enabled ? 'Disable' : 'Enable'} ${label.toLowerCase()}`}
                title={managed ? lockedHint : undefined}
                className={`w-full flex items-center justify-between gap-3 min-h-[44px] rounded px-2 -mx-2 text-left ${updating || managed ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-port-card/30 active:bg-port-card/50'}`}
                onClick={() => onUpdate(taskType, { taskMetadata: toggleMetadataField(config.taskMetadata, field) })}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-white flex items-center gap-2">
                    {label}
                    {managed && <span className="text-[10px] px-1 py-0.5 bg-gray-600/30 text-gray-400 rounded">managed</span>}
                  </span>
                  <p className="text-xs text-gray-500">{managed ? lockedHint : description}</p>
                </div>
                <ToggleSwitch
                  enabled={enabled}
                  disabled={updating || managed}
                  decorative
                />
              </button>
            );
          })}
        </div>
        {(config.taskMetadata?.reviewLoop || config.taskMetadata?.openPR) && (
          <div className="mt-3 pl-2">
            <ReviewerPicker
              reviewers={config.taskMetadata?.reviewers ?? (config.taskMetadata?.reviewer ? [config.taskMetadata.reviewer] : reviewDefaults.reviewers)}
              stopMode={config.taskMetadata?.reviewStopMode || reviewDefaults.stopMode || DEFAULT_REVIEW_STOP_MODE}
              reviewerApplies={config.taskMetadata?.reviewerApplies !== undefined
                ? (config.taskMetadata?.reviewerApplies === true || config.taskMetadata?.reviewerApplies === 'true')
                : reviewDefaults.reviewerApplies}
              disabled={updating}
              onChange={({ reviewers, stopMode, reviewerApplies }) => {
                // Drop the legacy single `reviewer` key so storage converges on `reviewers`.
                const { reviewer: _reviewer, ...rest } = config.taskMetadata || {};
                onUpdate(taskType, {
                  taskMetadata: { ...rest, reviewers, reviewStopMode: stopMode, reviewerApplies }
                });
              }}
            />
          </div>
        )}
      </div>

      {allTaskTypes?.length > 1 && (
        <div>
          <label className="text-sm text-gray-400 block mb-2">Run After (dependencies)</label>
          <div className="flex flex-wrap gap-2">
            {allTaskTypes.filter(t => t !== taskType).map(dep => {
              const isSelected = (config.runAfter || []).includes(dep);
              return (
                <button
                  key={dep}
                  onClick={() => {
                    const current = config.runAfter || [];
                    const updated = isSelected
                      ? current.filter(d => d !== dep)
                      : [...current, dep];
                    onUpdate(taskType, { runAfter: updated.length > 0 ? updated : null });
                  }}
                  disabled={updating}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    isSelected
                      ? 'bg-port-accent/20 border-port-accent/50 text-port-accent'
                      : 'bg-port-card border-port-border text-gray-400 hover:border-gray-500'
                  }`}
                >
                  {dep}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-gray-500 mt-1">This task will wait for selected tasks to complete first within the same cycle</p>
        </div>
      )}

      <div className="flex gap-2">
        <RunTaskButton
          taskType={taskType}
          apps={apps}
          onTrigger={onTrigger}
          improvementDisabled={improvementDisabled}
        />
        {config.type === 'once' && status.reason === 'once-completed' && (
          <button
            onClick={() => onReset(taskType)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-port-warning/20 hover:bg-port-warning/30 text-port-warning rounded transition-colors"
            title="Reset execution history to run this task again"
          >
            <RotateCcw size={14} />
            Reset
          </button>
        )}
      </div>

      {status.completedAt && (
        <div className="text-xs text-gray-500">
          Completed: {formatDateTime(status.completedAt)}
        </div>
      )}
    </div>
  );
}
