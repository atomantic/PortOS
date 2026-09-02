import { useState } from 'react';
import { Play, Trash2, ChevronDown, ChevronUp, Clock, ToggleLeft, ToggleRight, Edit3, Save, X, Terminal } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import { timeAgo, timeUntil, formatDateNumeric } from '../../utils/formatters';
import { DEFAULT_CRON, describeCron, describeRecurrence, parseCronToRecurrence, buildCronFromRecurrence, JOB_INTERVAL_OPTIONS as INTERVAL_OPTIONS } from '../../utils/cronHelpers';
import CronSchedulePicker from '../CronSchedulePicker';
import AgentJobProviderFields, { hasRunnableAgentProvider } from './AgentJobProviderFields';
import { AGENT_OPTIONS, agentOptionButtonClass } from './constants';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import FormField from '../ui/FormField';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import TaskDataInputs from './TaskDataInputs';

const SCHEDULE_MODE_OPTIONS = [
  { value: 'interval', label: 'Interval' },
  { value: 'cron', label: 'Cron' }
];

export const PRIORITY_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const AUTONOMY_OPTIONS = [
  { value: 'standby', label: 'Standby', desc: 'Creates tasks but waits for approval' },
  { value: 'assistant', label: 'Assistant', desc: 'Creates tasks, notifies you' },
  { value: 'manager', label: 'Manager', desc: 'Executes tasks autonomously' },
  { value: 'yolo', label: 'YOLO', desc: 'Full autonomy, no guardrails' }
];

export const TRIGGER_ACTION_OPTIONS = [
  { value: 'log-only', label: 'Log Only' },
  { value: 'spawn-agent', label: 'Spawn Agent' },
  { value: 'create-task', label: 'Create Task' }
];

const SHELL_TRIGGER_ACTIONS = new Set(['spawn-agent', 'create-task']);
export const SHELL_TRIGGER_ACTION_OPTIONS = TRIGGER_ACTION_OPTIONS.filter(
  opt => !SHELL_TRIGGER_ACTIONS.has(opt.value)
);

export const JOB_TYPE_OPTIONS = [
  { value: 'agent', label: 'AI Agent' },
  { value: 'shell', label: 'Shell Command' }
];

// App scope, provider/model override, and prompt template only apply to
// AI-agent jobs — shell/script jobs run a fixed command and never reach the
// AI runner.
export const isAgentJobType = (type) => type !== 'shell' && type !== 'script';

const BRIEFING_CONFIG_OPTIONS = [
  { key: 'dailyJoke', label: 'Daily Joke', desc: 'Include a short joke to start the day' },
  { key: 'dailyQuote', label: 'Daily Quote', desc: 'Include an inspirational quote related to focus areas' },
  { key: 'dailyImage', label: 'Daily Image', desc: 'Generate an image via Stable Diffusion (requires image gen API)' }
];

export function normalizeJobPayload(formData) {
  const payload = { ...formData };
  if (isAgentJobType(payload.type)) {
    payload.command = null;
    payload.triggerAction = null;
  } else {
    // App scope only applies to AI-agent jobs (the scope drives the agent's
    // workspace). Shell/script jobs always run in the PortOS root, so clear any
    // appId left over from when the job was an agent type — otherwise the saved
    // job shows a misleading app badge while executing in root.
    payload.appId = null;
    // Provider/model/effort overrides only apply to AI-agent jobs — clear any
    // leftover selection so a shell/script job doesn't carry a misleading AI badge.
    payload.providerId = null;
    payload.model = null;
    payload.effort = null;
    payload.dataInputs = [];
  }
  // Empty app picker selection ('') → null so a PUT actively un-scopes the job
  // back to global (undefined would be dropped from JSON and updateJob would
  // preserve the old scope). The schema maps '' → null too; sending null directly
  // is unambiguous across create and update.
  if (!payload.appId) payload.appId = null;
  if (payload.scheduleMode === 'cron') {
    const derivedCron = buildCronFromRecurrence(payload.cronSchedule);
    payload.cronExpression = derivedCron || payload.cronExpression?.trim() || null;
    payload.cronSchedule = payload.cronSchedule || null;
    payload.scheduledTime = null;
  } else {
    payload.cronExpression = null;
    payload.cronSchedule = null;
  }
  delete payload.scheduleMode;
  return payload;
}

