import { useState, useEffect, useMemo } from 'react';
import useFieldDraft from '../../../../hooks/useFieldDraft';
import { RotateCcw, AlertCircle } from 'lucide-react';
import CronInput from '../../../CronInput';
import { AGENT_OPTIONS, BRANCHES_PER_AGENT_DEFAULT, BRANCHES_PER_AGENT_OPTIONS, BRANCHES_PER_AGENT_TASK_TYPES, DEFAULT_REVIEW_STOP_MODE, IMPLICIT_PR_COMPLETION, PR_AUTHOR_FILTER_OPTIONS, PR_COMPLETION_OPTIONS, pinnedPrCompletion, prCompletionOption, ISSUE_AUTHOR_FILTER_OPTIONS, ISSUE_AUTHOR_FILTER_TASK_TYPES, SWARM_COUNT_OPTIONS, SWARM_TASK_TYPES } from '../../constants';
import ReviewerPicker from '../../ReviewerPicker';
import Banner from '../../../ui/Banner';
import InfoTooltip from '../../../ui/InfoTooltip';
import { FormField } from '../../../ui/FormField';
import { formatDateTime } from '../../../../utils/formatters';
import { useCodeReviewDefaults } from '../../../../hooks/useCodeReviewDefaults';
import useReviewerModelOptions from '../../../../hooks/useReviewerModelOptions';
import { reviewerModelsFromDefaults, reviewerEffortsFromDefaults } from '../../../../lib/reviewerModels';
import ToggleSwitch from '../../../ToggleSwitch';
import useTaskModelPins from '../../../../hooks/useTaskModelPins';
import { effectiveModelFor } from '../../../../utils/providers';
import EffortSelect from '../../EffortSelect';
import PromptEditor from './PromptEditor';
import RunTaskButton from './RunTaskButton';
import TaskDataInputs from '../../TaskDataInputs';
import { INTERVAL_DESCRIPTIONS, PERPETUAL_DESCRIPTION, toggleMetadataField, pipelineStages, IMPROVEMENT_DISABLED_TITLE, SAVING_TITLE, fileIssuesEffective, managedAgentOptionsFor, toggleFileIssuesMetadata } from './scheduleConstants';

// Shown for the unpinned ('' → inherit) choice: the task type is global, so the
// policy is whatever each target app configured, and PortOS's own self-improvement
// runs (no app) land on the server-side fallback.
const PR_COMPLETION_INHERIT_HINT = `Uses the target app's "After opening PR" default (Apps → Edit App), or "${prCompletionOption(IMPLICIT_PR_COMPLETION)?.label}" when it has none.`;

// These fields are the task-local reviewer-loop override. Removing them lets
// the picker and server resolver fall back to the install-wide Code Review
// Defaults without changing the task's PR policy or other agent options.
const REVIEW_CONFIG_KEYS = [
  'reviewer',
  'reviewers',
  'usernames',
  'optionalReviewers',
  'reviewerMaxRounds',
  'reviewerModels',
  'reviewerEfforts',
  'reviewStopMode',
  'reviewerApplies',
];

