import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw, Play, Trash2, ChevronDown, ChevronUp, Clock, ToggleLeft, ToggleRight, Edit3, Save, X } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';

const INTERVAL_OPTIONS = [
  { value: 'hourly', label: 'Every Hour' },
  { value: 'every-4-hours', label: 'Every 4 Hours' },
  { value: 'every-8-hours', label: 'Every 8 Hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 Weeks' },
  { value: 'monthly', label: 'Monthly' }
];

const PRIORITY_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const AUTONOMY_OPTIONS = [
  { value: 'standby', label: 'Standby', desc: 'Creates tasks but waits for approval' },
  { value: 'assistant', label: 'Assistant', desc: 'Creates tasks, notifies you' },
  { value: 'manager', label: 'Manager', desc: 'Executes tasks autonomously' },
  { value: 'yolo', label: 'YOLO', desc: 'Full autonomy, no guardrails' }
];

function formatTimeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diff / 60000);
  return mins > 0 ? `${mins}m ago` : 'Just now';
}

function formatNextDue(lastRun, intervalMs, scheduledTime) {
  if (!lastRun) return scheduledTime ? `at ${scheduledTime}` : 'Immediately';
  let nextDue = new Date(lastRun).getTime() + intervalMs;
  // If there's a scheduledTime, adjust the next-due to that time of day
  if (scheduledTime) {
    const [hours, minutes] = scheduledTime.split(':').map(Number);
    const nextDate = new Date(nextDue);
    nextDate.setHours(hours, minutes, 0, 0);
    if (nextDate.getTime() > nextDue) nextDue = nextDate.getTime();
  }
  const diff = nextDue - Date.now();
  if (diff <= 0) return 'Now';
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `in ${days}d`;
  if (hours > 0) return `in ${hours}h`;
  const mins = Math.floor(diff / 60000);
  return `in ${mins}m`;
}

function JobCard({ job, onToggle, onTrigger, onDelete, onUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({});

  const startEditing = () => {
    setEditData({
      name: job.name,
      description: job.description,
      interval: job.interval,
      scheduledTime: job.scheduledTime || '',
      priority: job.priority,
      autonomyLevel: job.autonomyLevel,
      promptTemplate: job.promptTemplate
    });
    setEditing(true);
    setExpanded(true);
  };

  const handleSave = async () => {
    await api.updateCosJob(job.id, editData).catch(err => {
      toast.error(err.message);
      return null;
    });
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
          className={`flex-shrink-0 transition-colors ${
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
            <span className="px-1.5 py-0.5 bg-port-bg text-gray-400 text-xs rounded">
              {job.category}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {INTERVAL_OPTIONS.find(i => i.value === job.interval)?.label || job.interval}
              {job.scheduledTime && ` at ${job.scheduledTime}`}
            </span>
            <span>Last: {formatTimeAgo(job.lastRun)}</span>
            {job.enabled && (
              <span className={isDue ? 'text-port-warning' : 'text-gray-500'}>
                Next: {formatNextDue(job.lastRun, job.intervalMs, job.scheduledTime)}
              </span>
            )}
            <span>Runs: {job.runCount || 0}</span>
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
                  value={editData.interval}
                  onChange={e => setEditData(d => ({ ...d, interval: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {INTERVAL_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <input
                  type="time"
                  value={editData.scheduledTime || ''}
                  onChange={e => setEditData(d => ({ ...d, scheduledTime: e.target.value || null }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  title="Run at specific time (leave empty for any time)"
                />
                <select
                  value={editData.priority}
                  onChange={e => setEditData(d => ({ ...d, priority: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {PRIORITY_OPTIONS.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <select
                  value={editData.autonomyLevel}
                  onChange={e => setEditData(d => ({ ...d, autonomyLevel: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {AUTONOMY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <textarea
                value={editData.promptTemplate}
                onChange={e => setEditData(d => ({ ...d, promptTemplate: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-40"
                placeholder="Prompt template for the agent"
              />
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
              <div className="flex gap-4 text-xs text-gray-500">
                <span>Priority: <span className="text-gray-300">{job.priority}</span></span>
                <span>Autonomy: <span className="text-gray-300">{job.autonomyLevel}</span></span>
                <span>Created: <span className="text-gray-300">{new Date(job.createdAt).toLocaleDateString()}</span></span>
              </div>
              <details className="group">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 transition-colors">
                  View prompt template
                </summary>
                <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded-lg text-xs text-gray-400 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {job.promptTemplate}
                </pre>
              </details>
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
    interval: 'daily',
    scheduledTime: '',
    priority: 'MEDIUM',
    autonomyLevel: 'manager',
    promptTemplate: '',
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
    if (!newJob.name.trim() || !newJob.promptTemplate.trim()) {
      toast.error('Name and prompt template are required');
      return;
    }

    await api.createCosJob(newJob).catch(err => {
      toast.error(err.message);
      return null;
    });
    toast.success('Job created');
    setNewJob({
      name: '',
      description: '',
      category: 'custom',
      interval: 'daily',
      scheduledTime: '',
      priority: 'MEDIUM',
      autonomyLevel: 'manager',
      promptTemplate: '',
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
      toast.success('Job triggered — task queued', { id: 'job-trigger' });
      fetchJobs();
    }
  };

  const handleDelete = async (jobId) => {
    await api.deleteCosJob(jobId).catch(err => {
      toast.error(err.message);
      return null;
    });
    toast.success('Job deleted');
    fetchJobs();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-500">
        Loading autonomous jobs...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Autonomous Jobs</h3>
          <p className="text-sm text-gray-500 mt-1">
            Recurring jobs that run on your behalf using your digital twin identity
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
                value={newJob.interval}
                onChange={e => setNewJob(j => ({ ...j, interval: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                {INTERVAL_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <input
                type="time"
                value={newJob.scheduledTime || ''}
                onChange={e => setNewJob(j => ({ ...j, scheduledTime: e.target.value || null }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                title="Run at specific time (leave empty for any time)"
              />
              <select
                value={newJob.priority}
                onChange={e => setNewJob(j => ({ ...j, priority: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                {PRIORITY_OPTIONS.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <select
                value={newJob.autonomyLevel}
                onChange={e => setNewJob(j => ({ ...j, autonomyLevel: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                {AUTONOMY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label} — {opt.desc}</option>
                ))}
              </select>
            </div>
            <textarea
              placeholder="Prompt template for the agent *"
              value={newJob.promptTemplate}
              onChange={e => setNewJob(j => ({ ...j, promptTemplate: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-32"
            />
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
          <div className="text-gray-500 mb-3">No autonomous jobs configured.</div>
          <p className="text-xs text-gray-600 max-w-md mx-auto">
            Autonomous jobs let the Chief of Staff act proactively on your behalf — maintaining repositories, processing brain ideas, and more.
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
