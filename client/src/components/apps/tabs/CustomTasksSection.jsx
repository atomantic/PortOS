import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Save, X } from 'lucide-react';
import toast from '../../ui/Toast';
import FormField from '../../ui/FormField';
import useUserTimezone from '../../../hooks/useUserTimezone.js';
import * as api from '../../../services/api';
import { parseCronToRecurrence, buildCronFromRecurrence } from '../../../utils/cronHelpers';
import AgentJobProviderFields from '../../cos/AgentJobProviderFields';
import JobCard, { AUTONOMY_OPTIONS, PRIORITY_OPTIONS, ScheduleFields, TaskMetadataFields } from '../../cos/JobCard';
import { filterRunnableProviders } from '../../../utils/providers';
import TaskDataInputs from '../../cos/TaskDataInputs';

export function emptyForm() {
  return {
    name: '',
    description: '',
    promptTemplate: '',
    scheduleMode: 'interval',
    interval: 'weekly',
    scheduledTime: '',
    cronExpression: '',
    cronSchedule: null,
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    providerId: '',
    model: '',
    effort: '',
    dataInputs: [],
    taskMetadata: { useWorktree: true, openPR: true, simplify: true }
  };
}

export function formFromJob(job) {
  return {
    name: job.name || '',
    description: job.description || '',
    promptTemplate: job.promptTemplate || '',
    scheduleMode: job.cronExpression || job.cronSchedule ? 'cron' : 'interval',
    interval: job.interval || 'weekly',
    scheduledTime: job.scheduledTime || '',
    cronExpression: job.cronExpression || '',
    cronSchedule: job.cronSchedule || (job.cronExpression ? parseCronToRecurrence(job.cronExpression) : null),
    priority: job.priority || 'MEDIUM',
    autonomyLevel: job.autonomyLevel || 'manager',
    providerId: job.providerId || '',
    model: job.model || '',
    effort: job.effort || '',
    dataInputs: job.dataInputs || [],
    taskMetadata: { useWorktree: false, openPR: false, simplify: false, ...(job.taskMetadata || {}) }
  };
}

// Build the API payload from form state, scoped to this app as an agent job.
export function toPayload(form, appId) {
  const payload = {
    name: form.name.trim(),
    description: form.description.trim(),
    type: 'agent',
    appId,
    promptTemplate: form.promptTemplate,
    priority: form.priority,
    autonomyLevel: form.autonomyLevel,
    providerId: form.providerId || null,
    model: form.model || null,
    effort: form.effort || null,
    dataInputs: form.dataInputs || [],
    taskMetadata: form.taskMetadata
  };
  if (form.scheduleMode === 'cron') {
    payload.cronExpression = buildCronFromRecurrence(form.cronSchedule) || form.cronExpression?.trim() || null;
    payload.cronSchedule = form.cronSchedule || null;
    payload.scheduledTime = null;
  } else {
    payload.cronExpression = null;
    payload.cronSchedule = null;
    payload.interval = form.interval;
    payload.scheduledTime = form.scheduledTime || null;
  }
  return payload;
}

