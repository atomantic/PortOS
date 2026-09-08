/**
 * One burn step inside a family's ordered plan: the scheduled task it points at,
 * the app it targets, its per-invocation overrides, and the controls that
 * move/remove/run it.
 *
 * A step is a REFERENCE, never a copy — removing it here deletes nothing in
 * Scheduled Tasks, and editing the work itself happens there. Order is
 * meaningful (the runner takes the first enabled step with pending work), so the
 * move controls are part of the configuration rather than a convenience.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, Play, RotateCcw, Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import StepSettings from './StepSettings';
import TaskRefPicker from './TaskRefPicker';
import { quotaBurnJobIsSpent } from '../../lib/quotaBurnPatch';
import { findTaskEntry, stepFromTaskEntry, taskEntryNeedsApp, taskRefKey } from '../../lib/quotaBurnTasks';
import { timeAgo } from '../../utils/formatters';
import { commandBasename } from '../../utils/providers';
import { inputClass } from './fields';

/**
 * The CLI/TUI providers that spend THIS family's subscription.
 *
 * A burn draws down one family's window, so a pin naming another family's binary
 * is never what the user meant — and the server rejects it. Local-model backends
 * are excluded outright: they have no subscription quota to burn.
 */
function providersForFamily(providers, familyId) {
  return (providers || []).filter((provider) =>
    provider?.enabled !== false
    && provider?.ollamaBacked !== true && provider?.lmstudioBacked !== true
    && provider?.mtplxBacked !== true
    && provider?.llamaBacked !== true && provider?.vllmBacked !== true
    && provider?.sglangBacked !== true
    && (provider?.type === 'cli' || provider?.type === 'tui')
    && (commandBasename(provider?.command) === familyId
      || String(provider?.id || '').toLowerCase().includes(familyId || '')
      || (familyId === 'agy' && String(provider?.id || '').toLowerCase().includes('antigravity'))));
}

