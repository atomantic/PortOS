import { useState, useEffect } from 'react';
import { AlertTriangle, Play, ChevronDown, ChevronUp, Clock, ToggleLeft, ToggleRight, Edit3 } from 'lucide-react';
import toast from '../ui/Toast';
import { acknowledgeCosJobIncident } from '../../services/apiAgents.js';
import { timeAgo, timeUntil } from '../../utils/formatters';
import { describeCron, describeRecurrence, JOB_INTERVAL_OPTIONS as INTERVAL_OPTIONS } from '../../utils/cronHelpers';
import { triggerButtonClass } from './tabs/schedule/scheduleConstants';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import { useSingleFlight } from '../../hooks/useSingleFlight';
import JobEditForm from './JobEditForm';
import JobDetailsPanel from './JobDetailsPanel';
import { isAgentJobType, isOnDemandSchedule } from './jobCardConfig';
import { JobFormValueInputs, missingRequiredJobFormFields } from './JobFormFields';

export { JOB_TYPE_OPTIONS, isAgentJobType, isOnDemandSchedule, normalizeJobPayload } from './jobCardConfig';
export { TaskMetadataFields } from './JobEditForm';

// Footer actions beside Run now — same shape, quieter than the accent trigger.
const SECONDARY_ACTION_CLASS = 'flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 text-sm rounded text-gray-300 hover:text-white hover:bg-port-border/50 transition-colors';

// null reads as the epoch to Date, so it must be excluded before the finite check.
const hasNextRunAt = (job) => job.nextRunAt != null && Number.isFinite(new Date(job.nextRunAt).getTime());

function formatNextDue(job) {
  // Cron jobs: show human-readable schedule (server computes exact next fire time)
  if (job.cronSchedule) return describeRecurrence(job.cronSchedule);
  if (job.cronExpression) return describeCron(job.cronExpression);
  // No recurrence — rendering lastRun + a null intervalMs would print 'Invalid Date'.
  if (isOnDemandSchedule(job)) return 'On demand';

  // Interval jobs: the server projects the exact fire time (user timezone, DST,
  // weekdaysOnly), so the card never re-derives it in the browser's zone. That
  // holds for a never-run job too: a new daily clock job waits for its next slot.
  if (hasNextRunAt(job)) return timeUntil(job.nextRunAt, 'Now');
  const { lastRun, scheduledTime } = job;
  if (!lastRun) return scheduledTime ? `at ${scheduledTime}` : 'Immediately';
  return 'Unknown';
}

function getJobTypeLabel(job) {
  if (job.type === 'shell') return 'Shell';
  if (job.type === 'script') return 'Script';
  return 'AI';
}

function JobIncident({ job, onUpdate }) {
  const incident = job.openIncident;
  const [acknowledge, acknowledging] = useAsyncAction(async id => acknowledgeCosJobIncident(id, { silent: true }));
  const handleAcknowledge = useSingleFlight(async () => {
    const result = await acknowledge(incident.id);
    if (!result) return;
    toast.success('Incident acknowledged');
    onUpdate();
  });

  if (!incident) return null;
  return (
    <div className="flex items-center gap-2 text-xs mt-1 flex-wrap" data-testid="job-incident">
      <span
        className={`flex items-center gap-1 ${incident.state === 'acknowledged' ? 'text-gray-400' : 'text-port-error'}`}
        title={incident.sampleError}
      >
        <AlertTriangle size={12} />
        {job.lastStatus === 'blocked_config' ? 'Blocked by configuration' : 'Failing'}
        {incident.occurrenceCount > 1 && ` ×${incident.occurrenceCount}`}
        {incident.state === 'acknowledged' && ' (acknowledged)'}
      </span>
      <span className="text-gray-500 truncate max-w-full" title={incident.sampleError}>{incident.sampleError}</span>
      {incident.state !== 'acknowledged' && (
        <button
          type="button"
          onClick={handleAcknowledge}
          disabled={acknowledging}
          className="min-h-[44px] px-3 py-1.5 rounded border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 transition-colors disabled:opacity-50"
        >
          Acknowledge
        </button>
      )}
    </div>
  );
}

