import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw, Play, Trash2, ChevronDown, ChevronUp, Clock, ToggleLeft, ToggleRight, Edit3, Save, X, Terminal } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import { timeAgo } from '../../../utils/formatters';
import { CRON_PRESETS, describeCron } from '../../../utils/cronHelpers';

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

const SCHEDULE_MODE_OPTIONS = [
  { value: 'interval', label: 'Interval' },
  { value: 'cron', label: 'Cron' }
];

const PRIORITY_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const AUTONOMY_OPTIONS = [
  { value: 'standby', label: 'Standby', desc: 'Creates tasks but waits for approval' },
  { value: 'assistant', label: 'Assistant', desc: 'Creates tasks, notifies you' },
  { value: 'manager', label: 'Manager', desc: 'Executes tasks autonomously' },
  { value: 'yolo', label: 'YOLO', desc: 'Full autonomy, no guardrails' }
];

const TRIGGER_ACTION_OPTIONS = [
  { value: 'log-only', label: 'Log Only' },
  { value: 'spawn-agent', label: 'Spawn Agent' },
  { value: 'create-task', label: 'Create Task' }
];

const SHELL_TRIGGER_ACTIONS = new Set(['spawn-agent', 'create-task']);
const SHELL_TRIGGER_ACTION_OPTIONS = TRIGGER_ACTION_OPTIONS.filter(
  opt => !SHELL_TRIGGER_ACTIONS.has(opt.value)
);

const JOB_TYPE_OPTIONS = [
  { value: 'agent', label: 'AI Agent' },
  { value: 'shell', label: 'Shell Command' }
];

const BRIEFING_CONFIG_OPTIONS = [
  { key: 'dailyJoke', label: 'Daily Joke', desc: 'Include a short joke to start the day' },
  { key: 'dailyQuote', label: 'Daily Quote', desc: 'Include an inspirational quote related to focus areas' },
  { key: 'dailyImage', label: 'Daily Image', desc: 'Generate an image via Stable Diffusion (requires image gen API)' }
];

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

function normalizeJobPayload(formData) {
  const payload = { ...formData };
  if (payload.type !== 'shell' && payload.type !== 'script') {
    payload.command = null;
    payload.triggerAction = null;
  }
  if (payload.scheduleMode === 'cron') {
    payload.cronExpression = payload.cronExpression?.trim() || null;
    payload.scheduledTime = null;
  } else {
    payload.cronExpression = null;
  }
  delete payload.scheduleMode;
  return payload;
}

function ScheduleFields({ data, onChange }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400">Schedule:</span>
        {SCHEDULE_MODE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange('scheduleMode', opt.value)}
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
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={data.cronExpression || ''}
            onChange={e => onChange('cronExpression', e.target.value)}
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono"
            placeholder="0 7 * * *"
            title="Cron expression: minute hour dayOfMonth month dayOfWeek"
          />
          <select
            value=""
            onChange={e => { if (e.target.value) onChange('cronExpression', e.target.value); }}
            className="px-2 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 text-xs"
          >
            <option value="">Presets</option>
            {CRON_PRESETS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          {data.cronExpression && (
            <span className="text-xs text-gray-500">{describeCron(data.cronExpression)}</span>
          )}
        </div>
      ) : (
        <div className="flex gap-3">
          <select
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
          />
        </div>
      )}
    </div>
  );
}

function formatNextDue(job) {
  // Cron jobs: show human-readable schedule (server computes exact next fire time)
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
  const diff = nextDue - Date.now();
  if (diff <= 0) return 'Now';
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `in ${days}d`;
  if (hrs > 0) return `in ${hrs}h`;
  const mins = Math.floor(diff / 60000);
  return `in ${mins}m`;
}

function getJobTypeLabel(job) {
  if (job.type === 'shell') return 'Shell';
  if (job.type === 'script') return 'Script';
  return 'AI';
}

