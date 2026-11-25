import { useMemo, useState } from 'react';
import { Bot, GitBranch, Loader2, Save, X } from 'lucide-react';
import toast from '../../../ui/Toast';
import { updateCosTaskInterval, updateCosJob } from '../../../../services/apiAgents.js';
import { findCronExpressionError, parseCronToRecurrence } from '../../../../utils/cronHelpers';
import { ScheduleFields, normalizeJobSchedule } from '../../JobScheduleFields';
import TaskCadenceFields from '../schedule/TaskCadenceFields';
import TaskDependencyPicker from '../schedule/TaskDependencyPicker';
import TaskEnabledToggle from '../schedule/TaskEnabledToggle';
import TaskPerpetualFields from '../schedule/TaskPerpetualFields';
import useTaskScheduleEdit from '../schedule/useTaskScheduleEdit';

const TASK_NODE_PREFIX = 'task:';
const JOB_NODE_PREFIX = 'job:';

// A task node carries the same schedule fields as the Schedule drawer's `config`,
// so the drawer's field components render it unchanged.
function taskConfigFromNode(node) {
  const schedule = node.schedule || {};
  return {
    enabled: node.enabled,
    type: schedule.type,
    cronExpression: schedule.cronExpression,
    perpetual: !!schedule.perpetual,
    autoStart: schedule.autoStart,
    recheckCron: schedule.recheckCron,
    runAfter: node.runAfter || [],
  };
}

function jobFormFromNode(node) {
  const schedule = node.schedule || {};
  const isCron = !!(schedule.cronSchedule || schedule.cronExpression);
  return {
    scheduleMode: isCron ? 'cron' : 'interval',
    interval: schedule.type || 'daily',
    scheduledTime: schedule.scheduledTime || '',
    scheduleAnchor: schedule.scheduleAnchor ?? null,
    weekdaysOnly: !!schedule.weekdaysOnly,
    cronExpression: schedule.cronExpression || '',
    cronSchedule: schedule.cronSchedule || (schedule.cronExpression ? parseCronToRecurrence(schedule.cronExpression) : null),
  };
}

// Task schedules save one field at a time, exactly as the Schedule drawer does.
function TaskScheduleForm({ node, allNodes, onSaved }) {
  const taskType = node.id.slice(TASK_NODE_PREFIX.length);
  const [updating, setUpdating] = useState(false);
  const config = useMemo(() => taskConfigFromNode(node), [node]);
  const allTaskTypes = useMemo(
    () => allNodes.filter(candidate => candidate.kind === 'task').map(candidate => candidate.id.slice(TASK_NODE_PREFIX.length)),
    [allNodes]
  );

  const runUpdate = async (patch) => {
    setUpdating(true);
    try {
      const result = await updateCosTaskInterval(taskType, patch, { silent: true }).catch(error => {
        toast.error(error.message);
        return null;
      });
      if (!result?.success) return false;
      toast.success(`Updated ${node.label}`);
      onSaved();
      return true;
    } finally {
      setUpdating(false);
    }
  };
  const edit = useTaskScheduleEdit({ config, runUpdate });

  return (
    <div className="space-y-4 p-4">
      <TaskEnabledToggle edit={edit} updating={updating} />
      <TaskCadenceFields config={config} edit={edit} updating={updating} />
      <TaskPerpetualFields config={config} edit={edit} updating={updating} />
      {allTaskTypes.length > 1 && (
        <TaskDependencyPicker
          label="Run After (enforced dependencies)"
          hint="This task waits for the selected tasks to complete first within the same cycle."
          taskType={taskType}
          options={allTaskTypes}
          value={config.runAfter}
          disabled={updating}
          onChange={(next) => runUpdate({ runAfter: next.length > 0 ? next : null })}
        />
      )}
    </div>
  );
}

// System jobs keep an explicit Save, like the job card.
function JobScheduleForm({ node, timezone, onSaved }) {
  const [form, setForm] = useState(() => jobFormFromNode(node));
  const [enabled, setEnabled] = useState(!!node.enabled);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (form.scheduleMode === 'cron' && !form.cronSchedule) {
      const cronError = findCronExpressionError(String(form.cronExpression || '').trim());
      if (cronError) {
        toast.error(cronError);
        return;
      }
    }
    setSaving(true);
    const result = await updateCosJob(node.id.slice(JOB_NODE_PREFIX.length), { enabled, ...normalizeJobSchedule(form) }, { silent: true }).catch(error => {
      toast.error(error.message);
      return null;
    });
    setSaving(false);
    if (result?.success) {
      toast.success(`Updated ${node.label}`);
      onSaved();
    }
  };

  return (
    <div className="space-y-4 p-4">
      <label className="flex items-center justify-between gap-3 text-sm text-gray-300">
        Active
        <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} className="h-4 w-4 accent-port-accent" />
      </label>
      <ScheduleFields data={form} timezone={timezone} onChange={(key, value) => setForm(current => ({ ...current, [key]: value }))} />
      <button type="button" onClick={handleSave} disabled={saving} className="flex w-full items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm font-medium text-white hover:bg-port-accent/80 disabled:opacity-50">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save schedule
      </button>
    </div>
  );
}

export default function ScheduleEditor({ node, allNodes, timezone, onClose, onSaved }) {
  if (!node) {
    return (
      <aside className="rounded-lg border border-port-border/60 bg-port-card/40 p-5 text-center text-sm text-gray-500">
        Select a track or a launch marker to edit its schedule here.
      </aside>
    );
  }

  const isJob = node.kind === 'job';
  const Icon = isJob ? Bot : GitBranch;

  return (
    <aside className="rounded-lg border border-port-border bg-port-card/70 shadow-xl lg:sticky lg:top-4">
      <div className="flex items-start justify-between gap-3 border-b border-port-border/60 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-gray-500">
            <Icon className="h-3.5 w-3.5" />
            {isJob ? 'System job' : 'Task type'}
          </div>
          <h3 className="mt-1 truncate font-semibold text-white" title={node.label}>{node.label}</h3>
          <p className="mt-1 text-xs text-gray-500">Times use {timezone || 'the configured timezone'}.</p>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-port-border hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Close schedule editor">
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* Keyed by node (and its schedule) so a refetch re-seeds the form fields. */}
      {isJob
        ? <JobScheduleForm key={`${node.id}:${JSON.stringify(node.schedule)}:${node.enabled}`} node={node} timezone={timezone} onSaved={onSaved} />
        : <TaskScheduleForm key={node.id} node={node} allNodes={allNodes} onSaved={onSaved} />}
    </aside>
  );
}
