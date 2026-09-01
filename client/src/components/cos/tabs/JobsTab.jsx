import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import { formatDateTime } from '../../../utils/formatters';
import AgentJobProviderFields, { hasRunnableAgentProvider } from '../AgentJobProviderFields';
import { filterRunnableProviders } from '../../../utils/providers';
import FormField from '../../ui/FormField';
import JobCard, {
  AUTONOMY_OPTIONS,
  JOB_TYPE_OPTIONS,
  isAgentJobType,
  normalizeJobPayload,
  PRIORITY_OPTIONS,
  ScheduleFields,
  SHELL_TRIGGER_ACTION_OPTIONS,
  TRIGGER_ACTION_OPTIONS
} from '../JobCard';
import useUserTimezone from '../../../hooks/useUserTimezone.js';
import TaskDataInputs from '../TaskDataInputs';

// Blank create-form state — shared by the initial useState and the post-create
// reset so the two can't drift (a field added to one but not the other would
// silently carry the previous job's value into the next).
const INITIAL_JOB = {
  name: '',
  description: '',
  category: 'custom',
  type: 'agent',
  scheduleMode: 'interval',
  interval: 'daily',
  scheduledTime: '',
  cronExpression: '',
  cronSchedule: null,
  priority: 'MEDIUM',
  autonomyLevel: 'manager',
  promptTemplate: '',
  command: '',
  triggerAction: 'log-only',
  appId: '',
  providerId: '',
  model: '',
  effort: '',
  dataInputs: [],
  enabled: false
};

