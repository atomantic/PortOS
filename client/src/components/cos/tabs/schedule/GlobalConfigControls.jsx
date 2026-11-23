import ExecutionOptionsSelect from '../../../providers/ExecutionOptionsSelect.jsx';
import { useState, useEffect } from 'react';
import useFieldDraft from '../../../../hooks/useFieldDraft';
import { AlertCircle } from 'lucide-react';
import CronInput from '../../../CronInput';
import { describeCron } from '../../../../utils/cronHelpers.js';
import { AGENT_OPTIONS, BRANCHES_PER_AGENT_TASK_TYPES, DEPFREE_MODE_TASK_TYPES, LOG_TRIAGE_CAPS, LOG_TRIAGE_TASK_TYPES, RELEASE_OPTIONS, RELEASE_OPTIONS_TASK_TYPES, ISSUE_AUTHOR_FILTER_TASK_TYPES, SWARM_TASK_TYPES } from '../../constants';
import CollapsibleSection from '../../../ui/CollapsibleSection';
import Banner from '../../../ui/Banner';
import InfoTooltip from '../../../ui/InfoTooltip';
import { FormField } from '../../../ui/FormField';
import { formatDateTime } from '../../../../utils/formatters';
import ToggleSwitch from '../../../ToggleSwitch';
import useTaskModelPins from '../../../../hooks/useTaskModelPins';
import { effectiveModelFor, selectableProviders } from '../../../../utils/providers';
import EffortSelect from '../../EffortSelect';
import PromptEditor from './PromptEditor';
import TaskDependencyPicker from './TaskDependencyPicker';
import RunTaskButton from './RunTaskButton';
import TaskDataInputs from '../../TaskDataInputs';
import PerpetualStatusSummary from './PerpetualStatusSummary';
import PrAndIssueFilterSection from './PrAndIssueFilterSection';
import ReviewerPolicySection from './ReviewerPolicySection';
import SwarmAndAgentOptionsSection from './SwarmAndAgentOptionsSection';
import TaskOverrides from './TaskOverrides';
import { INTERVAL_DESCRIPTIONS, PERPETUAL_DESCRIPTION, ON_DEMAND_PERPETUAL_LABEL, ON_DEMAND_PERPETUAL_DESCRIPTION, pipelineStages, IMPROVEMENT_DISABLED_TITLE, SAVING_TITLE, managedAgentOptionsFor } from './scheduleConstants';