function TaskForm({ form, setForm, onSave, onCancel, saveLabel, timezone, providers, activeProviderId, dataInputCatalog }) {
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));

  return (
    <div className="space-y-3 bg-port-card border border-port-accent/50 rounded-lg p-4">
      <FormField label="Task name *">
        <input
          type="text"
          placeholder="Task name *"
          value={form.name}
          onChange={e => update('name', e.target.value)}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        />
      </FormField>
      <FormField label="Description">
        <input
          type="text"
          placeholder="Description"
          value={form.description}
          onChange={e => update('description', e.target.value)}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        />
      </FormField>
      <FormField label="Prompt for the agent *">
        <textarea
          placeholder="Prompt for the agent *"
          value={form.promptTemplate}
          onChange={e => update('promptTemplate', e.target.value)}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-32"
        />
      </FormField>

      <ScheduleFields data={form} timezone={timezone} onChange={update} />

      {/* Priority + autonomy */}
      <div className="flex gap-3">
        <select
          aria-label="Priority"
          value={form.priority}
          onChange={e => update('priority', e.target.value)}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        >
          {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          aria-label="Autonomy level"
          value={form.autonomyLevel}
          onChange={e => update('autonomyLevel', e.target.value)}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        >
          {AUTONOMY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
      </div>

      <AgentJobProviderFields
        data={form}
        providers={providers}
        activeProviderId={activeProviderId}
        onChange={patch => setForm(f => ({ ...f, ...patch }))}
      />

      <TaskDataInputs
        catalog={dataInputCatalog}
        value={form.dataInputs}
        onChange={dataInputs => update('dataInputs', dataInputs)}
      />

      <TaskMetadataFields data={form} onChange={patch => setForm(f => ({ ...f, ...patch }))} />

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors">
          <X size={14} /> Cancel
        </button>
        <button onClick={onSave} className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors">
          <Save size={14} /> {saveLabel}
        </button>
      </div>
    </div>
  );
}

export default function CustomTasksSection({ appId, appName, providerCatalog, activeProviderId: inheritedActiveProviderId = '' }) {
  const timezone = useUserTimezone();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(emptyForm);
  const [rawProviders, setRawProviders] = useState(providerCatalog || []);
  const [activeProviderId, setActiveProviderId] = useState(inheritedActiveProviderId);
  const [triggering, setTriggering] = useState(null);
  const [dataInputCatalog, setDataInputCatalog] = useState([]);

  const providers = useMemo(
    () => filterRunnableProviders(rawProviders, tasks.map(job => job.providerId)),
    [rawProviders, tasks]
  );

  const fetchTasks = useCallback(async () => {
    const data = await api.getCosJobs({ silent: true }).catch(() => null);
    const appTasks = (data?.jobs || []).filter(j => j.appId === appId);
    setTasks(appTasks);
    setDataInputCatalog(data?.dataInputCatalog || []);
    setLoading(false);
  }, [appId]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  useEffect(() => {
    if (providerCatalog) {
      setRawProviders(providerCatalog);
      setActiveProviderId(inheritedActiveProviderId || '');
      return;
    }
    api.getProviders({ silent: true }).then(data => {
      setRawProviders(data?.providers || []);
      setActiveProviderId(data?.activeProvider || '');
    }).catch(() => {});
  }, [providerCatalog, inheritedActiveProviderId]);

  const validate = (form) => {
    if (!form.name.trim()) { toast.error('Name is required'); return false; }
    if (!form.promptTemplate.trim()) { toast.error('Prompt is required'); return false; }
    if (form.scheduleMode === 'cron' && !form.cronSchedule && (!form.cronExpression?.trim() || form.cronExpression.trim().split(/\s+/).length !== 5)) {
      toast.error('A valid recurrence or 5-field cron expression is required'); return false;
    }
    return true;
  };

  // The api.* job wrappers toast HTTP/network errors themselves (request() is not
  // silent here), so catches just return null — guarding on the result avoids a
  // second toast and the success-on-error footgun. Deliberate 200 `skipped`
  // outcomes are NOT toasted by the helper, so those branches toast explicitly.
  const handleCreate = async () => {
    if (!validate(createForm)) return;
    const created = await api.createCosJob(toPayload(createForm, appId)).catch(() => null);
    if (!created) return;
    toast.success('Custom task created');
    setCreateForm(emptyForm());
    setShowCreate(false);
    fetchTasks();
  };

  const handleToggle = async (jobId) => {
    const result = await api.toggleCosJob(jobId).catch(() => null);
    if (!result) return;
    setTasks(prev => prev.map(t => t.id === jobId ? { ...t, enabled: result.job.enabled } : t));
  };

  const handleTrigger = async (jobId) => {
    const job = tasks.find(task => task.id === jobId);
    if (!job) return;
    setTriggering(jobId);
    const result = await api.triggerCosJob(jobId).catch(() => null);
    setTriggering(null);
    if (!result) return; // HTTP/network error already toasted by the api helper
    if (result.status === 'skipped') {
      const notify = result.duplicate ? toast.success : toast.error;
      notify(result.reason || 'Task was not queued');
    } else if (result.success === false) toast.error(result.reason || 'Task failed to trigger');
    else toast.success(`${result.started ? 'Started' : 'Triggered'} "${job.name}" for ${appName}`);
    fetchTasks();
  };

  const handleDelete = async (jobId) => {
    const result = await api.deleteCosJob(jobId).catch(() => null);
    if (!result) return;
    toast.success('Custom task deleted');
    setTasks(prev => prev.filter(t => t.id !== jobId));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Custom Tasks</h3>
          <p className="text-sm text-gray-500">Your own prompt + schedule, run by a CoS agent against this app</p>
        </div>
        <button
          onClick={() => setShowCreate(v => !v)}
          className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors"
        >
          <Plus size={16} /> New Custom Task
        </button>
      </div>

      {showCreate && (
        <TaskForm
          form={createForm}
          setForm={setCreateForm}
          onSave={handleCreate}
          onCancel={() => setShowCreate(false)}
          saveLabel="Create"
          timezone={timezone}
          providers={providers}
          activeProviderId={activeProviderId}
          dataInputCatalog={dataInputCatalog}
        />
      )}

      {loading ? (
        <div className="text-sm text-gray-500 py-4">Loading custom tasks…</div>
      ) : tasks.length === 0 ? (
        !showCreate && (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500 text-sm">
            No custom tasks yet. Create one to run a prompt on a schedule for {appName}.
          </div>
        )
      ) : (
        <div className="space-y-2">
          {tasks.map(job => (
            <JobCard
              key={job.id}
              job={job}
              providers={providers}
              activeProviderId={activeProviderId}
              timezone={timezone}
              dataInputCatalog={dataInputCatalog}
              onToggle={handleToggle}
              onTrigger={handleTrigger}
              onDelete={handleDelete}
              onUpdate={fetchTasks}
              validateEdit={validate}
              fixedAppId={appId}
              fixedType="agent"
              showTaskMetadata
              triggering={triggering === job.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
