/**
 * One provider family's burn plan: the window gates that decide WHEN it burns,
 * plus the ordered job list that decides WHAT it burns on.
 *
 * The header always states whether this family would burn on the next tick and,
 * when it wouldn't, the exact reason the runner gave — the same predicate the
 * runner evaluates, so the card can't disagree with what actually happens.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Ban, ChevronDown, ChevronRight, Flame, RotateCcw } from 'lucide-react';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import JobRow from './JobRow';
import TaskRefPicker from './TaskRefPicker';
import { dispatchCapInput, isUnlimitedDispatchCap, quotaBurnJobIsSpent, UNLIMITED_DISPATCHES } from '../../lib/quotaBurnPatch';
import { CREATE_TASK_HREF, maintenanceSequence, MAINTENANCE_ORDER_GUIDANCE, flattenTaskCatalog, quotaBurnStepPayload, stepFromTaskEntry, taskEntryNeedsApp } from '../../lib/quotaBurnTasks';
import { formatDateTime } from '../../utils/formatters';
import { NumberField } from './fields';

export default function FamilyCard({
  familyId, config, status, catalog, taskGroups, catalogError, catalogRetrying, expanded, actionsBusy,
  onToggleExpand, onPatch, onStartSequence, onRunFamily, onRunJob, onRearm, onRetryCatalog,
}) {
  const jobs = config.jobs || [];
  const hasEnabledJobs = jobs.some((job) => job.enabled !== false);
  const [expandedJobIds, setExpandedJobIds] = useState(() => new Set());
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

  // Serialized on the way OUT, in one place, because the PUT's job schema is
  // strict and the GET hands back more than it accepts as input — including the
  // top-level override mirrors, which outrank the `overrides` bag by presence.
  // Doing it here rather than per call site is what keeps a reorder, an edit and
  // a removal all sending the same shape.
  const patchJobs = (next) => onPatch({ jobs: next.map(quotaBurnStepPayload) });
  const changeJob = (index, next) => patchJobs(jobs.map((job, i) => (i === index ? next : job)));
  const moveJob = (index, delta) => {
    const next = [...jobs];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved);
    patchJobs(next);
  };
  // Ids key the React list AND pair each job with its server-side pending count,
  // so a duplicate is a real defect, not a cosmetic one. `Date.now()` alone can
  // repeat within the same millisecond (two picks in quick succession from the
  // Add a step control), so disambiguate against the ids already in the plan
  // rather than trusting the clock to have ticked.
  const nextJobId = () => {
    const taken = new Set(jobs.map((job) => job.id));
    const base = `job-${Date.now().toString(36)}`;
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  };
  // A new step inherits the app the plan is already pointed at, when the plan is
  // unambiguous about it — otherwise a one-click "add the UX audit" lands as a
  // step that cannot run until the user notices the unset target picker. Derived
  // at click time, not per render: the page polls while any family is pending.
  const addStep = (entry) => {
    const targeted = [...new Set(jobs.map((job) => job.taskRef?.appId).filter(Boolean))];
    const id = nextJobId();
    patchJobs([...jobs, { ...stepFromTaskEntry(entry, {
      id,
      appId: taskEntryNeedsApp(entry) && targeted.length === 1 ? targeted[0] : null,
    }), ...(config.sequence ? { runOnce: true } : {}) }]);
    setExpandedJobIds((prev) => new Set(prev).add(id));
  };

  const allExpanded = jobs.length > 0 && jobs.every((job) => expandedJobIds.has(job.id));
  const toggleAllJobs = () => {
    if (allExpanded) {
      setExpandedJobIds(new Set());
    } else {
      setExpandedJobIds(new Set(jobs.map((job) => job.id)));
    }
  };
  const toggleJobExpand = (jobId) => {
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const [sequenceAppId, setSequenceAppId] = useState('');
  const sequenceApps = catalog?.apps || [];
  const sequenceJobs = maintenanceSequence(taskGroups, sequenceAppId, `maintenance-${Date.now().toString(36)}`);
  const hasTasks = flattenTaskCatalog(taskGroups).length > 0;

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
          !status?.blockedUntil && (
            <span className="text-xs text-gray-500">{status?.skipReason || 'not evaluated yet'}</span>
          )
        )}

        {/* An observed refusal, shown even when some other gate is the one
            reported — "the provider said no" is the actionable fact, and it
            explains a family that looks healthy on paper but never burns. The
            server's skip reason deliberately omits the instant so this badge
            owns it, in the app's shared timestamp format. */}
        {status?.blockedUntil && (
          <div className="flex flex-wrap items-center gap-1 text-xs text-amber-400">
            <span className="inline-flex items-center gap-1">
              <Ban size={13} />
              provider refused — retrying after {formatDateTime(status.blockedUntil)}
            </span>
            <span className="basis-full pl-[17px] break-words text-amber-300/90">
              {status.blockedReason || 'The provider refused the last burn.'}
            </span>
          </div>
        )}

        {/* A collapsed card otherwise says nothing about whether this family has
            a plan at all — and a family with zero enabled jobs can never burn,
            no matter how healthy its window looks. A spent `run once` step is
            counted here for the same reason: it is enabled but unrunnable, so
            without it "3 jobs · 3 enabled" sits above a family that will never
            dispatch again. */}
        <span className="text-[11px] text-gray-500">
          {jobs.length
            ? `${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${jobs.filter((job) => job.enabled !== false).length} enabled${spentCount ? ` · ${spentCount} ${config.sequence ? 'completed' : 'ran once'}` : ''}`
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
          {/* Every choice this section offers — which scheduled task, which app,
              which provider/model — comes from the catalog reads, so a failure
              empties them all. Say so where the empty controls are, and offer
              the re-read here rather than making a browser reload the only way
              back. */}
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
                Scheduled tasks, apps, and providers are unavailable — a step added now would have no task to reference.
              </p>
            </Banner>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <NumberField id={`burn-${familyId}-window`} label="Burn within (hours of reset)" value={config.resetWithinHours} onChange={(v) => onPatch({ resetWithinHours: v })} min={0} max={168} hint="Measured against the broadest window (the weekly one) — the allowance that expires unused." />
            <NumberField id={`burn-${familyId}-reserve`} label="Reserve (%)" value={config.reservePercent} onChange={(v) => onPatch({ reservePercent: v })} min={0} max={100} hint="Never spend below this much headroom." />
            <NumberField id={`burn-${familyId}-cap`} label="Dispatch cap per window" value={config.maxDispatchesPerWindow} onChange={(v) => onPatch({ maxDispatchesPerWindow: dispatchCapInput(v) })} min={UNLIMITED_DISPATCHES} max={50} hint="Max automatic burns per reset window. -1 = unlimited (the default) — the reset window, the reserve, and provider refusals still bound it." />
            <NumberField id={`burn-${familyId}-priority`} label="Priority" value={config.priority} onChange={(v) => onPatch({ priority: v })} min={0} max={100} hint="Lower wins when two windows reset together." />
          </div>

          <div className="space-y-2 text-xs">
            <p>{MAINTENANCE_ORDER_GUIDANCE}</p>
            <p>Audit once, drain eligible issues between audits, then improve documentation. Requires enabled tasks for the app and perpetual claim-issue. Quota limits still apply.</p>
            <label htmlFor={`maintenance-app-${familyId}`}>Maintenance sequence app</label>
            <select id={`maintenance-app-${familyId}`} value={sequenceAppId} onChange={event => setSequenceAppId(event.target.value)} className="block w-full bg-port-bg border border-port-border rounded p-2">
              <option value="">Select app</option>
              {sequenceApps.map(app => <option key={app.id} value={app.id}>{app.name || app.id}</option>)}
            </select>
            {sequenceAppId && !sequenceJobs && <p>Enable the listed tasks for this app in <Link to="/cos/schedule" className="text-port-accent underline">Scheduled Tasks</Link>, including perpetual mode on claim-issue.</p>}
            <button type="button" disabled={actionsBusy || !sequenceJobs || jobs.length > 0} className="text-port-accent disabled:opacity-40"
              onClick={() => onPatch({ sequence: true, jobs: sequenceJobs.map(quotaBurnStepPayload) })}>
              Populate maintenance sequence
            </button>
            <button type="button" disabled={actionsBusy || !sequenceJobs || jobs.length > 0} className="ml-3 text-port-accent disabled:opacity-40"
              onClick={() => onStartSequence(familyId, sequenceJobs.map(quotaBurnStepPayload))}>
              Populate and start sequence
            </button>
            <p>Start enables Quota Burn and this family, saves the plan, and evaluates it under the configured quota limits.</p>
            {jobs.length > 0 && <p>Clear the existing plan to populate a new sequence.</p>}
            {config.sequence && <p>Strict sequence: waits for each step; claim steps repeat until eligible work is drained. Enable Quota Burn and this family, then use Burn now to start.</p>}
          </div>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs uppercase tracking-wide text-gray-400">Burn plan — runs in order</h3>
              <div className="flex items-center gap-3">
                {jobs.length > 0 && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white"
                    onClick={toggleAllJobs}
                  >
                    {allExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {allExpanded ? 'Collapse all' : 'Expand all'}
                  </button>
                )}
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
              </div>
            </div>
            <div className="sm:max-w-md">
              <TaskRefPicker
                id={`burn-${familyId}-add-step`}
                label="Add a step"
                groups={taskGroups}
                onPick={addStep}
                placeholder={hasTasks ? 'Add a scheduled task to this plan…' : 'No scheduled tasks available'}
                hint="Every step runs an existing scheduled task with this family's quota. Overrides apply to the burn only."
              />
              {/* Creating work happens in Scheduled Tasks, not here — that is
                  what keeps one automation catalog instead of two. A plan with
                  nothing to reference needs this link more than anything else on
                  the card, so it is stated rather than implied. */}
              <p className="mt-1 text-[11px] text-gray-500">
                Need work that does not exist yet?{' '}
                <Link to={CREATE_TASK_HREF} className="text-port-accent hover:underline">
                  Create an on-demand scheduled task
                </Link>
                , then add it here.
              </p>
            </div>
            {!jobs.length && (
              <p className="text-xs text-gray-500">No steps yet — this family will never burn until one is added.</p>
            )}
            {jobs.map((job, index) => (
              <JobRow
                key={job.id}
                job={job}
                familyId={familyId}
                sequence={config.sequence === true}
                index={index}
                total={jobs.length}
                catalog={catalog}
                taskGroups={taskGroups}
                pending={statusById.get(job.id)?.pending ?? null}
                ranAt={statusById.get(job.id)?.ranAt ?? null}
                actionsBusy={actionsBusy}
                expanded={expandedJobIds.has(job.id)}
                onToggleExpand={() => toggleJobExpand(job.id)}
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