export default function GlobalConfigControls({ taskType, config, onUpdate, onTrigger, category: _category, providers, providersLoaded = true, activeProviderId, apps, updating, setUpdating, allTaskTypes, improvementDisabled, dataInputCatalog }) {
  const [selectedType, setSelectedType] = useState(config.type);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptValue, setPromptValue] = useState(config.prompt || '');
  // Every save routes through here so `updating` covers the whole in-flight PATCH:
  // RunTaskButton (client/src/AGENTS.md's "gate on in-flight saves, not just the
  // form" rule) can't fire against the pre-edit value and Esc can't close the
  // drawer mid-save. Resolves with onUpdate's result; rejections propagate.
  const runUpdate = async (patch) => {
    setUpdating(true);
    try {
      return await onUpdate(taskType, patch);
    } finally {
      setUpdating(false);
    }
  };
  // taskMetadata is replaced wholesale server-side, so spread the existing keys.
  const writeMetadataField = (field, value) => runUpdate({
    taskMetadata: { ...(config.taskMetadata || {}), [field]: value }
  });
  const labelsDraft = useFieldDraft((config.labels || []).join(', '), (next) =>
    runUpdate({ labels: next.split(',').map(label => label.trim()).filter(Boolean) }));
  const descriptionDraft = useFieldDraft(
    config.description || '',
    async (next) => {
      try {
        await runUpdate({ description: next.trim() || null });
      } catch {
        // The field draft owns its error state; keep the editor usable.
      }
    },
  );
  const {
    providerId: selectedProviderId,
    model: selectedModel,
    effort: selectedEffort,
    executionOptions: selectedExecutionOptions,
    changeExecutionOptions: handleExecutionOptionsChange,
    provider: selectedProvider,
    defaultProviderLabel,
    availableModels,
    toolFree,
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
  const [cronDirty, setCronDirty] = useState(false);
  const [recheckDirty, setRecheckDirty] = useState(false);

  const handleTypeChange = async (newType) => {
    if (newType === 'cron') {
      // Open the editor rather than saving: the cadence isn't chosen until an
      // expression is committed (handleCronSave writes both fields together).
      setCronEditing(true);
      setSelectedType('cron');
      return;
    }
    setCronEditing(false);
    setSelectedType(newType);
    const ok = await runUpdate({ type: newType, cronExpression: null, autoStart: false }).catch(() => false);
    if (ok === false) setSelectedType(config.type);
  };

  // Perpetual is orthogonal to the cadence — toggling it never touches `type`,
  // so a Scheduled task keeps its expression and an On-Demand one stays manual.
  // No local optimistic state to roll back, so this awaits bare like
  // handleToggleEnabled rather than attaching its own rejection handler.
  const handlePerpetualToggle = () => runUpdate({
    perpetual: !config.perpetual,
    ...(config.type === 'on-demand' && !config.perpetual ? { autoStart: config.autoStart ?? false } : {}),
  });

  const handleCronSave = async (expr) => {
    const ok = await runUpdate({ type: 'cron', cronExpression: expr }).catch(() => false);
    if (ok !== false) setCronEditing(false);
  };

  const handleRecheckCronSave = async (expr) => {
    const ok = await runUpdate({ recheckCron: expr }).catch(() => false);
    if (ok !== false) setRecheckEditing(false);
  };

  const isPaused = !config.enabled;

  const handleToggleEnabled = () => runUpdate({ enabled: isPaused });

  const handleSavePrompt = async () => {
    const prompt = promptValue.trim() === '' ? null : promptValue;
    const ok = await runUpdate({ prompt }).catch(() => false);
    if (ok !== false) setEditingPrompt(false);
  };

  // `selectedProvider` / `availableModels` come from useTaskModelPins above — it
  // resolves the pin against the active provider, lists Antigravity's BASE models
  // (this panel persists a separate Thinking Effort), and keeps a stale suffixed
  // pin selectable so it still runs while showing what it is.
  const status = config.status || {};
  const userInvokable = config.invocation?.userInvokable !== false;
  const invocationDescription = config.invocation?.description || 'Runs as part of another automation and is not directly invokable.';

  const rechecksOnDemand = config.perpetual && selectedType === 'on-demand' && config.autoStart !== false;
  const hasUnsavedSchedule = selectedType !== config.type || cronDirty || recheckDirty;
  const hasUnsavedPrompt = editingPrompt && promptValue !== (config.prompt || '');
  const runDisabledReason = improvementDisabled ? IMPROVEMENT_DISABLED_TITLE
    : updating ? SAVING_TITLE
    : hasUnsavedSchedule || hasUnsavedPrompt ? 'Save or discard task changes before running.' : '';

  const activeFields = new Set(config.globalOverrideFields || []);
  const countOverrides = (...fields) => fields.filter((field) => activeFields.has(field)).length;
  const countMetadata = (...fields) => countOverrides(...fields.map((field) => `taskMetadata.${field}`));
  const prFilters = taskType === 'pr-watcher'
    ? ['selfManagedPrAuthors', 'selfManagedPrStaleMinutes']
    : ['issueAuthorFilter', 'issueExcludeLabels', 'issueMinAgeMinutes'];
  const dispatchFields = [
    ...(SWARM_TASK_TYPES.has(taskType) ? ['swarmCount'] : []),
    ...(BRANCHES_PER_AGENT_TASK_TYPES.has(taskType) ? ['branchesPerAgent'] : []),
    ...(LOG_TRIAGE_TASK_TYPES.has(taskType) ? LOG_TRIAGE_CAPS.map(({ field }) => field) : []),
    ...(DEPFREE_MODE_TASK_TYPES.has(taskType) ? ['depfreeMode'] : []),
    ...(RELEASE_OPTIONS_TASK_TYPES.has(taskType) ? RELEASE_OPTIONS.map(({ field }) => field) : []),
  ];
  const agentFields = AGENT_OPTIONS.filter(({ field }) => !managedAgentOptionsFor(config).includes(field)).map(({ field }) => field);

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

      {rechecksOnDemand && <PerpetualStatusSummary config={config} status={status} />}

      <FormField label="Interval Type" labelClassName="text-sm text-gray-400 block mb-2">
        <select
          value={selectedType}
          onChange={(e) => handleTypeChange(e.target.value)}
          disabled={updating}
          className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
        >
          <option value="on-demand">{config.perpetual && config.autoStart !== false ? ON_DEMAND_PERPETUAL_LABEL : 'On Demand (manual trigger only)'}</option>
          <option value="cron">Scheduled (cron)</option>
        </select>
        {selectedType === 'on-demand' && (
          <p className="text-xs text-gray-500 mt-1">{config.perpetual && config.autoStart !== false ? ON_DEMAND_PERPETUAL_DESCRIPTION : INTERVAL_DESCRIPTIONS[selectedType]}</p>
        )}
      </FormField>

      {selectedType === 'cron' && (cronEditing || config.type === 'cron') && (
        <CollapsibleSection
          label="Edit schedule"
          summary={describeCron(config.cronExpression)}
          open={cronEditing}
          onOpenChange={(open) => {
            if (open || config.type === 'cron') setCronEditing(open);
          }}
          size="bar"
          keepMounted
        >
          <CronInput
            value={config.cronExpression || '0 7 * * *'}
            onSave={handleCronSave}
            onDirtyChange={setCronDirty}
            onCancel={() => { setCronEditing(false); setSelectedType(config.type); }}
          />
        </CollapsibleSection>
      )}

      {pipelineStages(config).length === 0 && (
        <>
          <FormField label="Provider (optional)" labelClassName="text-sm text-gray-400 block mb-2">
            <select
              value={selectedProviderId}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={updating || !providersLoaded}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm"
            >
              {/* Mid-fetch the list is empty, so "Default (active provider)" would
                  be this select's only option — a slow control that reads broken. */}
              <option value="">{providersLoaded ? defaultProviderLabel : 'Loading providers…'}</option>
              {selectableProviders(providers || [], { selectedId: selectedProviderId, allowed: toolFree ? (provider) => provider.type === 'api' : undefined }).map(provider => (
                <option key={provider.id} value={provider.id} disabled={toolFree && provider.type !== 'api'}>{provider.name}{toolFree && provider.type !== 'api' ? ' (API provider required)' : ''}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">{toolFree
              ? <>Uses a text API with no tools. Default follows <a href="/models/llms/abuse" className="text-port-accent underline">Abuse Guard source settings</a>; a saved CLI provider must be cleared or replaced.</>
              : 'Leave as default to use the currently active provider'}</p>
          </FormField>

          <FormField label="Model (optional)" labelClassName="text-sm text-gray-400 block mb-2">
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={updating || !providersLoaded}
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

        </>
      )}

      <div className="flex gap-2">
        {userInvokable ? (
          <RunTaskButton
            taskType={taskType}
            apps={apps}
            onTrigger={onTrigger}
            installWide={config.installWide}
            programmatic={config.programmatic}
            // `updating` covers an in-flight pin write here, same race the card gates on.
            disabledReason={runDisabledReason}
          />
        ) : (
          <div className="text-xs text-port-warning/80" title={invocationDescription}>
            {config.invocation?.label || 'Automation-only'} — runs from its parent automation
          </div>
        )}
      </div>

      <TaskOverrides label="Schedule & execution options"
        activeCount={countOverrides('perpetual', 'autoStart', 'recheckCron', 'effort', 'executionOptions')}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-gray-400">Perpetual</span>
            <InfoTooltip label="What does Perpetual do?">
              {PERPETUAL_DESCRIPTION}. It applies to either cadence: an On-Demand
              perpetual task starts manually when automatic starts are off, and a Scheduled
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
          <label className="flex items-center justify-between gap-3 text-sm text-gray-400">
            Automatic starts and rechecks
            <input type="checkbox" checked={config.autoStart !== false} disabled={updating}
              onChange={event => runUpdate({ autoStart: event.target.checked }).catch(() => {})} />
          </label>
        )}
        {config.perpetual && selectedType === 'on-demand' && config.autoStart === false && (
          <p className="text-xs text-gray-500">Run Now starts a drain until no actionable work remains. No timer starts or resumes it.</p>
        )}

        {rechecksOnDemand && (
          <div>
            <span className="text-sm text-gray-400 block mb-2">Recheck Cadence</span>
            {(recheckEditing || config.recheckCron) ? (
              <CronInput
                value={config.recheckCron || '0 9 * * *'}
                onDirtyChange={setRecheckDirty}
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
          </div>
        )}

          {pipelineStages(config).length === 0 && (
            <>
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
            <ExecutionOptionsSelect provider={selectedProvider} model={effectiveModelFor(selectedProvider, selectedModel)}
              value={selectedExecutionOptions} onChange={handleExecutionOptionsChange} disabled={updating || !providersLoaded}
              className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm" />
            </>
          )}
      </TaskOverrides>

      {(taskType === 'pr-watcher' || ISSUE_AUTHOR_FILTER_TASK_TYPES.has(taskType)) && (
        <PrAndIssueFilterSection taskType={taskType} config={config} updating={updating}
          activeCount={countMetadata(...prFilters)} onMetadataChange={writeMetadataField} />
      )}

      <SwarmAndAgentOptionsSection taskType={taskType} config={config} updating={updating}
        activeCount={countMetadata(...dispatchFields, ...agentFields, 'stallNudge', ...(config.fileIssuesCapable ? ['fileIssues'] : []))}
        onMetadataChange={writeMetadataField} runUpdate={runUpdate} />

      <ReviewerPolicySection taskType={taskType} config={config} updating={updating} runUpdate={runUpdate} />


      <TaskOverrides label="Prompt & dependencies"
        activeCount={countOverrides('labels', 'description', 'dataInputs', 'suggestedAfter', 'runAfter') + Number(Boolean(config.promptCustomized))}>
        <FormField label="Custom labels" labelClassName="text-sm text-gray-400 block mb-2">
          <input id={`schedule-labels-${taskType}`} value={labelsDraft.value}
            onChange={labelsDraft.onChange} onBlur={labelsDraft.onBlur} disabled={updating}
            placeholder="maintenance, frontend" className="w-full bg-port-card border border-port-border rounded px-3 py-2 text-white text-sm" />
          <p className="text-xs text-gray-500 mt-1">Comma-separated; up to 20 labels, 40 characters each. Shipped labels remain available. Saves on blur.</p>
        </FormField>

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
          onChange={(dataInputs) => runUpdate({ dataInputs })}
        />

        {allTaskTypes?.length > 1 && (
          <>
            {/* Advisory first: it answers "which of these do I run first?", which
                is the question most users open this panel with. The enforced gate
                below it is the rarer, heavier choice. */}
            <TaskDependencyPicker
              label="Suggested order (advisory)"
              hint="Tasks worth running before this one. Advisory only — nothing is blocked, and this task still runs whether or not they have. Use Run After below for a hard gate."
              taskType={taskType}
              options={allTaskTypes}
              value={config.suggestedAfter || []}
              disabled={updating}
              // Sent as-is: an emptied list saves `[]`, which the server reads
              // back as a deliberate clear rather than re-inheriting the
              // shipped order (see normalizeSuggestedAfter).
              onChange={(next) => runUpdate({ suggestedAfter: next })}
            />
            <TaskDependencyPicker
              label="Run After (enforced dependencies)"
              hint="This task waits for the selected tasks to complete first within the same cycle."
              taskType={taskType}
              options={allTaskTypes}
              value={config.runAfter || []}
              disabled={updating}
              onChange={(next) => runUpdate({ runAfter: next.length > 0 ? next : null })}
            />
          </>
        )}

      </TaskOverrides>

      {status.completedAt && (
        <div className="text-xs text-gray-500">
          Completed: {formatDateTime(status.completedAt)}
        </div>
      )}
    </div>
  );
}