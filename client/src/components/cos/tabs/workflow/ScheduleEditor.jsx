import { useEffect, useMemo, useState } from 'react';
import { Bot, GitBranch, Loader2, Plus, Save, X } from 'lucide-react';
import toast from '../../../ui/Toast';
import * as api from '../../../../services/api';
import { DEFAULT_CRON, buildCronFromRecurrence, parseCronToRecurrence } from '../../../../utils/cronHelpers';
import CronSchedulePicker from '../../../CronSchedulePicker';
import { PERPETUAL_DESCRIPTION, ON_DEMAND_PERPETUAL_LABEL, ON_DEMAND_PERPETUAL_DESCRIPTION } from '../schedule/scheduleConstants';

const TASK_MODES = [
  ['on-demand', 'On Demand'],
  ['cron', 'Scheduled']
];

const JOB_INTERVALS = [
  ['hourly', 'Every hour'],
  ['every-2-hours', 'Every 2 hours'],
  ['every-4-hours', 'Every 4 hours'],
  ['every-8-hours', 'Every 8 hours'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['biweekly', 'Every 2 weeks'],
  ['monthly', 'Monthly']
];

export default function ScheduleEditor({ node, allNodes, timezone, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const schedule = node?.schedule || {};

  useEffect(() => {
    if (!node) {
      setForm(null);
      return;
    }
    setForm({
      enabled: node.enabled,
      mode: node.kind === 'job' ? (schedule.cronSchedule || schedule.cronExpression ? 'cron' : 'interval') : schedule.type,
      cronExpression: schedule.cronExpression || '',
      cronSchedule: schedule.cronSchedule || (schedule.cronExpression ? parseCronToRecurrence(schedule.cronExpression) : null),
      // Empty means "no recheck cron": the task keeps its interval-based
      // recheck cadence (recheckIntervalMs, default daily). Prefilling a cron
      // here would silently override that cadence on any unrelated save,
      // because recheckCron takes precedence over recheckIntervalMs.
      recheckCron: schedule.recheckCron || '',
      perpetual: !!schedule.perpetual,
      autoStart: schedule.autoStart ?? !!schedule.perpetual,
      interval: node.kind === 'job' ? (schedule.type || 'daily') : 'daily',
      scheduledTime: schedule.scheduledTime || '',
      weekdaysOnly: !!schedule.weekdaysOnly,
      runAfter: [...(node.runAfter || [])]
    });
  }, [node, schedule.autoStart, schedule.cronExpression, schedule.cronSchedule, schedule.perpetual, schedule.recheckCron, schedule.scheduledTime, schedule.type, schedule.weekdaysOnly]);

  const dependencyOptions = useMemo(() => {
    if (!node) return [];
    return allNodes
      .filter(candidate => candidate.kind === 'task' && candidate.id !== node.id && !form?.runAfter.includes(candidate.id.slice(5)))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allNodes, form?.runAfter, node]);

  if (!node || !form) {
    return (
      <aside className="rounded-lg border border-port-border/60 bg-port-card/40 p-5 text-center text-sm text-gray-500">
        Select a track or a launch marker to edit its schedule here.
      </aside>
    );
  }

  const Icon = node.kind === 'job' ? Bot : GitBranch;
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  // Switching to cron seeds the expression with the picker's displayed default
  // (07:00 daily) so the visible schedule is actually saveable instead of
  // failing validation on an empty cronExpression.
  const setMode = (mode) => setForm(current => ({
    ...current,
    mode,
    autoStart: mode === 'on-demand' ? false : current.autoStart,
    cronExpression: mode === 'cron' && !current.cronExpression ? DEFAULT_CRON : current.cronExpression
  }));
  const validateCron = (value) => String(value || '').trim().split(/\s+/).length === 5;

  const handleSave = async () => {
    const hasValidJobRecurrence = node.kind === 'job' && form.cronSchedule;
    if (form.mode === 'cron' && !hasValidJobRecurrence && !validateCron(form.cronExpression)) {
      toast.error('Cron schedules need five fields');
      return;
    }
    if (node.kind === 'task' && form.perpetual && form.autoStart && form.mode === 'on-demand' && form.recheckCron && !validateCron(form.recheckCron)) {
      toast.error('The perpetual recheck schedule needs five fields');
      return;
    }

    setSaving(true);
    let result;
    if (node.kind === 'task') {
      const payload = {
        enabled: form.enabled,
        type: form.mode,
        cronExpression: form.mode === 'cron' ? String(form.cronExpression || '').trim() || null : null,
        perpetual: form.perpetual,
        autoStart: form.autoStart,
        recheckCron: form.recheckCron.trim() || null,
        runAfter: form.runAfter
      };
      result = await api.updateCosTaskInterval(node.id.slice(5), payload, { silent: true }).catch(error => {
        toast.error(error.message);
        return null;
      });
    } else {
      const payload = {
        enabled: form.enabled,
        weekdaysOnly: form.weekdaysOnly,
        cronExpression: form.mode === 'cron' ? (buildCronFromRecurrence(form.cronSchedule) || String(form.cronExpression || '').trim() || null) : null,
        cronSchedule: form.mode === 'cron' ? form.cronSchedule : null,
        scheduledTime: form.mode === 'interval' ? (form.scheduledTime || null) : null
      };
      if (form.mode === 'interval') payload.interval = form.interval;
      result = await api.updateCosJob(node.id.slice(4), payload, { silent: true }).catch(error => {
        toast.error(error.message);
        return null;
      });
    }

    setSaving(false);
    if (result?.success) {
      toast.success(`Updated ${node.label}`);
      onSaved();
    }
  };

  const addDependency = (event) => {
    const value = event.target.value;
    if (value) set('runAfter', [...form.runAfter, value]);
    event.target.value = '';
  };

  return (
    <aside className="rounded-lg border border-port-border bg-port-card/70 shadow-xl 2xl:sticky 2xl:top-4">
      <div className="flex items-start justify-between gap-3 border-b border-port-border/60 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-gray-500">
            <Icon className="h-3.5 w-3.5" />
            {node.kind === 'job' ? 'System job' : 'Task type'}
          </div>
          <h3 className="mt-1 truncate font-semibold text-white" title={node.label}>{node.label}</h3>
          <p className="mt-1 text-xs text-gray-500">Times use {timezone || 'the configured timezone'}.</p>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-port-border hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Close schedule editor">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 p-4">
        <label className="flex items-center justify-between gap-3 text-sm text-gray-300">
          Active
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={event => set('enabled', event.target.checked)}
            className="h-4 w-4 accent-port-accent"
          />
        </label>

        {node.kind === 'task' ? (
          <label htmlFor="workflow-task-cadence" className="block text-xs text-gray-400">
            Scheduling behavior
            <select id="workflow-task-cadence" value={form.mode} onChange={event => setMode(event.target.value)} className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white">
              {TASK_MODES.map(([value, label]) => <option key={value} value={value}>{value === 'on-demand' && form.perpetual && form.autoStart ? ON_DEMAND_PERPETUAL_LABEL : label}</option>)}
            </select>
          </label>
        ) : (
          <div>
            <span className="block text-xs text-gray-400">Scheduling behavior</span>
            <div className="mt-1.5 grid grid-cols-2 rounded border border-port-border bg-port-bg p-1">
              {['cron', 'interval'].map(mode => (
                <button key={mode} type="button" onClick={() => setMode(mode)} className={`rounded px-2 py-1.5 text-xs capitalize ${form.mode === mode ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-gray-300'}`}>
                  {mode === 'cron' ? 'Pinned time' : 'Interval'}
                </button>
              ))}
            </div>
          </div>
        )}

        {node.kind === 'task' && form.mode === 'on-demand' && form.perpetual && form.autoStart && (
          <p className="text-xs text-gray-400">{ON_DEMAND_PERPETUAL_DESCRIPTION}</p>
        )}

        {form.mode === 'cron' && (
          <div className="space-y-2">
            <span className="block text-xs text-gray-400">Run on</span>
            <CronSchedulePicker
              value={node.kind === 'job' ? (form.cronSchedule || form.cronExpression) : form.cronExpression}
              valueShape={node.kind === 'job' ? 'recurrence' : 'cron'}
              timezone={node.kind === 'job' ? timezone : undefined}
              onChange={value => {
                if (node.kind === 'job') {
                  set('cronSchedule', value);
                  set('cronExpression', buildCronFromRecurrence(value) || null);
                } else {
                  set('cronExpression', value);
                }
              }}
            />
            {node.kind === 'job' && <p className="text-[11px] text-gray-600">No days selected runs every day.</p>}
          </div>
        )}

        {node.kind === 'task' && (
          <label htmlFor="workflow-task-perpetual" className="flex items-center justify-between gap-3 text-sm text-gray-300">
            <span>
              <span className="block">Perpetual</span>
              <span className="mt-0.5 block text-[11px] text-gray-500">{PERPETUAL_DESCRIPTION}</span>
            </span>
            <input
              id="workflow-task-perpetual"
              type="checkbox"
              checked={form.perpetual}
              onChange={event => set('perpetual', event.target.checked)}
              className="h-4 w-4 shrink-0 accent-port-accent"
            />
          </label>
        )}

        {node.kind === 'task' && form.perpetual && form.mode === 'on-demand' && (
          <label className="flex items-center justify-between gap-3 text-sm text-gray-300">
            Automatic starts and rechecks
            <input type="checkbox" checked={form.autoStart} onChange={event => set('autoStart', event.target.checked)} />
          </label>
        )}
        {node.kind === 'task' && form.perpetual && !form.autoStart && form.mode === 'on-demand' && (
          <p className="text-xs text-gray-400">Run Now starts a drain until no actionable work remains. No timer starts or resumes it.</p>
        )}

        {node.kind === 'task' && form.perpetual && form.autoStart && form.mode === 'on-demand' && (
          <div className="space-y-2 rounded border border-port-warning/20 bg-port-warning/5 p-3">
            <p className="text-xs text-gray-400">
              Drains work back-to-back. Once parked, this is its reset/recheck time — leave blank to keep the default interval-based recheck cadence.
            </p>
            <CronSchedulePicker value={form.recheckCron} onChange={value => set('recheckCron', value)} />
          </div>
        )}

        {node.kind === 'job' && form.mode === 'interval' && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-gray-400">
              Frequency
              <select value={form.interval} onChange={event => set('interval', event.target.value)} className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-2 py-2 text-sm text-white">
                {JOB_INTERVALS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="block text-xs text-gray-400">
              Start time
              <input type="time" value={form.scheduledTime} onChange={event => set('scheduledTime', event.target.value)} className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-2 py-2 text-sm text-white" />
            </label>
          </div>
        )}

        {node.kind === 'job' && form.mode === 'interval' && (
          <label className="flex items-center justify-between gap-3 text-xs text-gray-400">
            Weekdays only
            <input type="checkbox" checked={form.weekdaysOnly} onChange={event => set('weekdaysOnly', event.target.checked)} className="h-4 w-4 accent-port-accent" />
          </label>
        )}

        {node.kind === 'task' && (
          <div>
            <span className="block text-xs text-gray-400">Hard dependencies</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {form.runAfter.map(dependency => (
                <button key={dependency} type="button" onClick={() => set('runAfter', form.runAfter.filter(value => value !== dependency))} className="inline-flex items-center gap-1 rounded-full border border-port-border bg-port-bg px-2 py-1 text-[11px] text-gray-300 hover:border-port-error/50 hover:text-port-error" title="Remove dependency">
                  {dependency}<X className="h-3 w-3" />
                </button>
              ))}
              {form.runAfter.length === 0 && <span className="text-xs text-gray-600">None</span>}
            </div>
            {dependencyOptions.length > 0 && (
              <label className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                <Plus className="h-3.5 w-3.5" />
                <select defaultValue="" onChange={addDependency} className="min-w-0 flex-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs text-gray-300">
                  <option value="">Add dependency…</option>
                  {dependencyOptions.map(option => <option key={option.id} value={option.id.slice(5)}>{option.label}</option>)}
                </select>
              </label>
            )}
          </div>
        )}

        <button type="button" onClick={handleSave} disabled={saving} className="flex w-full items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm font-medium text-white hover:bg-port-accent/80 disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save schedule
        </button>
      </div>
    </aside>
  );
}
