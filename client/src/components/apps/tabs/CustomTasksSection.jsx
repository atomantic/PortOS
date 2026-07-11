import { useState, useEffect, useCallback } from 'react';
import { Plus, Play, Trash2, Edit3, Save, X, Clock } from 'lucide-react';
import toast from '../../ui/Toast';
import ToggleSwitch from '../../ToggleSwitch';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';
import * as api from '../../../services/api';
import { timeAgo } from '../../../utils/formatters';
import { CRON_PRESETS, DEFAULT_CRON, describeCron } from '../../../utils/cronHelpers';
import WeekdayTimePicker from '../../WeekdayTimePicker';
import { AGENT_OPTIONS, agentOptionButtonClass } from '../../cos/constants';

const INTERVAL_OPTIONS = [
  { value: 'hourly', label: 'Every Hour' },
  { value: 'every-2-hours', label: 'Every 2 Hours' },
  { value: 'every-4-hours', label: 'Every 4 Hours' },
  { value: 'every-8-hours', label: 'Every 8 Hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 Weeks' },
  { value: 'monthly', label: 'Monthly' }
];

const PRIORITY_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const AUTONOMY_OPTIONS = [
  { value: 'standby', label: 'Standby' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'manager', label: 'Manager' },
  { value: 'yolo', label: 'YOLO' }
];

// Custom tasks always spawn an AI agent scoped to this app. The worktree/PR/simplify
// toggles below mirror the per-app built-in task overrides for visual consistency.
const TASK_META_FIELDS = AGENT_OPTIONS.filter(o => ['useWorktree', 'openPR', 'simplify'].includes(o.field));

function emptyForm() {
  return {
    name: '',
    description: '',
    promptTemplate: '',
    scheduleMode: 'interval',
    interval: 'weekly',
    scheduledTime: '',
    cronExpression: '',
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    taskMetadata: { useWorktree: true, openPR: true, simplify: true }
  };
}

function formFromJob(job) {
  return {
    name: job.name || '',
    description: job.description || '',
    promptTemplate: job.promptTemplate || '',
    scheduleMode: job.cronExpression ? 'cron' : 'interval',
    interval: job.interval || 'weekly',
    scheduledTime: job.scheduledTime || '',
    cronExpression: job.cronExpression || '',
    priority: job.priority || 'MEDIUM',
    autonomyLevel: job.autonomyLevel || 'manager',
    taskMetadata: { useWorktree: false, openPR: false, simplify: false, ...(job.taskMetadata || {}) }
  };
}

// Build the API payload from form state, scoped to this app as an agent job.
function toPayload(form, appId) {
  const payload = {
    name: form.name.trim(),
    description: form.description.trim(),
    type: 'agent',
    appId,
    promptTemplate: form.promptTemplate,
    priority: form.priority,
    autonomyLevel: form.autonomyLevel,
    taskMetadata: form.taskMetadata
  };
  if (form.scheduleMode === 'cron') {
    payload.cronExpression = form.cronExpression?.trim() || null;
    payload.scheduledTime = null;
  } else {
    payload.cronExpression = null;
    payload.interval = form.interval;
    payload.scheduledTime = form.scheduledTime || null;
  }
  return payload;
}

function scheduleSummary(job) {
  if (job.cronExpression) return describeCron(job.cronExpression);
  const label = INTERVAL_OPTIONS.find(i => i.value === job.interval)?.label || job.interval;
  return job.scheduledTime ? `${label} at ${job.scheduledTime}` : label;
}

