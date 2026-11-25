import { useState, useEffect } from 'react';
import useFieldDraft from '../../../../hooks/useFieldDraft';
import { AGENT_OPTIONS, BRANCHES_PER_AGENT_TASK_TYPES, DEPFREE_MODE_TASK_TYPES, LOG_TRIAGE_CAPS, LOG_TRIAGE_TASK_TYPES, RELEASE_OPTIONS, RELEASE_OPTIONS_TASK_TYPES, ISSUE_AUTHOR_FILTER_TASK_TYPES, SWARM_TASK_TYPES } from '../../constants';
import { FormField } from '../../../ui/FormField';
import { formatDateTime } from '../../../../utils/formatters';
import useTaskModelPins from '../../../../hooks/useTaskModelPins';
import PromptEditor from './PromptEditor';
import TaskDependencyPicker from './TaskDependencyPicker';
import TaskModelQuickControls from './TaskModelQuickControls';
import RunTaskButton from './RunTaskButton';
import TaskDataInputs from '../../TaskDataInputs';
import PerpetualStatusSummary from './PerpetualStatusSummary';
import TaskCadenceFields from './TaskCadenceFields';
import TaskEnabledToggle from './TaskEnabledToggle';
import TaskPerpetualFields from './TaskPerpetualFields';
import useTaskScheduleEdit from './useTaskScheduleEdit';
import PrAndIssueFilterSection from './PrAndIssueFilterSection';
import ReviewerPolicySection from './ReviewerPolicySection';
import SwarmAndAgentOptionsSection from './SwarmAndAgentOptionsSection';
import TaskOverrides from './TaskOverrides';
import { pipelineStages, IMPROVEMENT_DISABLED_TITLE, SAVING_TITLE, managedAgentOptionsFor } from './scheduleConstants';

export default function GlobalConfigControls({ taskType, config, onUpdate, onTrigger, category: _category, providers, providersLoaded = true, activeProviderId, apps, appsStatus, updating, setUpdating, allTaskTypes, improvementDisabled, dataInputCatalog }) {
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
  const pins = useTaskModelPins({ taskType, config, providers, activeProviderId, onUpdate, onBusyChange: setUpdating });

  useEffect(() => {
    if (!editingPrompt) {
      setPromptValue(config.prompt || '');
    }
  }, [config.prompt, editingPrompt]);

  const activeApps = apps?.filter(app => !app.archived) || [];

  const edit = useTaskScheduleEdit({ config, runUpdate });

  const handleSavePrompt = async () => {
    const prompt = promptValue.trim() === '' ? null : promptValue;
    const ok = await runUpdate({ prompt }).catch(() => false);
    if (ok !== false) setEditingPrompt(false);
  };

  const status = config.status || {};
  const userInvokable = config.invocation?.userInvokable !== false;
  const invocationDescription = config.invocation?.description || 'Runs as part of another automation and is not directly invokable.';

  const hasUnsavedPrompt = editingPrompt && promptValue !== (config.prompt || '');
  const runDisabledReason = improvementDisabled ? IMPROVEMENT_DISABLED_TITLE
    : updating ? SAVING_TITLE
    : edit.hasUnsavedSchedule || hasUnsavedPrompt ? 'Save or discard task changes before running.' : '';

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
      <TaskEnabledToggle edit={edit} updating={updating} />

      {edit.rechecksOnDemand && <PerpetualStatusSummary config={config} status={status} />}

      <TaskCadenceFields config={config} edit={edit} updating={updating} />

      {pipelineStages(config).length === 0 && (
        <>
          <TaskModelQuickControls pins={pins} providers={providers} loading={!providersLoaded} disabled={updating} />
          {pins.toolFree && (
            <p className="text-xs text-gray-500">Uses a text API with no tools. Default follows <a href="/models/llms/abuse" className="text-port-accent underline">Abuse Guard source settings</a>; a saved CLI provider must be cleared or replaced.</p>
          )}
        </>
      )}

      <div className="flex gap-2">
        {userInvokable ? (
          <RunTaskButton
            taskType={taskType}
            apps={apps}
            appsStatus={appsStatus}
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
        activeCount={countOverrides('perpetual', 'autoStart', 'recheckCron')}>
        <TaskPerpetualFields config={config} edit={edit} updating={updating} />
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