export default function GlobalConfigControls({ taskType, config, onUpdate, onTrigger, category: _category, providers, activeProviderId, apps, updating, setUpdating, allTaskTypes, improvementDisabled, dataInputCatalog }) {
  const reviewDefaults = useCodeReviewDefaults();
  // Resolved model lists for the reviewer table's Model column (the picker itself
  // never fetches — see its `modelOptions` prop).
  const reviewerModelOptions = useReviewerModelOptions();
  // The install defaults persist per-reviewer models and efforts as `<reviewer>Model`
  // / `<reviewer>Effort` scalars; the picker takes token-keyed maps. Memoized so a
  // re-render (every `updating` flip) doesn't re-walk the roster and hand the picker
  // fresh object identities. Mirrors SlashDoRunDrawer's `seededReview`.
  const seededPins = useMemo(() => ({
    models: reviewerModelsFromDefaults(reviewDefaults),
    efforts: reviewerEffortsFromDefaults(reviewDefaults),
  }), [reviewDefaults]);
  const [selectedType, setSelectedType] = useState(config.type);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptValue, setPromptValue] = useState(config.prompt || '');
  const descriptionDraft = useFieldDraft(
    config.description || '',
    async (next) => {
      setUpdating(true);
      await onUpdate(taskType, { description: next.trim() || null }).catch(() => {});
      setUpdating(false);
    },
  );
  // Comma-separated free text, committed to taskMetadata.issueExcludeLabels
  // (an array) on blur. Routes through setUpdating like every other handler
  // in this file so RunTaskButton (client/src/AGENTS.md's "gate on in-flight
  // saves, not just the form" rule) can't fire against the pre-edit list
  // while this PATCH is still in flight.
  const excludeLabelsDraft = useFieldDraft(
    (config.taskMetadata?.issueExcludeLabels || []).join(', '),
    async (next) => {
      setUpdating(true);
      await onUpdate(taskType, {
        taskMetadata: { ...(config.taskMetadata || {}), issueExcludeLabels: next.split(',').map((s) => s.trim()).filter(Boolean) }
      });
      setUpdating(false);
    }
  );
  // Provider/model/effort pins are shared with the schedule card's quick
  // controls — same optimistic write + rollback, one implementation.
  const {
    providerId: selectedProviderId,
    model: selectedModel,
    effort: selectedEffort,
    provider: selectedProvider,
    defaultProviderLabel,
    availableModels,
    changeProvider: handleProviderChange,
    changeModel: handleModelChange,
    changeEffort: handleEffortChange,
  } = useTaskModelPins({ taskType, config, providers, activeProviderId, onUpdate, onBusyChange: setUpdating });

  useEffect(() => {
    setSelectedType(config.type);
    if (!editingPrompt) {
      setPromptValue(config.prompt || '');
    }
  }, [config.type, config.prompt, editingPrompt]);

  const activeApps = apps?.filter(app => !app.archived) || [];

  const [cronEditing, setCronEditing] = useState(false);
  const [recheckEditing, setRecheckEditing] = useState(false);

  const handleTypeChange = async (newType) => {
    if (newType === 'cron') {
      // Open the editor rather than saving: the cadence isn't chosen until an
      // expression is committed (handleCronSave writes both fields together).
      setCronEditing(true);
      setSelectedType('cron');
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

  // Perpetual is orthogonal to the cadence — toggling it never touches `type`,
  // so a Scheduled task keeps its expression and an On-Demand one stays manual.
  // No local optimistic state to roll back, so this awaits bare like
  // handleToggleEnabled rather than attaching its own rejection handler.
  const handlePerpetualToggle = async () => {
    setUpdating(true);
    await onUpdate(taskType, { perpetual: !config.perpetual });
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
    await onUpdate(taskType, { recheckCron: expr }).catch(() => {});
    setRecheckEditing(false);
    setUpdating(false);
  };

  const isPaused = !config.enabled;

  const handleToggleEnabled = async () => {
    setUpdating(true);
    await onUpdate(taskType, { enabled: isPaused });
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

  const handleBranchesPerAgentChange = async (value) => {
    setUpdating(true);
    await onUpdate(taskType, {
      taskMetadata: { ...(config.taskMetadata || {}), branchesPerAgent: value }
    });
    setUpdating(false);
  };

  // '' drops the key so the task inherits its app's `defaultPrCompletion` —
  // which works because no DEFAULT_TASK_INTERVALS entry ships a `prCompletion`
  // for loadSchedule to merge back underneath. The legacy `reviewLoop` bit is
  // the pre-`prCompletion` spelling of the same decision, so it goes too rather
  // than outvoting whatever the user just picked.
  const handlePrCompletionChange = async (value) => {
    setUpdating(true);
    const { prCompletion: _pinned, reviewLoop: _legacy, ...rest } = config.taskMetadata || {};
    await onUpdate(taskType, {
      taskMetadata: value ? { ...rest, prCompletion: value } : rest
    });
    setUpdating(false);
  };

  const handleResetReviewConfig = async () => {
    setUpdating(true);
    const metadata = config.taskMetadata || {};
    const taskMetadata = Object.fromEntries(
      Object.entries(metadata).filter(([key]) => !REVIEW_CONFIG_KEYS.includes(key))
    );
    await onUpdate(taskType, { taskMetadata });
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

  const prCompletion = pinnedPrCompletion(config.taskMetadata);
  // Reviewers only run under review-then-merge, so the picker hides for the two
  // policies that never reach them — but an unpinned ('') task may still inherit
  // review-then-merge from its app, so that keeps it.
  const reviewersApply = config.taskMetadata?.openPR
    ? prCompletion === '' || prCompletion === 'review-then-merge'
    : !!config.taskMetadata?.reviewLoop;

  // `selectedProvider` / `availableModels` come from useTaskModelPins above — it
  // resolves the pin against the active provider, lists Antigravity's BASE models
  // (this panel persists a separate Thinking Effort), and keeps a stale suffixed
  // pin selectable so it still runs while showing what it is.
  const status = config.status || {};
  const userInvokable = config.invocation?.userInvokable !== false;
  const invocationDescription = config.invocation?.description || 'Runs as part of another automation and is not directly invokable.';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-gray-400">Global Pause</span>
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

      <FormField label="Summary / byline" labelClassName="text-sm text-gray-400 block mb-2">
        <input
          id={`schedule-description-${taskType}`}
          type="text"
          maxLength={240}
          value={descriptionDraft.value}
          onChange={descriptionDraft.onChange}
          onBlur={descriptionDraft.onBlur}
          disabled={updating}
          placeholder={config.description || 'Explain what this scheduled task does'}
          className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
        />
        <p className="text-xs text-gray-500 mt-1">Shown on scheduled-task cards and upcoming-task lists. It does not change the prompt.</p>
      </FormField>

      <FormField label="Interval Type" labelClassName="text-sm text-gray-400 block mb-2">
        <select
          value={selectedType}
          onChange={(e) => handleTypeChange(e.target.value)}
          disabled={updating}
          className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
        >
          <option value="on-demand">On Demand (manual trigger only)</option>
          <option value="cron">Scheduled (cron)</option>
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

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-gray-400">Perpetual</span>
          <InfoTooltip label="What does Perpetual do?">
            {PERPETUAL_DESCRIPTION}. It applies to either cadence: an On-Demand
            perpetual task drains whenever it isn&apos;t parked, and a Scheduled
            one starts its drain on the cron slot and rechecks on the same schedule.
          </InfoTooltip>
        </div>
        <ToggleSwitch
          enabled={!!config.perpetual}
          onChange={handlePerpetualToggle}
          disabled={updating}
          ariaLabel={config.perpetual ? 'Disable perpetual drain' : 'Enable perpetual drain'}
        />
      </div>

      {config.perpetual && selectedType === 'cron' && (
        <p className="text-xs text-gray-500">
          Each cron slot starts a drain that runs back-to-back while actionable work remains;
          once it parks, the same schedule gates the next attempt.
        </p>
      )}

      {config.perpetual && selectedType === 'on-demand' && (
        <div>
          <span className="text-sm text-gray-400 block mb-2">Recheck Cadence</span>
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
            // (config.perpetualStatus) over the global status.reason — which always
            // reads 'perpetual-drain' for app-scoped tasks even when every app is parked.
            const p = config.perpetualStatus;
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

      {pipelineStages(config).length === 0 && (
        <>
          <FormField label="Provider (optional)" labelClassName="text-sm text-gray-400 block mb-2">
            <select
              value={selectedProviderId}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={updating}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
            >
              <option value="">{defaultProviderLabel}</option>
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
              {/* `availableModels` already carries a pin the provider no longer
                  lists, so the select can't render blank and read as "Default". */}
              <option value="">Default model</option>
              {availableModels.map(model => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">Leave as default to use the provider's default model</p>
          </FormField>

          <EffortSelect
            provider={selectedProvider}
            model={effectiveModelFor(selectedProvider, selectedModel)}
            value={selectedEffort}
            onChange={handleEffortChange}
            disabled={updating}
            label="Thinking Effort (optional)"
            labelClassName="text-sm text-gray-400 block mb-2"
            hint="How hard the model reasons per turn — higher is slower and costlier but more thorough"
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          />
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

      {ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`issue-exclude-labels-${taskType}`} className="text-sm text-gray-400 block mb-2">Leave issues with these labels for humans</label>
          <input
            id={`issue-exclude-labels-${taskType}`}
            type="text"
            value={excludeLabelsDraft.value}
            onChange={excludeLabelsDraft.onChange}
            onBlur={excludeLabelsDraft.onBlur}
            disabled={updating}
            placeholder="good first issue, help wanted"
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Comma-separated labels. An issue carrying any of these is skipped by autonomous claiming, on top of the fixed <code>in-progress</code>/<code>blocked</code>/<code>needs-input</code>/<code>future</code>/<code>wontfix</code>/<code>question</code>/<code>discussion</code> set.
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

      {BRANCHES_PER_AGENT_TASK_TYPES.has(taskType) && (
        <div>
          <label htmlFor={`branches-per-agent-${taskType}`} className="text-sm text-gray-400 block mb-2">Branches per agent</label>
          <select
            id={`branches-per-agent-${taskType}`}
            value={config.taskMetadata?.branchesPerAgent || BRANCHES_PER_AGENT_DEFAULT}
            onChange={(e) => handleBranchesPerAgentChange(Number(e.target.value))}
            disabled={updating}
            className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
          >
            {BRANCHES_PER_AGENT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {BRANCHES_PER_AGENT_OPTIONS.find(o => o.value === (config.taskMetadata?.branchesPerAgent || BRANCHES_PER_AGENT_DEFAULT))?.description}.
            {' '}Branches are prioritized deterministically; the next drain picks up the remainder after this batch progresses.
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

      <TaskDataInputs
        catalog={dataInputCatalog}
        value={config.dataInputs || []}
        disabled={updating}
        onChange={async (dataInputs) => {
          setUpdating(true);
          await onUpdate(taskType, { dataInputs });
          setUpdating(false);
        }}
      />

      {config.fileIssuesCapable && (
        <button
          type="button"
          disabled={updating}
          aria-pressed={fileIssuesEffective(config)}
          aria-label={fileIssuesEffective(config) ? 'File issues only (on)' : 'File issues only (off)'}
          className={`w-full flex items-center justify-between gap-3 min-h-[44px] rounded px-2 -mx-2 text-left ${updating ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-port-card/30 active:bg-port-card/50'}`}
          onClick={async () => {
            setUpdating(true);
            await onUpdate(taskType, {
              taskMetadata: toggleFileIssuesMetadata(
                config.taskMetadata,
                !fileIssuesEffective(config),
                config.doWorkRequiresWorktree,
              )
            });
            setUpdating(false);
          }}
        >
          <div className="min-w-0 flex-1">
            <span className="text-sm text-white">File issues only</span>
            <p className="text-xs text-gray-500">
              When on, the agent reads the code and files tracker issues — it does not change source.
              When off, it implements the highest-value fix.
            </p>
          </div>
          <ToggleSwitch enabled={fileIssuesEffective(config)} disabled={updating} decorative />
        </button>
      )}

      <div>
        <span className="text-sm text-gray-400 block mb-2">Agent Options</span>
        <div className="space-y-2">
          {AGENT_OPTIONS.map(({ field, label, description }) => {
            const enabled = config.taskMetadata?.[field] ?? false;
            const managed = managedAgentOptionsFor(config).includes(field);
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
        {config.taskMetadata?.openPR && (
          <FormField label="After opening PR" className="mt-3" labelClassName="text-sm text-gray-400 block mb-2">
            <select
              value={prCompletion}
              onChange={(e) => handlePrCompletionChange(e.target.value)}
              disabled={updating}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
            >
              <option value="">App default</option>
              {PR_COMPLETION_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              {prCompletionOption(prCompletion)?.description || PR_COMPLETION_INHERIT_HINT}
            </p>
          </FormField>
        )}
        {reviewersApply && (
          <div className="mt-3 pl-2">
            {REVIEW_CONFIG_KEYS.some((key) => key in (config.taskMetadata || {})) && (
              <button
                type="button"
                onClick={handleResetReviewConfig}
                disabled={updating}
                className="mb-2 flex items-center gap-1 text-xs text-gray-400 hover:text-white disabled:opacity-50"
                title="Remove this task's code review override and use the system Code Review Defaults"
              >
                <RotateCcw size={13} />
                Use system Code Review Defaults
              </button>
            )}
            <ReviewerPicker
              reviewers={config.taskMetadata?.reviewers ?? (config.taskMetadata?.reviewer ? [config.taskMetadata.reviewer] : reviewDefaults.reviewers)}
              usernames={config.taskMetadata?.usernames ?? reviewDefaults.usernames}
              optionalReviewers={config.taskMetadata?.optionalReviewers ?? reviewDefaults.optionalReviewers}
              reviewerMaxRounds={config.taskMetadata?.reviewerMaxRounds ?? reviewDefaults.reviewerMaxRounds}
              // The task type's own pins when it has them, else the install's Code
              // Review Defaults (persisted as `<reviewer>Model` scalars).
              reviewerModels={config.taskMetadata?.reviewerModels ?? seededPins.models}
              reviewerEfforts={config.taskMetadata?.reviewerEfforts ?? seededPins.efforts}
              modelOptions={reviewerModelOptions}
              installed={reviewDefaults.installed}
              stopMode={config.taskMetadata?.reviewStopMode || reviewDefaults.stopMode || DEFAULT_REVIEW_STOP_MODE}
              reviewerApplies={config.taskMetadata?.reviewerApplies !== undefined
                ? (config.taskMetadata?.reviewerApplies === true || config.taskMetadata?.reviewerApplies === 'true')
                : reviewDefaults.reviewerApplies}
              disabled={updating}
              onChange={({ reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, stopMode, reviewerApplies }) => {
                // Drop the legacy single `reviewer` key so storage converges on `reviewers`.
                const { reviewer: _reviewer, ...rest } = config.taskMetadata || {};
                onUpdate(taskType, {
                  taskMetadata: { ...rest, reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewStopMode: stopMode, reviewerApplies }
                });
              }}
            />
          </div>
        )}
      </div>

      {allTaskTypes?.length > 1 && (
        <div>
          <span className="text-sm text-gray-400 block mb-2">Run After (dependencies)</span>
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
        {userInvokable ? (
          <RunTaskButton
            taskType={taskType}
            apps={apps}
            onTrigger={onTrigger}
            installWide={config.installWide}
            // `updating` covers an in-flight pin write here, same race the card gates on.
            disabledReason={improvementDisabled ? IMPROVEMENT_DISABLED_TITLE : (updating ? SAVING_TITLE : '')}
          />
        ) : (
          <div className="text-xs text-port-warning/80" title={invocationDescription}>
            {config.invocation?.label || 'Automation-only'} — runs from its parent automation
          </div>
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