function TaskForm({ form, setForm, onSave, onCancel, saveLabel }) {
  const update = (key, val) => setForm(f => ({ ...f, [key]: val }));
  // Switching to cron seeds the expression with the default the picker displays
  // (07:00 daily) so an untouched picker is actually saveable — otherwise the
  // form shows a schedule while cronExpression stays empty and Save is blocked.
  const setScheduleMode = (mode) =>
    setForm(f => ({ ...f, scheduleMode: mode, cronExpression: mode === 'cron' && !f.cronExpression ? DEFAULT_CRON : f.cronExpression }));
  // Toggle a git-workflow flag while preserving the system-wide invariant that
  // openPR implies useWorktree (matches toggleAppMetadataOverride used elsewhere):
  // turning openPR on forces useWorktree on; turning useWorktree off forces openPR off.
  const toggleMeta = (field) =>
    setForm(f => {
      const meta = { ...f.taskMetadata, [field]: !f.taskMetadata?.[field] };
      if (field === 'openPR' && meta.openPR) meta.useWorktree = true;
      if (field === 'useWorktree' && !meta.useWorktree) meta.openPR = false;
      return { ...f, taskMetadata: meta };
    });

  return (
    <div className="space-y-3 bg-port-card border border-port-accent/50 rounded-lg p-4">
      <input
        type="text"
        placeholder="Task name *"
        value={form.name}
        onChange={e => update('name', e.target.value)}
        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
      />
      <input
        type="text"
        placeholder="Description"
        value={form.description}
        onChange={e => update('description', e.target.value)}
        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
      />
      <textarea
        placeholder="Prompt for the agent *"
        value={form.promptTemplate}
        onChange={e => update('promptTemplate', e.target.value)}
        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-32"
      />

      {/* Schedule */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">Schedule:</span>
          {['interval', 'cron'].map(mode => (
            <button
              key={mode}
              type="button"
              onClick={() => setScheduleMode(mode)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                form.scheduleMode === mode ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-500 hover:text-gray-300'
              }`}
            >
              {mode === 'interval' ? 'Interval' : 'Cron'}
            </button>
          ))}
        </div>
        {form.scheduleMode === 'cron' ? (
          <div className="space-y-2">
            <WeekdayTimePicker value={form.cronExpression || DEFAULT_CRON} onChange={value => update('cronExpression', value)} />
            <div className="flex gap-2 items-center flex-wrap">
              <input
                type="text"
                value={form.cronExpression || ''}
                onChange={e => update('cronExpression', e.target.value)}
                className="flex-1 min-w-[10rem] px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono"
                placeholder="0 7 * * *"
                title="Cron expression: minute hour dayOfMonth month dayOfWeek"
              />
              <select
                value=""
                onChange={e => { if (e.target.value) update('cronExpression', e.target.value); }}
                className="px-2 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 text-xs"
                aria-label="Cron presets"
              >
                <option value="">Presets</option>
                {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            {form.cronExpression && <span className="text-xs text-gray-500">{describeCron(form.cronExpression)}</span>}
          </div>
        ) : (
          <div className="flex gap-3">
            <select
              value={form.interval}
              onChange={e => update('interval', e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            >
              {INTERVAL_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            <input
              type="time"
              value={form.scheduledTime || ''}
              onChange={e => update('scheduledTime', e.target.value || '')}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              title="Run at a specific time (leave empty for any time)"
            />
          </div>
        )}
      </div>

      {/* Priority + autonomy */}
      <div className="flex gap-3">
        <select
          value={form.priority}
          onChange={e => update('priority', e.target.value)}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        >
          {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={form.autonomyLevel}
          onChange={e => update('autonomyLevel', e.target.value)}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        >
          {AUTONOMY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
      </div>

      {/* Git-workflow options */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-400">Options:</span>
        {TASK_META_FIELDS.map(({ field, shortLabel, label }) => {
          const effective = !!form.taskMetadata?.[field];
          return (
            <button
              key={field}
              type="button"
              onClick={() => toggleMeta(field)}
              aria-pressed={effective}
              aria-label={`${label}: ${effective ? 'on' : 'off'}`}
              title={`${label}: ${effective ? 'on' : 'off'}`}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors border ${agentOptionButtonClass(effective, true)}`}
            >
              {shortLabel}
            </button>
          );
        })}
      </div>

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

export default function CustomTasksSection({ appId, appName }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [triggering, setTriggering] = useState(null);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const fetchTasks = useCallback(async () => {
    const data = await api.getCosJobs().catch(() => null);
    setTasks((data?.jobs || []).filter(j => j.appId === appId));
    setLoading(false);
  }, [appId]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const validate = (form) => {
    if (!form.name.trim()) { toast.error('Name is required'); return false; }
    if (!form.promptTemplate.trim()) { toast.error('Prompt is required'); return false; }
    if (form.scheduleMode === 'cron' && (!form.cronExpression?.trim() || form.cronExpression.trim().split(/\s+/).length !== 5)) {
      toast.error('A valid 5-field cron expression is required'); return false;
    }
    return true;
  };

  // The api.* job wrappers toast HTTP/network errors themselves (request() is not
  // silent here), so catches just return null — guarding on the result avoids a
  // second toast and the success-on-error footgun. Business-logic failures the
  // server returns as a 200 { success: false } are NOT toasted by the helper, so
  // those branches toast explicitly.
  const handleCreate = async () => {
    if (!validate(createForm)) return;
    const created = await api.createCosJob(toPayload(createForm, appId)).catch(() => null);
    if (!created) return;
    toast.success('Custom task created');
    setCreateForm(emptyForm());
    setShowCreate(false);
    fetchTasks();
  };

  const startEdit = (job) => {
    setEditingId(job.id);
    setEditForm(formFromJob(job));
  };

  const handleEditSave = async () => {
    if (!validate(editForm)) return;
    const result = await api.updateCosJob(editingId, toPayload(editForm, appId)).catch(() => null);
    if (!result) return;
    toast.success('Custom task updated');
    setEditingId(null);
    fetchTasks();
  };

  const handleToggle = async (job) => {
    const result = await api.toggleCosJob(job.id).catch(() => null);
    if (!result) return;
    setTasks(prev => prev.map(t => t.id === job.id ? { ...t, enabled: result.job.enabled } : t));
  };

  const handleTrigger = async (job) => {
    setTriggering(job.id);
    const result = await api.triggerCosJob(job.id).catch(() => null);
    setTriggering(null);
    if (!result) return; // HTTP/network error already toasted by the api helper
    if (result.success === false) toast.error('Task failed to trigger');
    else toast.success(`Triggered "${job.name}" for ${appName}`);
    fetchTasks();
  };

  const handleDelete = async (job) => {
    const result = await api.deleteCosJob(job.id).catch(() => null);
    if (!result) return;
    toast.success('Custom task deleted');
    setTasks(prev => prev.filter(t => t.id !== job.id));
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
        <TaskForm form={createForm} setForm={setCreateForm} onSave={handleCreate} onCancel={() => setShowCreate(false)} saveLabel="Create" />
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
            <div key={job.id} className={`bg-port-card border rounded-lg ${job.enabled ? 'border-port-border' : 'border-port-border/50 opacity-70'}`}>
              {editingId === job.id ? (
                <div className="p-3">
                  <TaskForm form={editForm} setForm={setEditForm} onSave={handleEditSave} onCancel={() => setEditingId(null)} saveLabel="Save" />
                </div>
              ) : (
                <div className="p-3 space-y-1">
                  <div className="flex items-center gap-3">
                    <ToggleSwitch enabled={job.enabled} onChange={() => handleToggle(job)} size="sm" activeColor="bg-port-success" ariaLabel={job.enabled ? 'Disable task' : 'Enable task'} />
                    <div className="flex-1 min-w-0">
                      <span className="text-white font-medium truncate">{job.name}</span>
                      <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                        <span className="flex items-center gap-1"><Clock size={10} />{scheduleSummary(job)}</span>
                        <span>Last: {timeAgo(job.lastRun, 'Never')}</span>
                        <span>Runs: {job.runCount || 0}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => handleTrigger(job)} disabled={triggering === job.id || !job.enabled} className="p-1.5 text-gray-500 hover:text-port-accent transition-colors disabled:opacity-40" title="Run now">
                        <Play size={14} />
                      </button>
                      <button onClick={() => startEdit(job)} className="p-1.5 text-gray-500 hover:text-white transition-colors" title="Edit">
                        <Edit3 size={14} />
                      </button>
                      {isConfirming(job.id) ? (
                        <ConfirmButtonPair
                          prompt="Delete?"
                          onConfirm={() => confirmDelete(() => handleDelete(job))}
                          onCancel={cancelDelete}
                          ariaLabel="Confirm delete custom task"
                        />
                      ) : (
                        <button onClick={() => requestDelete(job.id)} className="p-1.5 text-red-400/60 hover:text-red-400 transition-colors" title="Delete">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  {job.description && <p className="text-xs text-gray-500 pl-12">{job.description}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
