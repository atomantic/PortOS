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
import PresetPicker from './PresetPicker';
import { jobFromPreset } from '../../lib/quotaBurnPatch';
import { NumberField, TextField } from './fields';

export default function FamilyCard({
  familyId, config, status, catalog, expanded, actionsBusy,
  onToggleExpand, onPatch, onRunFamily, onRunJob,
}) {
  const jobs = config.jobs || [];
  // Pending counts stay on the STATUS side and are passed to JobRow as their own
  // prop — merging them into the job objects would mean stripping them back off
  // before every save (the PUT schema is strict). Matched by id so a reorder
  // mid-save can't mis-pair them.
  const pendingFor = (id) => (status?.jobs || []).find((row) => row.id === id)?.pending ?? null;

  const patchJobs = (next) => onPatch({ jobs: next });
  const changeJob = (index, next) => patchJobs(jobs.map((job, i) => (i === index ? next : job)));
  const moveJob = (index, delta) => {
    const next = [...jobs];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved);
    patchJobs(next);
  };
  // Without a catalog there is no job type to mint, and a job with
  // `jobType: undefined` is dropped by JSON.stringify and rejected by the
  // strict PUT schema — poisoning every later save for this family until the
  // page is reloaded. The catalog fetch is best-effort (the page still renders
  // without it), so gate on it rather than minting an unsavable row.
  const canAddJob = catalog.jobTypes.length > 0;
  // Ids key the React list AND pair each job with its server-side pending count,
  // so a duplicate is a real defect, not a cosmetic one. `Date.now()` alone can
  // repeat within the same millisecond (two adds from one handler, a preset add
  // immediately following a blank add), so disambiguate against the ids already
  // in the plan rather than trusting the clock to have ticked.
  const nextJobId = () => {
    const taken = new Set(jobs.map((job) => job.id));
    const base = `job-${Date.now().toString(36)}`;
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  };
  const addJob = () => patchJobs([...jobs, {
    id: nextJobId(),
    enabled: true,
    label: '',
    jobType: catalog.jobTypes[0].id,
    model: null,
    providerId: null,
    params: {},
  }]);
  // A preset job inherits the app the plan is already pointed at, when the plan
  // is unambiguous about it — otherwise a one-click "add a UX audit" lands as a
  // step that cannot run until the user notices the unset app picker.
  const targetedAppIds = [...new Set(jobs.map((job) => job.params?.appId).filter(Boolean))];
  const addPresetJob = (preset) => patchJobs([...jobs, jobFromPreset(preset, {
    id: nextJobId(),
    appId: targetedAppIds.length === 1 ? targetedAppIds[0] : null,
  })]);

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

        {/* A collapsed card otherwise says nothing about whether this family has
            a plan at all — and a family with zero enabled jobs can never burn,
            no matter how healthy its window looks. */}
        <span className="text-[11px] text-gray-500">
          {jobs.length
            ? `${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${jobs.filter((job) => job.enabled !== false).length} enabled`
            : 'no jobs'}
        </span>

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
            <NumberField id={`burn-${familyId}-window`} label="Burn within (hours of reset)" value={config.resetWithinHours} onChange={(v) => onPatch({ resetWithinHours: v })} min={0} max={168} hint="Only spend as the window is about to expire." />
            <NumberField id={`burn-${familyId}-reserve`} label="Reserve (%)" value={config.reservePercent} onChange={(v) => onPatch({ reservePercent: v })} min={0} max={100} hint="Never spend below this much headroom." />
            <NumberField id={`burn-${familyId}-cap`} label="Dispatch cap per window" value={config.maxDispatchesPerWindow} onChange={(v) => onPatch({ maxDispatchesPerWindow: v })} min={1} max={50} hint="Max automatic burns per reset window." />
            <NumberField id={`burn-${familyId}-priority`} label="Priority" value={config.priority} onChange={(v) => onPatch({ priority: v })} min={0} max={100} hint="Lower wins when two windows reset together." />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TextField id={`burn-${familyId}-provider`} label="Provider ID (optional)" value={config.providerId} onChange={(v) => onPatch({ providerId: v })} placeholder="auto-match by family" />
            <TextField id={`burn-${familyId}-scope`} label="Window scope (optional)" value={config.scope} onChange={(v) => onPatch({ scope: v })} placeholder="e.g. week — blank watches every window" />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-wide text-gray-400">Burn plan — runs in order</h3>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-40"
                disabled={!canAddJob}
                title={canAddJob ? 'Add a job to this plan' : 'Job catalog unavailable — reload the page'}
                onClick={addJob}
              >
                <Plus size={13} /> Add job
              </button>
            </div>
            <div className="sm:max-w-md">
              <PresetPicker
                id={`burn-${familyId}-preset`}
                label="Add a preset job"
                presets={catalog.presets}
                onPick={addPresetJob}
                hint="Single-focus audits that read the code, file GitHub issues, and change nothing — safe work for an unattended window."
              />
            </div>
            {!jobs.length && (
              <p className="text-xs text-gray-500">No jobs yet — this family will never burn until one is added.</p>
            )}
            {jobs.map((job, index) => (
              <JobRow
                key={job.id}
                job={job}
                index={index}
                total={jobs.length}
                catalog={catalog}
                pending={pendingFor(job.id)}
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
