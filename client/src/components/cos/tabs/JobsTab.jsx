import { cardRecordLabels } from '../cardRecordLabels';
import { sortByLabel } from '../../../lib/sortByLabel.js';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import toast from '../../ui/Toast';
import { getApps } from '../../../services/apiApps.js';
import { getCosJobs, createCosJob, toggleCosJob, triggerCosJob, deleteCosJob } from '../../../services/apiAgents.js';
import { getProviders } from '../../../services/apiProviders.js';
import { formatCount, formatDateTime } from '../../../utils/formatters';
import AgentJobProviderFields, { hasRunnableAgentProvider } from '../AgentJobProviderFields';
import { filterRunnableProviders } from '../../../utils/providers';
import FormField from '../../ui/FormField';
import JobCard, {
  JOB_TYPE_OPTIONS,
  isAgentJobType,
  normalizeJobPayload
} from '../JobCard';
import { ScheduleFields } from '../JobScheduleFields';
import useUserTimezone from '../../../hooks/useUserTimezone.js';
import TaskDataInputs from '../TaskDataInputs';
import ListLoadError from '../../ui/ListLoadError';
import useListResource from '../../../hooks/useListResource';
import { useSocketSubscription } from '../../../hooks/useSocketSubscription';
import socket from '../../../services/socket';
import { useSingleFlight } from '../../../hooks/useSingleFlight';

