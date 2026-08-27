/**
 * One provider family's burn plan: the window gates that decide WHEN it burns,
 * plus the ordered job list that decides WHAT it burns on.
 *
 * The header always states whether this family would burn on the next tick and,
 * when it wouldn't, the exact reason the runner gave — the same predicate the
 * runner evaluates, so the card can't disagree with what actually happens.
 */

import { AlertTriangle, Ban, ChevronDown, ChevronRight, Flame, Plus, RotateCcw } from 'lucide-react';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import JobRow from './JobRow';
import PresetPicker from './PresetPicker';
import { dispatchCapInput, isUnlimitedDispatchCap, jobFromPreset, quotaBurnJobIsSpent, UNLIMITED_DISPATCHES } from '../../lib/quotaBurnPatch';
import { formatDateTime } from '../../utils/formatters';
import { NumberField } from './fields';

export default function FamilyCard({
  familyId, config, status, catalog, catalogError, catalogRetrying, expanded, actionsBusy,
  onToggleExpand, onPatch, onRunFamily, onRunJob, onRearm, onRetryCatalog,
}) {
  const jobs = config.jobs || [];
  const hasEnabledJobs = jobs.some((job) => job.enabled !== false);
  // Pending counts and `run once` completions stay on the STATUS side and are
  // passed to JobRow as their own props — merging them into the job objects
  // would mean stripping them back off before every save (the PUT schema is
  // strict). Keyed by id, so a reorder mid-save can't mis-pair them, and indexed
  // once rather than scanned per lookup: this component re-renders on every
  // keystroke (the page holds `config` in state and saves on a trailing
  // debounce), and a linear `find` ran three times per job — the count below
  // plus both props on every row.
  const statusById = new Map((status?.jobs || []).map((row) => [row.id, row]));
  const spentCount = jobs.filter((job) => quotaBurnJobIsSpent(job, statusById.get(job.id)?.ranAt)).length;

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
    runOnce: false,
    params: {},
  }]);
  // A preset job inherits the app the plan is already pointed at, when the plan
  // is unambiguous about it — otherwise a one-click "add a UX audit" lands as a
  // step that cannot run until the user notices the unset app picker. Derived at
  // click time, not per render: the page polls while any family is pending.
  const addPresetJob = (preset) => {
    const targetedAppIds = [...new Set(jobs.map((job) => job.params?.appId).filter(Boolean))];
    patchJobs([...jobs, jobFromPreset(preset, {
      id: nextJobId(),
      appId: targetedAppIds.length === 1 ? targetedAppIds[0] : null,
    })]);
  };

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

        {/* Pending is its own state, ahead of the verdict: reading this family's
            quota is a multi-second CLI/TUI spawn that the page deliberately does
            not block on, and "no window states a reset time" would read as a
            verdict when the reading simply hasn't landed yet. */}
        {status?.pending ? (
          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
            <BrailleSpinner /> reading quota…
          </span>
        ) : status?.willBurn ? (
          /* The window is NAMED, not just measured: a family publishes a short
             rolling window and a weekly one, and "62% left · resets in 30h" is
             unreadable without knowing which allowance it describes. */
          <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
            <Flame size={13} />
            {status.windowLabel ? `${status.windowLabel}: ` : ''}{status.percentRemaining}% left · resets in {status.hoursUntilReset}h · {status.dispatchesUsed}{isUnlimitedDispatchCap(config.maxDispatchesPerWindow) ? '' : `/${config.maxDispatchesPerWindow}`} used
          </span>
        ) : (
          <span className="text-xs text-gray-500">{status?.skipReason || 'not evaluated yet'}</span>
        )}

        {/* An observed refusal, shown even when some other gate is the one
            reported — "the provider said no" is the actionable fact, and it
            explains a family that looks healthy on paper but never burns. The
            server's skip reason deliberately omits the instant so this badge
            owns it, in the app's shared timestamp format. */}
        {status?.blockedUntil && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-400" title={status.blockedReason || 'The provider refused the last burn.'}>
            <Ban size={13} />
            provider refused — retrying after {formatDateTime(status.blockedUntil)}
          </span>
        )}

        {/* A collapsed card otherwise says nothing about whether this family has
            a plan at all — and a family with zero enabled jobs can never burn,
            no matter how healthy its window looks. A spent `run once` step is
            counted here for the same reason: it is enabled but unrunnable, so
            without it "3 jobs · 3 enabled" sits above a family that will never
            dispatch again. */}
        <span className="text-[11px] text-gray-500">
          {jobs.length
            ? `${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${jobs.filter((job) => job.enabled !== false).length} enabled${spentCount ? ` · ${spentCount} ran once` : ''}`
            : 'no jobs'}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="text-xs text-port-accent hover:underline disabled:opacity-40"
            disabled={actionsBusy || !hasEnabledJobs}
            onClick={() => onRunFamily(familyId)}
            title={hasEnabledJobs ? 'Force-run this family\'s next available job now' : 'Add an enabled job before running this family'}
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
          {/* Every choice this section offers — job type, app, universe, image
              mode, and the preset picker — comes from the catalog, so a failed
              catalog read empties them all and hides the picker outright. Say
              so where the empty controls are, and offer the re-read here rather
              than making a browser reload the only way back. */}
          {catalogError && (
            <Banner
              tone="warning"
              icon={AlertTriangle}
              // Announced, not just drawn: this banner appears AFTER the card is
              // already on screen (the read resolves late, and a retry can put
              // it back), so a screen-reader user gets no notification that the
              // controls below just lost their choices without it.
              role="status"
              aria-live="polite"
              title="Job choices could not be loaded"
              actions={(
                <button
                  type="button"
                  className="text-xs px-3 py-1.5 rounded border border-port-warning/40 hover:bg-port-warning/10 disabled:opacity-40"
                  disabled={catalogRetrying}
                  onClick={onRetryCatalog}
                >
                  {catalogRetrying ? 'Retrying…' : 'Retry catalog load'}
                </button>
              )}
            >
              {/* The cause keeps its own line: it is a server message of
                  unknown punctuation, so running it into the sentence below
                  reads as one mangled sentence half the time. */}
              <p className="mt-0.5 break-words">{catalogError}</p>
              <p className="mt-1">
                Job types, apps, universes, and presets are unavailable — editing a step now would save an empty job type
                and be rejected.
              </p>
            </Banner>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <NumberField id={`burn-${familyId}-window`} label="Burn within (hours of reset)" value={config.resetWithinHours} onChange={(v) => onPatch({ resetWithinHours: v })} min={0} max={168} hint="Measured against the broadest window (the weekly one) — the allowance that expires unused." />
            <NumberField id={`burn-${familyId}-reserve`} label="Reserve (%)" value={config.reservePercent} onChange={(v) => onPatch({ reservePercent: v })} min={0} max={100} hint="Never spend below this much headroom." />
            <NumberField id={`burn-${familyId}-cap`} label="Dispatch cap per window" value={config.maxDispatchesPerWindow} onChange={(v) => onPatch({ maxDispatchesPerWindow: dispatchCapInput(v) })} min={UNLIMITED_DISPATCHES} max={50} hint="Max automatic burns per reset window. -1 = unlimited (the default) — the reset window, the reserve, and provider refusals still bound it." />
            <NumberField id={`burn-${familyId}-priority`} label="Priority" value={config.priority} onChange={(v) => onPatch({ priority: v })} min={0} max={100} hint="Lower wins when two windows reset together." />
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs uppercase tracking-wide text-gray-400">Burn plan — runs in order</h3>
              <div className="flex items-center gap-3">
                {/* Re-arming step by step is the wrong shape for the case this
                    exists to serve: a plan configured as a one-shot SERIES,
                    which the user wants to run again as a series. Not confirmed
                    — it dispatches nothing on its own, it just makes the steps
                    eligible for a future cycle's gates. */}
                {spentCount > 0 && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white disabled:opacity-40"
                    disabled={actionsBusy}
                    onClick={() => onRearm(familyId)}
                    title="Put every step that has already run back into the rotation"
                  >
                    <RotateCcw size={13} /> Re-arm all ({spentCount})
                  </button>
                )}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-40"
                  disabled={!canAddJob}
                  title={canAddJob ? 'Add a job to this plan' : 'Job catalog unavailable — retry the catalog load above'}
                  onClick={addJob}
                >
                  <Plus size={13} /> Add job
                </button>
              </div>
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
                pending={statusById.get(job.id)?.pending ?? null}
                ranAt={statusById.get(job.id)?.ranAt ?? null}
                actionsBusy={actionsBusy}
                onChange={(next) => changeJob(index, next)}
                onMove={moveJob}
                onRemove={(i) => patchJobs(jobs.filter((_, x) => x !== i))}
                onRun={(target) => onRunJob(familyId, target)}
                onRearm={(target) => onRearm(familyId, target.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
