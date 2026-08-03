/**
 * One provider family's burn plan: the window gates that decide WHEN it burns,
 * plus the ordered job list that decides WHAT it burns on.
 *
 * The header always states whether this family would burn on the next tick and,
 * when it wouldn't, the exact reason the runner gave — the same predicate the
 * runner evaluates, so the card can't disagree with what actually happens.
 */

import { ChevronDown, ChevronRight, Flame, Plus } from 'lucide-react';
import JobRow from './JobRow';

const numberField = (id, label, value, onChange, { min, max, step, hint }) => (
  <label htmlFor={id} className="block text-xs text-gray-400">
    {label}
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      className="w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white text-xs"
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    />
    {hint && <span className="block mt-1 text-[11px] text-gray-500">{hint}</span>}
  </label>
);

export default function FamilyCard({
  familyId, config, status, catalog, expanded, actionsBusy,
  onToggleExpand, onPatch, onRunFamily, onRunJob,
}) {
  const jobs = config.jobs || [];
  // Pending counts arrive on the STATUS copy of each job (the config copy is
  // what the form edits) — match by id so a reorder mid-save can't mis-pair them.
  const withPending = jobs.map((job) => ({
    ...job,
    pending: (status?.jobs || []).find((row) => row.id === job.id)?.pending || null,
  }));

  // `pending` is a STATUS field grafted on for display below; the PUT schema is
  // strict, so it has to come back off before a job is persisted.
  const patchJobs = (next) => onPatch({ jobs: next.map(({ pending: _pending, ...job }) => job) });
  const changeJob = (index, next) => patchJobs(jobs.map((job, i) => (i === index ? next : job)));
  const moveJob = (index, delta) => {
    const next = [...jobs];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved);
    patchJobs(next);
  };
  const addJob = () => patchJobs([...jobs, {
    id: `job-${Date.now().toString(36)}`,
    enabled: true,
    label: '',
    jobType: catalog.jobTypes[0]?.id,
    model: null,
    providerId: null,
    params: {},
  }]);

  return (
    <div className="rounded border border-port-border bg-port-card/40">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <input
          id={`burn-family-${familyId}`}
          type="checkbox"
          checked={config.enabled}
          onChange={(event) => onPatch({ enabled: event.target.checked })}
        />
        <label htmlFor={`burn-family-${familyId}`} className="text-sm font-medium capitalize text-white">
          {status?.label || familyId}
        </label>

        {status?.willBurn ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
            <Flame size={13} />
            {status.percentRemaining}% left · resets in {status.hoursUntilReset}h · {status.dispatchesUsed}/{config.maxDispatchesPerWindow} used
          </span>
        ) : (
          <span className="text-xs text-gray-500">{status?.skipReason || 'not evaluated yet'}</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="text-xs text-port-accent hover:underline disabled:opacity-40"
            disabled={actionsBusy || !status?.willBurn}
            onClick={() => onRunFamily(familyId)}
            title={status?.willBurn ? 'Run this family\'s next job now' : 'This family has no burnable window right now'}
          >
            Burn now
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white"
            onClick={() => onToggleExpand(familyId)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? 'Hide' : 'Configure'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-port-border/60 p-3 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {numberField(`burn-${familyId}-window`, 'Burn within (hours of reset)', config.resetWithinHours, (v) => onPatch({ resetWithinHours: v }), { min: 0, max: 168, hint: 'Only spend as the window is about to expire.' })}
            {numberField(`burn-${familyId}-reserve`, 'Reserve (%)', config.reservePercent, (v) => onPatch({ reservePercent: v }), { min: 0, max: 100, hint: 'Never spend below this much headroom.' })}
            {numberField(`burn-${familyId}-cap`, 'Dispatch cap per window', config.maxDispatchesPerWindow, (v) => onPatch({ maxDispatchesPerWindow: v }), { min: 1, max: 50, hint: 'Max automatic burns per reset window.' })}
            {numberField(`burn-${familyId}-priority`, 'Priority', config.priority, (v) => onPatch({ priority: v }), { min: 0, max: 100, hint: 'Lower wins when two windows reset together.' })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label htmlFor={`burn-${familyId}-provider`} className="block text-xs text-gray-400">
              Provider ID (optional)
              <input
                id={`burn-${familyId}-provider`}
                className="w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white text-xs"
                value={config.providerId || ''}
                placeholder="auto-match by family"
                onChange={(event) => onPatch({ providerId: event.target.value || null })}
              />
            </label>
            <label htmlFor={`burn-${familyId}-scope`} className="block text-xs text-gray-400">
              Window scope (optional)
              <input
                id={`burn-${familyId}-scope`}
                className="w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white text-xs"
                value={config.scope || ''}
                placeholder="e.g. week — blank watches every window"
                onChange={(event) => onPatch({ scope: event.target.value || null })}
              />
            </label>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-wide text-gray-400">Burn plan — runs in order</h3>
              <button type="button" className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline" onClick={addJob}>
                <Plus size={13} /> Add job
              </button>
            </div>
            {!withPending.length && (
              <p className="text-xs text-gray-500">No jobs yet — this family will never burn until one is added.</p>
            )}
            {withPending.map((job, index) => (
              <JobRow
                key={job.id}
                job={job}
                index={index}
                total={withPending.length}
                jobTypes={catalog.jobTypes}
                catalog={catalog}
                actionsBusy={actionsBusy}
                onChange={(next) => changeJob(index, next)}
                onMove={moveJob}
                onRemove={(i) => patchJobs(jobs.filter((_, x) => x !== i))}
                onRun={(target) => onRunJob(familyId, target)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