const fetchApps = () => getApps({ silent: true }).then(data => data?.apps || data || []);

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
  scheduleAnchor: null,
  weekdaysOnly: false,
  cronExpression: '',
  cronSchedule: null,
  priority: 'MEDIUM',
  autonomyLevel: 'manager',
  promptTemplate: '',
  command: '',
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
  // The job whose trigger is in flight, so its card can disable Run now.
  const [triggering, setTriggering] = useState(null);
  const { items: apps, state: appsState, error: appsError, retry: retryApps } = useListResource(fetchApps);
  const [rawProviders, setRawProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [jobsError, setJobsError] = useState(null);
  const jobsRequest = useRef(0);
  const [showCreate, setShowCreate] = useState(false);
  const [newJob, setNewJob] = useState(INITIAL_JOB);
  const [dataInputCatalog, setDataInputCatalog] = useState([]);

  const fetchJobs = useCallback(async () => {
    const request = ++jobsRequest.current;
    await getCosJobs({ silent: true })
      .then((data) => {
        if (request !== jobsRequest.current) return;
        setJobs(data.jobs || []);
        setStats(data.stats || null);
        setDataInputCatalog(data.dataInputCatalog || []);
        setJobsError(null);
      })
      .catch((error) => { if (request === jobsRequest.current) setJobsError(error); })
      .finally(() => { if (request === jobsRequest.current) setLoading(false); });
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  // Incidents open, resolve and acknowledge server-side; refetch so the card badges stay live.
  useSocketSubscription('cos', { onResubscribe: fetchJobs });
  useEffect(() => {
    socket.on('cos:jobs:incidents-changed', fetchJobs);
    return () => socket.off('cos:jobs:incidents-changed', fetchJobs);
  }, [fetchJobs]);

  // A failed read would otherwise hide every provider picker, leaving new and
  // edited agent jobs on the default provider with no sign anything went wrong.
  const [providersError, setProvidersError] = useState(null);
  // Retry stays clickable during a read; only the newest one may write.
  const providersRequestRef = useRef(0);
  const loadProviders = useCallback(() => {
    const request = ++providersRequestRef.current;
    const current = () => request === providersRequestRef.current;
    return getProviders({ silent: true }).then(data => {
      if (!current()) return;
      setRawProviders(data?.providers || []);
      setActiveProviderId(data?.activeProvider || '');
      setProvidersError(null);
    }).catch(err => { if (current()) setProvidersError(err); });
  }, []);
  useEffect(() => { loadProviders(); }, [loadProviders]);

  const providers = useMemo(
    () => filterRunnableProviders(rawProviders, jobs.map(job => job.providerId)),
    [rawProviders, jobs]
  );

  const handleCreate = useSingleFlight(async () => {
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

    const created = await createCosJob(normalizeJobPayload(newJob), { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!created) return;
    toast.success('Job created');
    setNewJob(INITIAL_JOB);
    setShowCreate(false);
    fetchJobs();
  });

  const handleToggle = async (jobId) => {
    const result = await toggleCosJob(jobId, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result) {
      toast.success(result.job.enabled ? 'Job enabled' : 'Job disabled');
      // Merge over the listed row so the server-derived `hasGate`/`nextRunAt`
      // survive; only the enabled tally in the header stats needs adjusting.
      const delta = (result.job.enabled ? 1 : 0) - (jobs.find(job => job.id === result.job.id)?.enabled ? 1 : 0);
      setJobs(prev => prev.map(job => (job.id === result.job.id ? { ...job, ...result.job } : job)));
      setStats(prev => prev && { ...prev, enabled: Math.max(0, (prev.enabled || 0) + delta) });
    }
  };

  // `runOptions` carries the card's ad-hoc run configuration, when the job
  // declares one — the values apply to this run only and are not saved.
  const handleTrigger = async (jobId, runOptions) => {
    const toastId = toast.loading('Triggering job...');
    // Held so the card can disable its own button while its trigger is pending.
    setTriggering(jobId);
    try {
      const result = await triggerCosJob(jobId, { ...runOptions, silent: true });
      const message = result.type === 'shell' || result.type === 'script'
        ? 'Job executed successfully'
        : result.started ? 'Job started — agent launching' : 'Job triggered — task queued';
      toast.success(result.duplicate ? result.reason || 'An equivalent task is already queued' : message, { id: toastId });
      fetchJobs();
    } catch (err) {
      toast.dismiss(toastId);
      // Leave the ID unset so the shared toast layer can deduplicate socket errors.
      if (!err.toasted) toast.error(err.message);
      if (err.code === 'JOB_EXECUTION_FAILED') fetchJobs();
    } finally {
      // Another job may have been triggered while this one was in flight.
      setTriggering(prev => (prev === jobId ? null : prev));
    }
  };

  const handleDelete = async (jobId) => {
    const result = await deleteCosJob(jobId, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Job deleted');
    const removed = jobs.find(job => job.id === jobId);
    setJobs(prev => prev.filter(job => job.id !== jobId));
    setStats(prev => prev && {
      ...prev,
      total: Math.max(0, (prev.total || 0) - 1),
      enabled: Math.max(0, (prev.enabled || 0) - (removed?.enabled ? 1 : 0)),
    });
  };

  const jobLabels = cardRecordLabels(jobs.map(job => [job.id, job.name?.trim() || job.id]));

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
          <h2 className="text-lg font-semibold text-white">System Tasks</h2>
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
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-white transition-colors"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {stats && (
        <div className="flex gap-4 text-xs text-gray-500">
          <span>{formatCount(stats.enabled)} enabled / {formatCount(stats.total)} total</span>
          <span>{formatCount(stats.totalRuns)} total runs</span>
          {stats.nextDue && (
            <span className={stats.nextDue.isDue ? 'text-port-warning' : ''}>
              Next: {stats.nextDue.jobName} ({stats.nextDue.isDue ? 'due now' : formatDateTime(stats.nextDue.nextDueAt)})
            </span>
          )}
        </div>
      )}

      {appsState === 'error' && (
        <ListLoadError what="apps for the job scope pickers" error={appsError} onRetry={retryApps} />
      )}
      {providersError && (
        <ListLoadError what="AI providers for the job provider pickers" error={providersError} onRetry={loadProviders} />
      )}

      {showCreate && (
        <div className="bg-port-card border border-port-accent/50 rounded-lg p-4">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <FormField label="Job name *" className="w-full sm:flex-1" labelClassName="block text-xs text-gray-400 mb-1">
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
              <FormField label="Category" className="min-w-0 flex-1 sm:flex-none" labelClassName="block text-xs text-gray-400 mb-1">
                <input
                  type="text"
                  value={newJob.category}
                  onChange={e => setNewJob(j => ({ ...j, category: e.target.value }))}
                  className="w-full sm:w-40 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
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
            <ScheduleFields data={newJob} timezone={timezone} onChange={(key, val) => setNewJob(j => ({ ...j, [key]: val }))} />
            {isAgentJobType(newJob.type) && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">App scope:</span>
                <select
                  aria-label="App scope"
                  value={newJob.appId || ''}
                  onChange={e => setNewJob(j => ({ ...j, appId: e.target.value }))}
                  disabled={appsState === 'error'}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  <option value="">Global (PortOS)</option>
                  {sortByLabel(apps).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
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
                <span className="text-xs text-gray-500">Output and exit code are logged on the job card.</span>
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

      {jobsError && <ListLoadError what="system tasks" error={jobsError} onRetry={fetchJobs} />}
      {jobs.length === 0 ? !jobsError && (
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
              fixedAppId={job.portosOnly ? job.appId : undefined}
              fixedType={job.portosOnly ? 'agent' : undefined}
              key={job.id}
              job={job}
              recordLabel={jobLabels.get(job.id)}
              apps={apps}
              providers={providers}
              activeProviderId={activeProviderId}
              timezone={timezone}
              dataInputCatalog={dataInputCatalog}
              onToggle={handleToggle}
              onTrigger={handleTrigger}
              triggering={triggering === job.id}
              onDelete={handleDelete}
              onUpdate={fetchJobs}
            />
          ))}
        </div>
      )}
    </div>
  );
}