export default function JobRow({
  job, index, total, catalog, taskGroups, pending, ranAt, actionsBusy,
  familyId,
  expanded = false, onToggleExpand,
  onChange, onMove, onRemove, onRun, onRearm,
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = onToggleExpand !== undefined ? expanded : localExpanded;
  const toggleExpand = onToggleExpand || (() => setLocalExpanded((prev) => !prev));

  // Two-click arm on delete (the repo's inline-confirm convention). It removes
  // the step from the plan — its order, name, overrides and run-once state — and
  // there is no undo. The referenced scheduled task is untouched either way.
  const [armed, setArmed] = useState(false);
  // Run is armed for the same reason: it force-dispatches past the window,
  // reserve, and cap gates and spends real subscription quota. The icon sits in
  // a row of small controls on a page whose edits save on change, so a stray
  // click reads as "save" — it must not be a one-click spend.
  const [runArmed, setRunArmed] = useState(false);
  // Disarm the run confirm the moment the page has unsaved (or stalled) edits.
  // The confirm asks "spend now?" about the SAVED plan, so an edit invalidates
  // the question — and the alternative (leaving the pair on screen with both
  // buttons disabled, since `busy` disables Cancel too) strands an armed
  // confirm the user cannot dismiss when a save has stopped retrying.
  useEffect(() => { if (actionsBusy) setRunArmed(false); }, [actionsBusy]);

  const entry = findTaskEntry(taskGroups, job.taskRef);
  const idPrefix = `burn-job-${job.id}`;
  const spent = quotaBurnJobIsSpent(job, ranAt);
  // Derived server-side from the live catalog on every read: a reference whose
  // task was deleted, disabled, or pointed at an app it may not target keeps its
  // place in the plan and states WHY it cannot run, rather than disappearing.
  const unavailable = job.unavailable || null;
  const actionButtonClass = 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center';
  const providers = providersForFamily(catalog.providers, familyId);
  const summary = entry?.label || job.taskRef?.taskType || job.taskRef?.jobId || job.jobType || 'unreferenced step';
  const targetApps = (catalog.apps || []).filter((app) => (entry?.appIds || []).includes(app.id));
  // The app's NAME in the collapsed summary, falling back to its id: a plan is
  // read at a glance, and a raw id is the one thing on that line the user never
  // chose.
  const targetName = job.taskRef?.appId
    ? (catalog.apps || []).find((app) => app.id === job.taskRef.appId)?.name || job.taskRef.appId
    : null;

  // Switching the referenced task rebuilds the reference (and re-targets it),
  // but KEEPS the step's own choices — its name, order, run-once flag and
  // overrides are the user's, not the task's.
  const pickTask = (picked) => onChange({
    ...job,
    ...stepFromTaskEntry(picked, { id: job.id }),
    enabled: job.enabled !== false,
    label: job.label || '',
    runOnce: job.runOnce === true,
    overrides: job.overrides || {},
  });

  return (
    // `bg-port-bg`, not `bg-port-bg/40`: a step sits INSIDE the family card, so
    // it reads as a sunken well only if it carries the page color at full
    // strength. At 40% it composited most of the way back to the card fill and
    // eight steps ran together as one undifferentiated block.
    <div className="rounded border border-port-border/70 bg-port-bg p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-white"
          onClick={toggleExpand}
          aria-label={isExpanded ? `Collapse step ${index + 1}` : `Expand step ${index + 1}`}
          title={isExpanded ? 'Collapse step' : 'Expand step'}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <input
          id={`${idPrefix}-enabled`}
          type="checkbox"
          checked={job.enabled !== false}
          onChange={(event) => onChange({ ...job, enabled: event.target.checked })}
        />
        <label htmlFor={`${idPrefix}-enabled`} className="text-xs text-gray-400">Step {index + 1}</label>
        <input
          className={`${inputClass} flex-1 min-w-40 mt-0`}
          value={job.label || ''}
          placeholder={`Step name (defaults to “${summary}”)`}
          aria-label={`Name for step ${index + 1}`}
          onChange={(event) => onChange({ ...job, label: event.target.value })}
        />
        {!isExpanded && (
          <span className="text-xs text-gray-400 truncate max-w-xs">
            {summary}
            {targetName ? ` · ${targetName}` : ''}
            {job.overrides?.model ? ` · ${job.overrides.model}` : ''}
            {job.overrides?.effort ? ` · ${job.overrides.effort}` : ''}
            {job.runOnce ? ' · run once' : ''}
          </span>
        )}
        <div className="flex items-center">
          <div className="flex items-center gap-1">
            <button type="button" className={`${actionButtonClass} text-gray-400 hover:text-white disabled:opacity-30`} disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={`Move step ${index + 1} earlier`}><ArrowUp size={14} /></button>
            <button type="button" className={`${actionButtonClass} text-gray-400 hover:text-white disabled:opacity-30`} disabled={index === total - 1} onClick={() => onMove(index, 1)} aria-label={`Move step ${index + 1} later`}><ArrowDown size={14} /></button>
            {/* An unavailable step has NO run affordance at all — not a disabled
                one. The server would decline the dispatch, so offering the
                button (even greyed) invites a click whose only outcome is a
                toast; the reason below is the actionable thing. */}
            {unavailable ? null : runArmed ? (
              // `warning`, not `error`: forcing a run is expensive-but-safe, and
              // it must not look identical to the delete confirm beside it.
              <ConfirmButtonPair
                prompt="Spend now?"
                confirmText="Run"
                confirmIcon={Play}
                cancelText="Cancel"
                tone="warning"
                ariaLabel={`Confirm running step ${index + 1} now`}
                largeTouchTargets
                onConfirm={() => { setRunArmed(false); onRun(job); }}
                onCancel={() => setRunArmed(false)}
              />
            ) : (
              <button type="button" className={`${actionButtonClass} text-port-accent hover:text-white disabled:opacity-30`} disabled={actionsBusy} onClick={() => { setArmed(false); setRunArmed(true); }} aria-label={`Run step ${index + 1} now`} title={actionsBusy ? 'Saving your changes…' : 'Run this job now, ignoring the reset window (asks to confirm)'}><Play size={14} /></button>
            )}
          </div>
          <div className="ml-2 border-l border-port-border/50 pl-2">
            {armed ? (
              <ConfirmButtonPair
                prompt="Removes the step, not the task."
                confirmText="Remove"
                confirmIcon={Trash2}
                cancelText="Cancel"
                ariaLabel={`Confirm removing step ${index + 1}`}
                largeTouchTargets
                onConfirm={() => onRemove(index)}
                onCancel={() => setArmed(false)}
              />
            ) : (
              <button type="button" className={`${actionButtonClass} text-red-400 hover:text-red-300 disabled:opacity-30`} onClick={() => { setRunArmed(false); setArmed(true); }} aria-label={`Remove step ${index + 1}`}><Trash2 size={14} /></button>
            )}
          </div>
        </div>
      </div>

      {/* Stated whether or not the row is expanded: an unrunnable step is the
          reason a whole family stops burning, and it must not be hidden behind a
          chevron. */}
      {unavailable && (
        <p role="status" className="flex flex-wrap items-start gap-1 text-[11px] text-amber-300">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="break-words">
            Cannot run — {unavailable.reason || unavailable.code}. Pick another scheduled task below, or fix it in Scheduled Tasks.
          </span>
        </p>
      )}

      {isExpanded && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TaskRefPicker
              id={`${idPrefix}-task`}
              label="Scheduled task"
              groups={taskGroups}
              value={taskRefKey(job.taskRef)}
              onPick={pickTask}
              hint="Burn steps run work you already defined in Scheduled Tasks or System Tasks — they never edit it."
            />
            {/* Only a type that acts on ONE managed app gets a target: an
                install-wide type sweeps every app in one dispatch, and a
                programmatic type acts on PortOS's own records — the server
                rejects a request from either that names an app. */}
            {entry && taskEntryNeedsApp(entry) && (
              <label htmlFor={`${idPrefix}-app`} className="block text-xs text-gray-400">
                Target app
                <select
                  id={`${idPrefix}-app`}
                  className={inputClass}
                  value={job.taskRef?.appId || ''}
                  onChange={(event) => onChange({
                    ...job,
                    taskRef: { ...job.taskRef, appId: event.target.value || null },
                  })}
                >
                  <option value="">Select an app…</option>
                  {targetApps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
                </select>
                {targetApps.length === 0 && (
                  <span className="mt-1 block text-[11px] text-amber-300">
                    No managed app has this task enabled — turn it on in the app’s Automation tab first.
                  </span>
                )}
              </label>
            )}
            {entry && !taskEntryNeedsApp(entry) && (
              <p className="self-end text-[11px] text-gray-500">
                {entry.programmatic
                  ? 'PortOS runs this task itself, against its own records — there is no app to target.'
                  : 'Runs install-wide: one dispatch sweeps every managed app.'}
              </p>
            )}
            <div className="text-xs text-gray-400 sm:col-span-2">
              <div className="flex items-center gap-2 mt-1">
                <input
                  id={`${idPrefix}-run-once`}
                  type="checkbox"
                  checked={job.runOnce === true}
                  onChange={(event) => onChange({ ...job, runOnce: event.target.checked })}
                />
                <label htmlFor={`${idPrefix}-run-once`}>Run once</label>
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                {job.runOnce
                  ? 'Dispatches once, then drops out of the rotation until you re-arm it.'
                  : 'Repeats every lap of the plan while the window still has quota.'}
              </p>
            </div>
          </div>

          <StepSettings
            job={job}
            entry={entry}
            providers={providers}
            idPrefix={idPrefix}
            onChange={onChange}
          />

          {entry?.description && <p className="text-[11px] text-gray-500">{entry.description}</p>}
        </>
      )}

      {/* A spent step is not probed server-side (its count would never be acted
          on), so this REPLACES the pending line rather than sitting beside it —
          "Idle — no pending work" would otherwise be the only thing a finished
          step said about itself. */}
      {spent ? (
        <p className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
          <span className="inline-flex items-center gap-1 text-sky-300">
            <CheckCircle2 size={12} /> Ran once {timeAgo(ranAt)}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-port-accent hover:underline disabled:opacity-40"
            disabled={actionsBusy}
            onClick={() => onRearm(job)}
            title="Put this step back into the rotation — it burns again on a future cycle"
          >
            <RotateCcw size={12} /> Re-arm
          </button>
        </p>
      ) : pending && (
        <p className={`text-[11px] ${pending.count > 0 ? 'text-emerald-400' : 'text-gray-500'}`}>
          {pending.count > 0 ? `Ready — ${pending.detail}` : `Idle — ${pending.detail}`}
        </p>
      )}
    </div>
  );
}