function JobCardHeader({ job, recordLabel, apps, appConstraint, onToggle, onUpdate }) {
  const isShell = job.type === 'shell';
  const isScript = job.type === 'script';
  const appName = job.appId ? (apps.find(a => a.id === job.appId)?.name || job.appId) : null;

  const isDue = job.enabled && !isOnDemandSchedule(job)
    && (hasNextRunAt(job) ? Date.now() >= new Date(job.nextRunAt).getTime() : !job.lastRun);

  return (
    <div className="flex items-start gap-3 p-4">
      <button
        type="button"
        onClick={() => onToggle(job.id)}
        aria-pressed={Boolean(job.enabled)}
        className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 transition-colors ${job.enabled ? 'text-port-success' : 'text-gray-600'}`}
        title={job.enabled ? 'Disable job' : 'Enable job'}
        aria-label={`Enable job ${recordLabel}`}
      >
        {job.enabled ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-white font-medium truncate">{job.name}</span>
          {!job.enabled && <span className="px-1.5 py-0.5 bg-port-bg text-port-text-muted text-xs rounded">Disabled</span>}
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
          {!appConstraint && appName && (
            <span className="px-1.5 py-0.5 bg-port-accent/15 text-port-accent text-xs rounded" title={`Scoped to app: ${appName}`}>
              {appName}
            </span>
          )}
        </div>
        {job.description?.trim() && (
          <p className="text-xs text-gray-400 truncate mt-1" title={job.description}>{job.description}</p>
        )}
        <JobIncident job={job} onUpdate={onUpdate} />
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
  recordLabel = job.name?.trim() || job.id,
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
  // The ad-hoc dial for the next Run now. `null` = "whatever the job is saved
  // with", which is why this is a nullable override rather than a copy: a value
  // the user never touched must keep tracking the saved one, so an edit made in
  // the drawer (or another surface) is picked up instead of pinned to whatever
  // the card happened to mount with.
  const [runValues, setRunValues] = useState(null);
  const deleteConfirmation = useConfirmDelete();
  const appConstraint = typeof fixedAppId === 'string' && fixedAppId.length > 0 ? fixedAppId : null;
  // The job's own configuration form, rendered inline on the card so a one-off
  // run can be re-aimed without opening the editor. Shell/script jobs have no
  // prompt for the values to reach, so they never declare any.
  const runFormFields = isAgentJobType(job.type) ? (job.formFields || []) : [];
  const savedFormValues = job.formValues || {};
  // A stable signature, not the object identity: every refetch hands back a new
  // object, which would clear the dial the user is filling in on every poll.
  const savedFormValuesKey = JSON.stringify(savedFormValues);
  useEffect(() => { setRunValues(null); }, [savedFormValuesKey]);
  const runFormValues = runValues ?? savedFormValues;
  // Compare the way the server's `isSupplied` does: absent, null and blank are
  // the same answer, and a checkbox is its truthiness. An input the job has no
  // stored value for is seeded with a blank, so a raw `!==` would read toggling
  // one on and back off as a real change — shipping a value that adds a prompt
  // line the run-as-saved prompt does not have, for an edit the user undid.
  const sameAsSaved = (a, b) => a === b
    || (typeof a === 'boolean' || typeof b === 'boolean'
      ? Boolean(a) === Boolean(b)
      : String(a ?? '').trim() === String(b ?? '').trim());
  const changedRunKeys = runValues === null
    ? []
    : Object.keys(runValues).filter(key => !sameAsSaved(runValues[key], savedFormValues[key]));
  const runValuesDirty = changedRunKeys.length > 0;
  const runDisabled = editing || triggering;

  const handleTrigger = () => {
    // The API accepts a half-filled configuration on purpose (a job is saved
    // before it is aimed), so "required" is only real where it is collected —
    // here, the same gate the save path applies.
    const missing = missingRequiredJobFormFields(runFormFields, runFormValues);
    if (missing.length) {
      toast.error(`Fill in ${missing.map(field => field.label || field.key).join(', ')}`);
      return;
    }
    // Send ONLY the fields this card actually changed, and let the server's
    // merge supply the rest from the job it just read. Transmitting the whole
    // snapshot instead would push this card's copy of the UNTOUCHED fields over
    // the stored ones, silently reverting — for that run — anything edited from
    // another surface since this card rendered. An empty projection means "run
    // as saved". Always an options object, so a caller can forward it to the API
    // wrapper unconditionally.
    onTrigger(job.id, runValuesDirty
      ? { formValues: Object.fromEntries(changedRunKeys.map(key => [key, runValues[key]])) }
      : {});
  };

  const startEditing = () => {
    setEditing(true);
    setExpanded(true);
  };

  return (
    <div role="group" aria-label={`Job ${recordLabel}`} className={`flex flex-col bg-port-card border rounded-lg transition-colors ${
      job.enabled ? 'border-port-border' : 'border-port-border/50'
    }`}>
      <JobCardHeader job={job} recordLabel={recordLabel} apps={apps} appConstraint={appConstraint} onToggle={onToggle} onUpdate={onUpdate} />

      {/* Ad-hoc run configuration — the inputs the job declares, right on the
          card, so an on-demand run can be re-aimed without opening the editor.
          Hidden while editing: the edit form renders the same fields as the
          SAVED values, and two live copies of one form is a merge nobody wins. */}
      {runFormFields.length > 0 && !editing && (
        <div className="border-t border-port-border px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500 uppercase tracking-wider">Run configuration</span>
            {runValuesDirty && (
              <button
                type="button"
                onClick={() => setRunValues(null)}
                className="text-xs text-gray-500 hover:text-white transition-colors"
              >
                Reset to saved
              </button>
            )}
          </div>
          <JobFormValueInputs
            fields={runFormFields}
            values={runFormValues}
            onChange={setRunValues}
            title={null}
          />
          <p className="text-xs text-gray-500">
            {runValuesDirty
              ? 'Run now uses these values until you reset them — the saved task is unchanged.'
              : 'Change these and press Run now for a one-off run; Edit changes what the task is saved with.'}
          </p>
        </div>
      )}

      {expanded && (
        <div className="border-t border-port-border p-4 space-y-3">
          {editing ? (
            <JobEditForm
              job={job}
              apps={apps}
              providers={providers}
              activeProviderId={activeProviderId}
              timezone={timezone}
              validateEdit={validateEdit}
              fixedAppId={appConstraint}
              fixedType={fixedType}
              showTaskMetadata={showTaskMetadata}
              dataInputCatalog={dataInputCatalog}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                onUpdate();
              }}
            />
          ) : (
            <JobDetailsPanel
              job={job}
              recordLabel={recordLabel}
              providers={providers}
              onDelete={onDelete}
              deleteConfirmation={deleteConfirmation}
            />
          )}
        </div>
      )}

      {/* Footer actions — labeled, on their own row, so a job card reads like
          the scheduled-task cards it sits beside rather than a list row with
          three unlabeled glyphs. `mt-auto` keeps the row on the bottom edge
          when cards of unequal height share a grid row. */}
      <div className="flex items-center gap-2 mt-auto px-4 py-2.5 border-t border-port-border">
        {/* No aria-label on this one: it has visible text, and an aria-label would
            override it — leaving a speech-input user unable to activate "Run now"
            by saying what is written on it. Why it's disabled stays in the title. */}
        <button
          type="button"
          onClick={handleTrigger}
          disabled={runDisabled}
          className={triggerButtonClass(runDisabled)}
          title={editing ? 'Save changes before running job' : triggering ? 'Triggering job' : 'Run now'}
        >
          <Play size={14} />
          {triggering ? 'Sending…' : 'Run now'}
        </button>
        <button
          type="button"
          onClick={startEditing}
          disabled={editing}
          className={`${SECONDARY_ACTION_CLASS} disabled:opacity-50`}
          title="Edit"
          aria-label="Edit"
        >
          <Edit3 size={14} />
          Edit
        </button>
        {/* Hidden while editing: collapsing the card would take the edit form's
            own Cancel/Save away without leaving edit mode, stranding the card
            with its run panel hidden and Run now dead for a reason only a hover
            tooltip explains — which a touch user never sees. */}
        {!editing && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className={`ml-auto ${SECONDARY_ACTION_CLASS}`}
            title={expanded ? 'Hide details' : 'Details'}
            aria-label={expanded ? 'Hide details' : 'Details'}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {expanded ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
    </div>
  );
}