function JobCard({ job, onToggle, onTrigger, onDelete, onUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({});

  const isShell = job.type === 'shell';
  const isScript = job.type === 'script';

  const startEditing = () => {
    const base = {
      name: job.name,
      description: job.description,
      type: job.type || 'agent',
      scheduleMode: job.cronExpression ? 'cron' : 'interval',
      interval: job.interval,
      scheduledTime: job.scheduledTime || '',
      cronExpression: job.cronExpression || '',
      priority: job.priority,
      autonomyLevel: job.autonomyLevel,
      promptTemplate: job.promptTemplate || ''
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
    const payload = normalizeJobPayload(editData);
    const result = await api.updateCosJob(job.id, payload).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Job updated');
    setEditing(false);
    onUpdate();
  };

  const isDue = job.enabled && (
    !job.lastRun || (Date.now() - new Date(job.lastRun).getTime() >= job.intervalMs)
  );

  return (
    <div className={`bg-port-card border rounded-lg transition-colors ${
      job.enabled ? 'border-port-border' : 'border-port-border/50 opacity-60'
    }`}>
      <div className="flex items-center gap-3 p-4">
        {/* Toggle */}
        <button
          onClick={() => onToggle(job.id)}
          className={`shrink-0 transition-colors ${
            job.enabled ? 'text-port-success' : 'text-gray-600'
          }`}
          title={job.enabled ? 'Disable job' : 'Enable job'}
        >
          {job.enabled ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
        </button>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-white font-medium truncate">{job.name}</span>
            {isDue && (
              <span className="px-1.5 py-0.5 bg-port-warning/20 text-port-warning text-xs rounded">
                Due
              </span>
            )}
            <span className={`px-1.5 py-0.5 text-xs rounded ${
              isShell ? 'bg-emerald-500/20 text-emerald-400' :
              isScript ? 'bg-purple-500/20 text-purple-400' :
              'bg-port-bg text-gray-400'
            }`}>
              {getJobTypeLabel(job)}
            </span>
            <span className="px-1.5 py-0.5 bg-port-bg text-gray-400 text-xs rounded">
              {job.category}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {job.cronExpression
                ? <span title={job.cronExpression}>{describeCron(job.cronExpression)}</span>
                : <>
                    {INTERVAL_OPTIONS.find(i => i.value === job.interval)?.label || job.interval}
                    {job.scheduledTime && ` at ${job.scheduledTime}`}
                  </>
              }
            </span>
            <span>Last: {timeAgo(job.lastRun, 'Never')}</span>
            {job.enabled && (
              <span className={isDue ? 'text-port-warning' : 'text-gray-500'}>
                Next: {formatNextDue(job)}
              </span>
            )}
            <span>Runs: {job.runCount || 0}</span>
            {isShell && job.lastExitCode != null && (
              <span className={job.lastExitCode === 0 ? 'text-port-success' : 'text-port-error'}>
                Exit: {job.lastExitCode}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => onTrigger(job.id)}
            className="p-1.5 text-gray-500 hover:text-port-accent transition-colors"
            title="Run now"
          >
            <Play size={14} />
          </button>
          <button
            onClick={startEditing}
            className="p-1.5 text-gray-500 hover:text-white transition-colors"
            title="Edit"
          >
            <Edit3 size={14} />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 text-gray-500 hover:text-white transition-colors"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-port-border p-4 space-y-3">
          {editing ? (
            <>
              <input
                type="text"
                value={editData.name}
                onChange={e => setEditData(d => ({ ...d, name: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                placeholder="Job name"
              />
              <input
                type="text"
                value={editData.description}
                onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                placeholder="Description"
              />
              <div className="flex gap-3">
                <select
                  value={editData.type}
                  onChange={e => setEditData(d => ({ ...d, type: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  disabled={isScript}
                >
                  {JOB_TYPE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                  {isScript && <option value="script">Script Handler</option>}
                </select>
                <select
                  value={editData.priority}
                  onChange={e => setEditData(d => ({ ...d, priority: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {PRIORITY_OPTIONS.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                {editData.type !== 'shell' && (
                  <select
                    value={editData.autonomyLevel}
                    onChange={e => setEditData(d => ({ ...d, autonomyLevel: e.target.value }))}
                    className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  >
                    {AUTONOMY_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                )}
              </div>
              <ScheduleFields data={editData} onChange={(key, val) => setEditData(d => ({ ...d, [key]: val }))} />
              {editData.config && (
                <BriefingConfig
                  config={editData.config}
                  onChange={(key, val) => setEditData(d => ({ ...d, config: { ...d.config, [key]: val } }))}
                />
              )}
              {editData.type === 'shell' ? (
                <>
                  <textarea
                    value={editData.command}
                    onChange={e => setEditData(d => ({ ...d, command: e.target.value }))}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-20"
                    placeholder="Shell command"
                  />
                  <select
                    value={editData.triggerAction}
                    onChange={e => setEditData(d => ({ ...d, triggerAction: e.target.value }))}
                    className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  >
                    {SHELL_TRIGGER_ACTION_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </>
              ) : editData.type === 'script' ? (
                <div className="space-y-1">
                  <span className="text-xs text-gray-400">Legacy script command (read-only)</span>
                  <pre className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 text-sm font-mono">{editData.command || 'No command'}</pre>
                </div>
              ) : (
                <textarea
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
                {isShell && <span>Action: <span className="text-gray-300">{job.triggerAction || 'log-only'}</span></span>}
                <span>Created: <span className="text-gray-300">{job.createdAt ? new Date(job.createdAt).toLocaleDateString() : '—'}</span></span>
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
                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">
                    Last output (exit {job.lastExitCode})
                  </summary>
                  <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded-lg text-xs text-gray-400 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {job.lastOutput}
                  </pre>
                </details>
              )}
              {!isShell && !isScript && (
                <details className="group">
                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">
                    View prompt template
                  </summary>
                  <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded-lg text-xs text-gray-400 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {job.promptTemplate}
                  </pre>
                </details>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() => onDelete(job.id)}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-red-400/60 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function JobsTab() {
  const [jobs, setJobs] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newJob, setNewJob] = useState({
    name: '',
    description: '',
    category: 'custom',
    type: 'agent',
    scheduleMode: 'interval',
    interval: 'daily',
    scheduledTime: '',
    cronExpression: '',
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    promptTemplate: '',
    command: '',
    triggerAction: 'log-only',
    enabled: false
  });

  const fetchJobs = useCallback(async () => {
    const data = await api.getCosJobs().catch(err => {
      toast.error(`Failed to load jobs: ${err.message}`);
      return null;
    });
    if (data) {
      setJobs(data.jobs || []);
      setStats(data.stats || null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const handleCreate = async () => {
    if (!newJob.name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (newJob.type === 'shell' && !newJob.command.trim()) {
      toast.error('Command is required for shell jobs');
      return;
    }
    if (newJob.type !== 'shell' && !newJob.promptTemplate.trim()) {
      toast.error('Prompt template is required for AI jobs');
      return;
    }
    if (newJob.scheduleMode === 'cron' && (!newJob.cronExpression?.trim() || newJob.cronExpression.trim().split(/\s+/).length !== 5)) {
      toast.error('A valid 5-field cron expression is required for cron scheduling');
      return;
    }

    const created = await api.createCosJob(normalizeJobPayload(newJob)).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!created) return;
    toast.success('Job created');
    setNewJob({
      name: '',
      description: '',
      category: 'custom',
      type: 'agent',
      scheduleMode: 'interval',
      interval: 'daily',
      scheduledTime: '',
      cronExpression: '',
      priority: 'MEDIUM',
      autonomyLevel: 'manager',
      promptTemplate: '',
      command: '',
      triggerAction: 'log-only',
      enabled: false
    });
    setShowCreate(false);
    fetchJobs();
  };

  const handleToggle = async (jobId) => {
    const result = await api.toggleCosJob(jobId).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result) {
      toast.success(result.job.enabled ? 'Job enabled' : 'Job disabled');
      fetchJobs();
    }
  };

  const handleTrigger = async (jobId) => {
    toast.loading('Triggering job...', { id: 'job-trigger' });
    const result = await api.triggerCosJob(jobId).catch(err => {
      toast.error(err.message, { id: 'job-trigger' });
      return null;
    });
    if (result) {
      if (result.success === false) {
        toast.error(`Job failed (exit ${result.exitCode ?? '?'})`, { id: 'job-trigger' });
      } else {
        const msg = result.type === 'shell' || result.type === 'script' ? 'Job executed successfully' : 'Job triggered — task queued';
        toast.success(msg, { id: 'job-trigger' });
      }
      fetchJobs();
    }
  };

  const handleDelete = async (jobId) => {
    const result = await api.deleteCosJob(jobId).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Job deleted');
    fetchJobs();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-500">
        Loading system tasks...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">System Tasks</h3>
          <p className="text-sm text-gray-500 mt-1">
            Recurring system-level jobs — AI agents and shell commands
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors"
          >
            <Plus size={16} />
            New Job
          </button>
          <button
            onClick={fetchJobs}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className="flex gap-4 text-xs text-gray-500">
          <span>{stats.enabled} enabled / {stats.total} total</span>
          <span>{stats.totalRuns} total runs</span>
          {stats.nextDue && (
            <span className={stats.nextDue.isDue ? 'text-port-warning' : ''}>
              Next: {stats.nextDue.jobName} ({stats.nextDue.isDue ? 'due now' : new Date(stats.nextDue.nextDueAt).toLocaleString()})
            </span>
          )}
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="bg-port-card border border-port-accent/50 rounded-lg p-4">
          <div className="space-y-3">
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="Job name *"
                value={newJob.name}
                onChange={e => setNewJob(j => ({ ...j, name: e.target.value }))}
                className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <select
                value={newJob.type}
                onChange={e => setNewJob(j => ({ ...j, type: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                {JOB_TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Category"
                value={newJob.category}
                onChange={e => setNewJob(j => ({ ...j, category: e.target.value }))}
                className="w-40 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
            </div>
            <input
              type="text"
              placeholder="Description"
              value={newJob.description}
              onChange={e => setNewJob(j => ({ ...j, description: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            />
            <div className="flex gap-3">
              <select
                value={newJob.priority}
                onChange={e => setNewJob(j => ({ ...j, priority: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                {PRIORITY_OPTIONS.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              {newJob.type !== 'shell' && (
                <select
                  value={newJob.autonomyLevel}
                  onChange={e => setNewJob(j => ({ ...j, autonomyLevel: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {AUTONOMY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label} — {opt.desc}</option>
                  ))}
                </select>
              )}
            </div>
            <ScheduleFields data={newJob} onChange={(key, val) => setNewJob(j => ({ ...j, [key]: val }))} />
            {newJob.type === 'shell' ? (
              <>
                <textarea
                  placeholder="Shell command *"
                  value={newJob.command}
                  onChange={e => setNewJob(j => ({ ...j, command: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-20"
                />
                <select
                  value={newJob.triggerAction}
                  onChange={e => setNewJob(j => ({ ...j, triggerAction: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {(newJob.type === 'shell' ? SHELL_TRIGGER_ACTION_OPTIONS : TRIGGER_ACTION_OPTIONS).map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </>
            ) : (
              <textarea
                placeholder="Prompt template for the agent *"
                value={newJob.promptTemplate}
                onChange={e => setNewJob(j => ({ ...j, promptTemplate: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-32"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors"
              >
                <Plus size={14} />
                Create Job
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Jobs list */}
      {jobs.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <div className="text-gray-500 mb-3">No system tasks configured.</div>
          <p className="text-xs text-gray-600 max-w-md mx-auto">
            System tasks let the Chief of Staff act proactively on your behalf — maintaining repositories, running health checks, processing brain ideas, and more.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              onToggle={handleToggle}
              onTrigger={handleTrigger}
              onDelete={handleDelete}
              onUpdate={fetchJobs}
            />
          ))}
        </div>
      )}
    </div>
  );
}
