import { useState } from 'react';
import { Check, Save, X } from 'lucide-react';
import { sortByLabel } from '../../lib/sortByLabel.js';
import { updateCosJob } from '../../services/apiAgents.js';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useSingleFlight } from '../../hooks/useSingleFlight';
import { parseCronToRecurrence } from '../../utils/cronHelpers';
import toast from '../ui/Toast';
import FormField from '../ui/FormField';
import { ScheduleFields } from './JobScheduleFields';
import AgentJobProviderFields, { hasRunnableAgentProvider } from './AgentJobProviderFields';
import { AGENT_OPTIONS, agentOptionButtonClass } from './constants';
import TaskDataInputs from './TaskDataInputs';
import { JobFormFieldsEditor, JobFormValueInputs, missingRequiredJobFormFields } from './JobFormFields';
import { BRIEFING_CONFIG_OPTIONS, JOB_TYPE_OPTIONS, isAgentJobType, normalizeJobPayload } from './jobCardConfig';

function BriefingConfig({ config, onChange }) {
  return (
    <div className="space-y-2">
      <span className="text-xs text-gray-400">Briefing Enrichments</span>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {BRIEFING_CONFIG_OPTIONS.map(opt => (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key, !config[opt.key])}
            aria-pressed={Boolean(config[opt.key])}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
              config[opt.key]
                ? 'border-port-accent/50 bg-port-accent/10 text-white'
                : 'border-port-border bg-port-bg text-gray-500 hover:text-gray-300'
            }`}
          >
            <span className={`w-3 h-3 rounded-sm border shrink-0 ${
              config[opt.key] ? 'bg-port-accent border-port-accent' : 'border-gray-600'
            }`} />
            <div>
              <div className="font-medium">{opt.label}</div>
              <div className="text-xs text-port-text-muted">{opt.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function TaskMetadataFields({ data, onChange }) {
  const toggle = (field) => {
    const metadata = { ...data.taskMetadata, [field]: !data.taskMetadata?.[field] };
    if (field === 'openPR' && metadata.openPR) metadata.useWorktree = true;
    if (field === 'useWorktree' && !metadata.useWorktree) metadata.openPR = false;
    onChange({ taskMetadata: metadata });
  };
  const fields = AGENT_OPTIONS.filter(option => ['useWorktree', 'openPR', 'simplify'].includes(option.field));

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-gray-400">Options:</span>
      {fields.map(({ field, shortLabel, label }) => {
        const effective = !!data.taskMetadata?.[field];
        return (
          <button
            key={field}
            type="button"
            onClick={() => toggle(field)}
            aria-pressed={effective}
            aria-label={`${label}: ${effective ? 'on' : 'off'}`}
            title={`${label}: ${effective ? 'on' : 'off'}`}
            className={`text-xs px-1.5 py-0.5 rounded transition-colors border ${agentOptionButtonClass(effective, true)}`}
          >
            {effective && <Check size={12} aria-hidden="true" />}
            {shortLabel}
          </button>
        );
      })}
    </div>
  );
}

function createEditData(job, { fixedAppId, fixedType, showTaskMetadata }) {
  const base = {
    name: job.name,
    description: job.description,
    type: fixedType || job.type || 'agent',
    scheduleMode: job.cronExpression || job.cronSchedule ? 'cron' : 'interval',
    interval: job.interval,
    scheduledTime: job.scheduledTime || '',
    weekdaysOnly: !!job.weekdaysOnly,
    scheduleAnchor: job.scheduleAnchor ?? null,
    cronExpression: job.cronExpression || '',
    cronSchedule: job.cronSchedule || (job.cronExpression ? parseCronToRecurrence(job.cronExpression) : null),
    priority: job.priority,
    autonomyLevel: job.autonomyLevel,
    promptTemplate: job.promptTemplate || '',
    appId: fixedAppId || job.appId || '',
    providerId: job.providerId || '',
    model: job.model || '',
    effort: job.effort || '',
    ...(job.executionOptions !== undefined ? { executionOptions: job.executionOptions } : {}),
    dataInputs: job.dataInputs || [],
    formFields: job.formFields || [],
    formValues: job.formValues || {},
    taskMetadata: showTaskMetadata
      ? { useWorktree: false, openPR: false, simplify: false, ...(job.taskMetadata || {}) }
      : job.taskMetadata || {}
  };
  // Always initialize shell fields so switching type to 'shell' during editing works
  base.command = job.command || '';
  if (job.id === 'job-daily-briefing') {
    base.config = { dailyJoke: false, dailyQuote: false, dailyImage: false, ...job.config };
  }
  return base;
}

export default function JobEditForm({
  job, apps, providers, activeProviderId, timezone, validateEdit, fixedAppId, fixedType,
  showTaskMetadata, dataInputCatalog, onCancel, onSaved
}) {
  const [editData, setEditData] = useState(() => createEditData(job, { fixedAppId, fixedType, showTaskMetadata }));
  const isAgent = isAgentJobType(editData.type);
  const isScript = job.type === 'script';
  const hasFixedApp = Boolean(fixedAppId);

  const [save, saving] = useAsyncAction(async payload => updateCosJob(job.id, payload, { silent: true }));
  const handleSave = useSingleFlight(async () => {
    if (validateEdit && !validateEdit(editData)) return;
    const providerResolutionKnown = Boolean(editData.providerId || activeProviderId || providers?.length);
    if (isAgent && providerResolutionKnown
      && !hasRunnableAgentProvider(providers, editData.providerId, activeProviderId)) {
      toast.error('Select a CLI/TUI provider before saving an agent job');
      return;
    }
    // The API schema deliberately accepts a half-filled configuration form (a
    // job is routinely saved before it is aimed), so the "required" marker is
    // only real if the form that collects the values enforces it.
    const missingFields = missingRequiredJobFormFields(editData.formFields, editData.formValues);
    if (missingFields.length) {
      toast.error(`Fill in ${missingFields.map(field => field.label || field.key).join(', ')}`);
      return;
    }
    const constrained = {
      ...editData,
      ...(hasFixedApp ? { appId: fixedAppId } : {}),
      ...(fixedType ? { type: fixedType } : {})
    };
    const payload = normalizeJobPayload(constrained);
    const result = await save(payload);
    if (!result) return;
    toast.success('Job updated');
    onSaved();
  });

  return (
    <fieldset disabled={saving} className="min-w-0 space-y-3">
      <FormField label="Job name" labelClassName="block text-xs text-gray-400 mb-1">
        <input
          type="text"
          value={editData.name}
          onChange={e => setEditData(d => ({ ...d, name: e.target.value }))}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        />
      </FormField>
      <FormField
        label="Card summary"
        hint="Shown beneath the task name on its card."
        labelClassName="block text-xs text-gray-400 mb-1"
      >
        <input
          type="text"
          placeholder="One-line summary (optional)"
          value={editData.description}
          onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        />
      </FormField>
      <div className="flex gap-3">
        {fixedType ? (
          <span className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 text-sm">AI Agent</span>
        ) : (
          <select
            aria-label="Job type"
            value={editData.type}
            onChange={e => setEditData(d => ({ ...d, type: e.target.value }))}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            disabled={isScript}
          >
            {JOB_TYPE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            {isScript && <option value="script">Script Handler</option>}
          </select>
        )}
      </div>
      <ScheduleFields data={editData} timezone={timezone} onChange={(key, val) => setEditData(d => ({ ...d, [key]: val }))} />
      {isAgent && !hasFixedApp && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">App scope:</span>
          <select
            aria-label="App scope"
            value={editData.appId || ''}
            onChange={e => setEditData(d => ({ ...d, appId: e.target.value }))}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
          >
            <option value="">Global (PortOS)</option>
            {sortByLabel(apps).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      )}
      {isAgent && (
        <AgentJobProviderFields
          data={editData}
          providers={providers}
          activeProviderId={activeProviderId}
          onChange={patch => setEditData(d => ({ ...d, ...patch }))}
        />
      )}
      {isAgent && (
        <TaskDataInputs
          catalog={dataInputCatalog}
          value={editData.dataInputs}
          onChange={dataInputs => setEditData(d => ({ ...d, dataInputs }))}
        />
      )}
      {isAgent && !job.portosOnly && (
        <JobFormFieldsEditor
          fields={editData.formFields}
          onChange={formFields => setEditData(d => ({ ...d, formFields }))}
        />
      )}
      {isAgent && (
        <JobFormValueInputs
          fields={editData.formFields}
          values={editData.formValues}
          onChange={formValues => setEditData(d => ({ ...d, formValues }))}
        />
      )}
      {showTaskMetadata && isAgent && <TaskMetadataFields data={editData} onChange={patch => setEditData(d => ({ ...d, ...patch }))} />}
      {editData.config && (
        <BriefingConfig
          config={editData.config}
          onChange={(key, val) => setEditData(d => ({ ...d, config: { ...d.config, [key]: val } }))}
        />
      )}
      {editData.type === 'shell' ? (
        <>
          <textarea
            aria-label="Shell command"
            value={editData.command}
            onChange={e => setEditData(d => ({ ...d, command: e.target.value }))}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-20"
            placeholder="Shell command"
          />
          <span className="text-xs text-gray-500">Output and exit code are logged on the job card.</span>
        </>
      ) : editData.type === 'script' ? (
        <div className="space-y-1">
          <span className="text-xs text-gray-400">Legacy script command (read-only)</span>
          <pre className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 text-sm font-mono whitespace-pre-wrap break-all">{editData.command || 'No command'}</pre>
        </div>
      ) : (
        <textarea
          aria-label="Prompt template"
          value={editData.promptTemplate}
          onChange={e => setEditData(d => ({ ...d, promptTemplate: e.target.value }))}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-40"
          placeholder="Prompt template for the agent"
        />
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
        >
          <X size={14} /> Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50"
        >
          <Save size={14} /> Save
        </button>
      </div>
    </fieldset>
  );
}