export function ScheduleFields({ data, onChange, timezone }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400">Schedule:</span>
        {SCHEDULE_MODE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              onChange('scheduleMode', opt.value);
              // Seed the expression with the picker's displayed default (07:00
              // daily) so an untouched Cron picker is actually saveable.
              if (opt.value === 'cron' && !data.cronExpression && !data.cronSchedule) onChange('cronExpression', DEFAULT_CRON);
            }}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              data.scheduleMode === opt.value
                ? 'bg-port-accent/20 text-port-accent'
                : 'bg-port-bg text-gray-500 hover:text-gray-300'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {data.scheduleMode === 'cron' ? (
        <div className="space-y-2">
          <CronSchedulePicker
            value={data.cronSchedule || data.cronExpression || DEFAULT_CRON}
            valueShape="recurrence"
            timezone={timezone}
            onChange={rule => {
              onChange('cronSchedule', rule);
              const cron = buildCronFromRecurrence(rule);
              onChange('cronExpression', cron || null);
            }}
          />
        </div>
      ) : (
        <div className="flex gap-3">
          <select
            aria-label="Interval"
            value={data.interval}
            onChange={e => onChange('interval', e.target.value)}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
          >
            {INTERVAL_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <input
            type="time"
            value={data.scheduledTime || ''}
            onChange={e => onChange('scheduledTime', e.target.value || null)}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            title="Run at specific time (leave empty for any time)"
            aria-label="Run at a specific time (leave empty for any time)"
          />
        </div>
      )}
    </div>
  );
}

function formatNextDue(job) {
  // Cron jobs: show human-readable schedule (server computes exact next fire time)
  if (job.cronSchedule) return describeRecurrence(job.cronSchedule);
  if (job.cronExpression) return describeCron(job.cronExpression);

  const { lastRun, intervalMs, scheduledTime } = job;
  if (!lastRun) return scheduledTime ? `at ${scheduledTime}` : 'Immediately';
  let nextDue = new Date(lastRun).getTime() + intervalMs;
  if (scheduledTime) {
    const [hours, minutes] = scheduledTime.split(':').map(Number);
    const nextDate = new Date(nextDue);
    nextDate.setHours(hours, minutes, 0, 0);
    if (nextDate.getTime() > nextDue) nextDue = nextDate.getTime();
  }
  return timeUntil(nextDue, 'Now');
}

function getJobTypeLabel(job) {
  if (job.type === 'shell') return 'Shell';
  if (job.type === 'script') return 'Script';
  return 'AI';
}

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
              <div className="text-xs opacity-60">{opt.desc}</div>
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
            {shortLabel}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Shared scheduled-job card used by CoS System Tasks and app-scoped Custom
 * Tasks. `fixedAppId`/`fixedType` constrain the edit form for the app surface,
 * while the card, schedule, provider controls, and Run now behavior stay shared.
 */