export default function JobsTab() {
  const timezone = useUserTimezone();
  const [jobs, setJobs] = useState([]);
  const [apps, setApps] = useState([]);
  const [rawProviders, setRawProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newJob, setNewJob] = useState(INITIAL_JOB);
  const [dataInputCatalog, setDataInputCatalog] = useState([]);

  const fetchJobs = useCallback(async () => {
    const data = await api.getCosJobs({ silent: true }).catch(err => {
      toast.error(`Failed to load jobs: ${err.message}`);
      return null;
    });
    if (data) {
      setJobs(data.jobs || []);
      setStats(data.stats || null);
      setDataInputCatalog(data.dataInputCatalog || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  useEffect(() => {
    api.getApps().then(data => setApps(data?.apps || data || [])).catch(() => setApps([]));
  }, []);

  useEffect(() => {
    api.getProviders({ silent: true }).then(data => {
      setRawProviders(data?.providers || []);
      setActiveProviderId(data?.activeProvider || '');
    }).catch(() => {});
  }, []);

  const providers = useMemo(
    () => filterRunnableProviders(rawProviders, jobs.map(job => job.providerId)),
    [rawProviders, jobs]
  );

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
    const providerResolutionKnown = Boolean(newJob.providerId || activeProviderId || providers.length);
    if (isAgentJobType(newJob.type) && providerResolutionKnown
      && !hasRunnableAgentProvider(providers, newJob.providerId, activeProviderId)) {
      toast.error('Select a CLI/TUI provider before saving an agent job');
      return;
    }
    if (newJob.scheduleMode === 'cron' && !newJob.cronSchedule && (!newJob.cronExpression?.trim() || newJob.cronExpression.trim().split(/\s+/).length !== 5)) {
      toast.error('A valid recurrence or 5-field cron expression is required for cron scheduling');
      return;
    }

    const created = await api.createCosJob(normalizeJobPayload(newJob), { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!created) return;
    toast.success('Job created');
    setNewJob(INITIAL_JOB);
    setShowCreate(false);
    fetchJobs();
  };

  const handleToggle = async (jobId) => {
    const result = await api.toggleCosJob(jobId, { silent: true }).catch(err => {
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
    const result = await api.triggerCosJob(jobId, { silent: true }).catch(err => {
      toast.error(err.message, { id: 'job-trigger' });
      return null;
    });
    if (result) {
      if (result.status === 'skipped') {
        const notify = result.duplicate ? toast.success : toast.error;
        notify(result.reason || 'Job was not queued', { id: 'job-trigger' });
      } else if (result.success === false) {
        toast.error(result.reason || `Job failed (exit ${result.exitCode ?? '?'})`, { id: 'job-trigger' });
      } else {
        const msg = result.type === 'shell' || result.type === 'script'
          ? 'Job executed successfully'
          : result.started ? 'Job started — agent launching' : 'Job triggered — task queued';
        toast.success(msg, { id: 'job-trigger' });
      }
      fetchJobs();
    }
  };

  const handleDelete = async (jobId) => {
    const result = await api.deleteCosJob(jobId, { silent: true }).catch(err => {
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
            aria-label="Refresh jobs"
            className="text-gray-500 hover:text-white transition-colors"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {stats && (
        <div className="flex gap-4 text-xs text-gray-500">
          <span>{stats.enabled} enabled / {stats.total} total</span>
          <span>{stats.totalRuns} total runs</span>
          {stats.nextDue && (
            <span className={stats.nextDue.isDue ? 'text-port-warning' : ''}>
              Next: {stats.nextDue.jobName} ({stats.nextDue.isDue ? 'due now' : formatDateTime(stats.nextDue.nextDueAt)})
            </span>
          )}
        </div>
      )}

      {showCreate && (
        <div className="bg-port-card border border-port-accent/50 rounded-lg p-4">
          <div className="space-y-3">
            <div className="flex gap-3">
              <FormField label="Job name *" className="flex-1" labelClassName="block text-xs text-gray-400 mb-1">
                <input
                  type="text"
                  value={newJob.name}
                  onChange={e => setNewJob(j => ({ ...j, name: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                />
              </FormField>
              <FormField label="Type" labelClassName="block text-xs text-gray-400 mb-1">
                <select
                  value={newJob.type}
                  onChange={e => setNewJob(j => ({ ...j, type: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {JOB_TYPE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </FormField>
              <FormField label="Category" labelClassName="block text-xs text-gray-400 mb-1">
                <input
                  type="text"
                  value={newJob.category}
                  onChange={e => setNewJob(j => ({ ...j, category: e.target.value }))}
                  className="w-40 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                />
              </FormField>
            </div>
            <FormField
              label="Card summary"
              hint="Shown beneath the task name on its card."
              labelClassName="block text-xs text-gray-400 mb-1"
            >
              <input
                type="text"
                placeholder="One-line summary (optional)"
                value={newJob.description}
                onChange={e => setNewJob(j => ({ ...j, description: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
            </FormField>
            <div className="flex gap-3">
              <select
                aria-label="Priority"
                value={newJob.priority}
                onChange={e => setNewJob(j => ({ ...j, priority: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              {newJob.type !== 'shell' && (
                <select
                  aria-label="Autonomy level"
                  value={newJob.autonomyLevel}
                  onChange={e => setNewJob(j => ({ ...j, autonomyLevel: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {AUTONOMY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label} — {opt.desc}</option>)}
                </select>
              )}
            </div>
            <ScheduleFields data={newJob} timezone={timezone} onChange={(key, val) => setNewJob(j => ({ ...j, [key]: val }))} />
            {isAgentJobType(newJob.type) && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">App scope:</span>
                <select
                  aria-label="App scope"
                  value={newJob.appId || ''}
                  onChange={e => setNewJob(j => ({ ...j, appId: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  <option value="">Global (PortOS)</option>
                  {apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            )}
            {isAgentJobType(newJob.type) && (
              <AgentJobProviderFields
                data={newJob}
                providers={providers}
                activeProviderId={activeProviderId}
                onChange={patch => setNewJob(j => ({ ...j, ...patch }))}
              />
            )}
            {isAgentJobType(newJob.type) && (
              <TaskDataInputs
                catalog={dataInputCatalog}
                value={newJob.dataInputs}
                onChange={dataInputs => setNewJob(j => ({ ...j, dataInputs }))}
              />
            )}
            {newJob.type === 'shell' ? (
              <>
                <textarea
                  aria-label="Shell command"
                  placeholder="Shell command *"
                  value={newJob.command}
                  onChange={e => setNewJob(j => ({ ...j, command: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-20"
                />
                <select
                  aria-label="Trigger action"
                  value={newJob.triggerAction}
                  onChange={e => setNewJob(j => ({ ...j, triggerAction: e.target.value }))}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  {(newJob.type === 'shell' ? SHELL_TRIGGER_ACTION_OPTIONS : TRIGGER_ACTION_OPTIONS).map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </>
            ) : (
              <textarea
                aria-label="Prompt template"
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
              apps={apps}
              providers={providers}
              activeProviderId={activeProviderId}
              timezone={timezone}
              dataInputCatalog={dataInputCatalog}
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