export default function JobCard({
  job,
  apps = [],
  providers,
  activeProviderId,
  timezone,
  onToggle,
  onTrigger,
  onDelete,
  onUpdate,
  validateEdit = null,
  fixedAppId = null,
  fixedType = null,
  showTaskMetadata = false,
  triggering = false,
  dataInputCatalog = []
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const hasFixedApp = typeof fixedAppId === 'string' && fixedAppId.length > 0;
  const isShell = job.type === 'shell';
  const isScript = job.type === 'script';
  const appName = job.appId ? (apps.find(a => a.id === job.appId)?.name || job.appId) : null;

  const startEditing = () => {
    const base = {
      name: job.name,
      description: job.description,
      type: fixedType || job.type || 'agent',
      scheduleMode: job.cronExpression || job.cronSchedule ? 'cron' : 'interval',
      interval: job.interval,
      scheduledTime: job.scheduledTime || '',
      cronExpression: job.cronExpression || '',
      cronSchedule: job.cronSchedule || (job.cronExpression ? parseCronToRecurrence(job.cronExpression) : null),
      priority: job.priority,
      autonomyLevel: job.autonomyLevel,
      promptTemplate: job.promptTemplate || '',
      appId: hasFixedApp ? fixedAppId : (job.appId || ''),
      providerId: job.providerId || '',
      model: job.model || '',
      effort: job.effort || '',
      dataInputs: job.dataInputs || [],
      taskMetadata: showTaskMetadata
        ? { useWorktree: false, openPR: false, simplify: false, ...(job.taskMetadata || {}) }
        : job.taskMetadata || {}
    };
    // Always initialize shell fields so switching type to 'shell' during editing works
    base.command = job.command || '';
    base.triggerAction = job.triggerAction || 'log-only';
    if (job.id === 'job-daily-briefing') {
      base.config = { dailyJoke: false, dailyQuote: false, dailyImage: false, ...job.config };
    }
    setEditData(base);
    setEditing(true);
    setExpanded(true);
  };

  const handleSave = async () => {
    if (validateEdit && !validateEdit(editData)) return;
    const providerResolutionKnown = Boolean(editData.providerId || activeProviderId || providers?.length);
    if (isAgentJobType(editData.type) && providerResolutionKnown
      && !hasRunnableAgentProvider(providers, editData.providerId, activeProviderId)) {
      toast.error('Select a CLI/TUI provider before saving an agent job');
      return;
    }
    const constrained = {
      ...editData,
      ...(hasFixedApp ? { appId: fixedAppId } : {}),
      ...(fixedType ? { type: fixedType } : {})
    };
    const payload = normalizeJobPayload(constrained);
    const result = await api.updateCosJob(job.id, payload, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Job updated');
    setEditing(false);
    onUpdate();
  };

  const isDue = job.enabled && (job.cronSchedule
    ? (!job.lastRun || Boolean(job.nextRunAt && Date.now() >= new Date(job.nextRunAt).getTime()))
    : (!job.lastRun || (Date.now() - new Date(job.lastRun).getTime() >= job.intervalMs)));

  return (
    <div className={`bg-port-card border rounded-lg transition-colors ${
      job.enabled ? 'border-port-border' : 'border-port-border/50 opacity-60'
    }`}>
      <div className="flex items-center gap-3 p-4">
        <button
          onClick={() => onToggle(job.id)}
          className={`shrink-0 transition-colors ${job.enabled ? 'text-port-success' : 'text-gray-600'}`}
          title={job.enabled ? 'Disable job' : 'Enable job'}
          aria-label={job.enabled ? 'Disable job' : 'Enable job'}
        >
          {job.enabled ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-medium truncate">{job.name}</span>
            {isDue && (
              <span className="px-1.5 py-0.5 bg-port-warning/20 text-port-warning text-xs rounded">Due</span>
            )}
            <span className={`px-1.5 py-0.5 text-xs rounded ${
              isShell ? 'bg-emerald-500/20 text-emerald-400' :
              isScript ? 'bg-port-accent-2/20 text-port-accent-2' :
              'bg-port-bg text-gray-400'
            }`}>
              {getJobTypeLabel(job)}
            </span>
            <span className="px-1.5 py-0.5 bg-port-bg text-gray-400 text-xs rounded">{job.category}</span>
            {!hasFixedApp && appName && (
              <span className="px-1.5 py-0.5 bg-port-accent/15 text-port-accent text-xs rounded" title={`Scoped to app: ${appName}`}>
                {appName}
              </span>
            )}
          </div>
          {job.description?.trim() && (
            <p className="text-xs text-gray-400 truncate mt-1" title={job.description}>{job.description}</p>
          )}
          <div className="flex items-center gap-3 text-xs text-gray-500 mt-1 flex-wrap">
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {job.cronSchedule
                ? <span title={job.cronExpression || undefined}>{describeRecurrence(job.cronSchedule)}</span>
                : job.cronExpression
                ? <span title={job.cronExpression}>{describeCron(job.cronExpression)}</span>
                : <>{INTERVAL_OPTIONS.find(i => i.value === job.interval)?.label || job.interval}{job.scheduledTime && ` at ${job.scheduledTime}`}</>}
            </span>
            <span>Last: {timeAgo(job.lastRun, 'Never')}</span>
            {job.enabled && <span className={isDue ? 'text-port-warning' : 'text-gray-500'}>Next: {formatNextDue(job)}</span>}
            <span>Runs: {job.runCount || 0}</span>
            {isShell && job.lastExitCode != null && (
              <span className={job.lastExitCode === 0 ? 'text-port-success' : 'text-port-error'}>Exit: {job.lastExitCode}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => onTrigger(job.id)}
            disabled={editing || triggering}
            className={`p-1.5 transition-colors text-gray-500 ${editing || triggering ? 'opacity-50 cursor-not-allowed' : 'hover:text-port-accent'}`}
            title={editing ? 'Save changes before running job' : triggering ? 'Triggering job' : 'Run now'}
            aria-label={editing ? 'Save changes before running job' : triggering ? 'Triggering job' : 'Run now'}
          >
            <Play size={14} />
          </button>
          <button
            onClick={startEditing}
            className="p-1.5 text-gray-500 hover:text-white transition-colors"
            title="Edit"
            aria-label="Edit"
          >
            <Edit3 size={14} />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 text-gray-500 hover:text-white transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-port-border p-4 space-y-3">
          {editing ? (
            <>
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
                <select
                  aria-label="Priority"
                  value={editData.priority}
                  onChange={e => setEditData(d => ({ ...d, priority: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                {editData.type !== 'shell' && (
                  <select
                    aria-label="Autonomy level"
                    value={editData.autonomyLevel}
                    onChange={e => setEditData(d => ({ ...d, autonomyLevel: e.target.value }))}
                    className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  >
                    {AUTONOMY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                )}
              </div>
              <ScheduleFields data={editData} timezone={timezone} onChange={(key, val) => setEditData(d => ({ ...d, [key]: val }))} />
              {isAgentJobType(editData.type) && !hasFixedApp && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">App scope:</span>
                  <select
                    aria-label="App scope"
                    value={editData.appId || ''}
                    onChange={e => setEditData(d => ({ ...d, appId: e.target.value }))}
                    className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  >
                    <option value="">Global (PortOS)</option>
                    {apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
              {isAgentJobType(editData.type) && (
                <AgentJobProviderFields
                  data={editData}
                  providers={providers}
                  activeProviderId={activeProviderId}
                  onChange={patch => setEditData(d => ({ ...d, ...patch }))}
                />
              )}
              {isAgentJobType(editData.type) && (
                <TaskDataInputs
                  catalog={dataInputCatalog}
                  value={editData.dataInputs}
                  onChange={dataInputs => setEditData(d => ({ ...d, dataInputs }))}
                />
              )}
              {showTaskMetadata && isAgentJobType(editData.type) && <TaskMetadataFields data={editData} onChange={patch => setEditData(d => ({ ...d, ...patch }))} />}
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
                  <select
                    aria-label="Trigger action"
                    value={editData.triggerAction}
                    onChange={e => setEditData(d => ({ ...d, triggerAction: e.target.value }))}
                    className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  >
                    {SHELL_TRIGGER_ACTION_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
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
                  onClick={() => setEditing(false)}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  <X size={14} /> Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors"
                >
                  <Save size={14} /> Save
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-400">{job.description}</p>
              {isShell && job.command && (
                <div className="flex items-center gap-2 text-xs">
                  <Terminal size={12} className="text-emerald-400 shrink-0" />
                  <code className="text-emerald-300 bg-port-bg px-2 py-1 rounded font-mono">{job.command}</code>
                </div>
              )}
              <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                <span>Priority: <span className="text-gray-300">{job.priority}</span></span>
                {!isShell && <span>Autonomy: <span className="text-gray-300">{job.autonomyLevel}</span></span>}
                {isAgentJobType(job.type) && job.providerId && (
                  <span>AI: <span className="text-gray-300">{providers?.find(p => p.id === job.providerId)?.name || job.providerId}{job.model ? ` / ${job.model}` : ''}{job.effort ? ` · ${job.effort}` : ''}</span></span>
                )}
                {isShell && <span>Action: <span className="text-gray-300">{job.triggerAction || 'log-only'}</span></span>}
                <span>Created: <span className="text-gray-300">{formatDateNumeric(job.createdAt, '—')}</span></span>
              </div>
              {job.config && BRIEFING_CONFIG_OPTIONS.some(o => job.config[o.key]) && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="text-gray-500">Enrichments:</span>
                  {BRIEFING_CONFIG_OPTIONS.filter(o => job.config[o.key]).map(o => (
                    <span key={o.key} className="px-2 py-0.5 bg-port-accent/10 text-port-accent rounded">{o.label}</span>
                  ))}
                </div>
              )}
              {isShell && job.lastOutput && (
                <details className="group">
                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">Last output (exit {job.lastExitCode})</summary>
                  <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded-lg text-xs text-gray-400 font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{job.lastOutput}</pre>
                </details>
              )}
              {!isShell && !isScript && (
                <details className="group">
                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">View prompt template</summary>
                  <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded-lg text-xs text-gray-400 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{job.promptTemplate}</pre>
                </details>
              )}
              {isConfirming(job.id) ? (
                <InlineConfirmRow
                  question="Delete this job? This cannot be undone."
                  confirmTitle="Confirm delete"
                  cancelTitle="Cancel delete"
                  onConfirm={() => confirmDelete(() => onDelete(job.id))}
                  onCancel={cancelDelete}
                />
              ) : (
                <div className="flex justify-end">
                  <button
                    onClick={() => requestDelete(job.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-red-400/60 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
