/**
 * One burn job inside a family's ordered plan: its type, its per-job model, its
 * type-specific params, and the controls that move/remove/run it.
 *
 * Order is meaningful — the runner takes the FIRST enabled job with pending
 * work — so the move controls are part of the configuration, not a convenience.
 */

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Play, Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import JobParamField from './JobParamField';
import PresetPicker from './PresetPicker';
import { applyQuotaBurnPreset } from '../../lib/quotaBurnPatch';
import { inputClass } from './fields';

export default function JobRow({
  job, index, total, catalog, pending, actionsBusy,
  onChange, onMove, onRemove, onRun,
}) {
  // Two-click arm on delete (the repo's inline-confirm convention). A job holds
  // the family's whole free-text work prompt and nothing else stores it — a
  // stray click on the trash icon would drop it from the persisted plan with no
  // undo.
  const [armed, setArmed] = useState(false);
  // Run is armed for the same reason: it force-dispatches past the window,
  // reserve, and cap gates and spends real subscription quota. The icon sits in
  // a row of small controls on a page whose edits save on change, so a stray
  // click reads as "save" — it must not be a one-click spend.
  const [runArmed, setRunArmed] = useState(false);
  // A preset overwrites the work prompt. Held rather than applied immediately
  // when there is already prompt text, so picking one never silently discards a
  // prompt the user wrote by hand.
  const [pendingPreset, setPendingPreset] = useState(null);
  // Disarm the run confirm the moment the page has unsaved (or stalled) edits.
  // The confirm asks "spend now?" about the SAVED plan, so an edit invalidates
  // the question — and the alternative (leaving the pair on screen with both
  // buttons disabled, since `busy` disables Cancel too) strands an armed
  // confirm the user cannot dismiss when a save has stopped retrying.
  useEffect(() => { if (actionsBusy) setRunArmed(false); }, [actionsBusy]);
  const spec = catalog.jobTypes.find((type) => type.id === job.jobType);
  const idPrefix = `burn-job-${job.id}`;
  const setParam = (key, value) => onChange({ ...job, params: { ...job.params, [key]: value } });
  const hasPromptText = Boolean(String(job.params?.prompt || '').trim());
  const applyPreset = (preset) => { setPendingPreset(null); onChange(applyQuotaBurnPreset(job, preset)); };
  const optionsFor = (descriptor) => ({
    app: catalog.apps,
    universe: catalog.universes,
    imageMode: catalog.imageModes,
  })[descriptor.kind];

  return (
    <div className="rounded border border-port-border/70 bg-port-bg/40 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
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
          placeholder={spec ? `Step name (defaults to “${spec.label}”)` : 'Step name'}
          aria-label={`Name for step ${index + 1}`}
          onChange={(event) => onChange({ ...job, label: event.target.value })}
        />
        <div className="flex items-center gap-1">
          <button type="button" className="p-1 text-gray-400 hover:text-white disabled:opacity-30" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={`Move step ${index + 1} earlier`}><ArrowUp size={14} /></button>
          <button type="button" className="p-1 text-gray-400 hover:text-white disabled:opacity-30" disabled={index === total - 1} onClick={() => onMove(index, 1)} aria-label={`Move step ${index + 1} later`}><ArrowDown size={14} /></button>
          {runArmed ? (
            // `warning`, not `error`: forcing a run is expensive-but-safe, and
            // it must not look identical to the delete confirm beside it.
            <ConfirmButtonPair
              prompt="Spend now?"
              confirmText="Run"
              confirmIcon={Play}
              cancelText="Cancel"
              tone="warning"
              ariaLabel={`Confirm running step ${index + 1} now`}
              onConfirm={() => { setRunArmed(false); onRun(job); }}
              onCancel={() => setRunArmed(false)}
            />
          ) : (
            <button type="button" className="p-1 text-port-accent hover:text-white disabled:opacity-30" disabled={actionsBusy} onClick={() => { setArmed(false); setRunArmed(true); }} aria-label={`Run step ${index + 1} now`} title="Run this job now, ignoring the reset window (asks to confirm)"><Play size={14} /></button>
          )}
          {armed ? (
            <ConfirmButtonPair
              prompt="Discards its prompt."
              confirmText="Delete"
              confirmIcon={Trash2}
              cancelText="Cancel"
              ariaLabel={`Confirm removing step ${index + 1}`}
              onConfirm={() => onRemove(index)}
              onCancel={() => setArmed(false)}
            />
          ) : (
            <button type="button" className="p-1 text-red-400 hover:text-red-300 disabled:opacity-30" onClick={() => { setRunArmed(false); setArmed(true); }} aria-label={`Remove step ${index + 1}`}><Trash2 size={14} /></button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label htmlFor={`${idPrefix}-type`} className="block text-xs text-gray-400">
          Job type
          <select
            id={`${idPrefix}-type`}
            className={inputClass}
            value={job.jobType}
            // Params are CARRIED, not cleared. Each job type reads only its own
            // keys (the server's normalizer keeps any scalar), so a stray click
            // through the type picker no longer silently destroys a long work
            // prompt — switching back restores it.
            onChange={(event) => onChange({ ...job, jobType: event.target.value })}
          >
            {catalog.jobTypes.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-model`} className="block text-xs text-gray-400">
          Model (optional)
          <input
            id={`${idPrefix}-model`}
            className={inputClass}
            value={job.model || ''}
            placeholder="provider default"
            onChange={(event) => onChange({ ...job, model: event.target.value || null })}
          />
        </label>
        <PresetPicker
          id={`${idPrefix}-preset`}
          label="Start from a preset (optional)"
          presets={catalog.presets}
          // Deliberately NOT filtered to this row's current job type. Filtering
          // hid the control entirely on a non-agent row, so converting an
          // existing step into an audit meant deleting and re-adding it — and
          // the conversion is safe: params carry across the type switch and
          // existing prompt text is confirmed before it is replaced.
          hint="Fills the work prompt below with a ready-made single-focus audit that files issues and changes no code."
          onPick={(preset) => (hasPromptText ? setPendingPreset(preset) : applyPreset(preset))}
        />
        {(spec?.params || []).map((descriptor) => (
          <JobParamField
            key={descriptor.key}
            descriptor={descriptor}
            value={job.params?.[descriptor.key]}
            options={optionsFor(descriptor)}
            idPrefix={idPrefix}
            onChange={setParam}
          />
        ))}
      </div>

      {pendingPreset && (
        <InlineConfirmRow
          tone="warning"
          question={`Replace this step's work prompt with the “${pendingPreset.label}” preset? Your current text is discarded.`}
          confirmText="Replace"
          cancelText="Keep mine"
          onConfirm={() => applyPreset(pendingPreset)}
          onCancel={() => setPendingPreset(null)}
        />
      )}

      {spec?.description && <p className="text-[11px] text-gray-500">{spec.description}</p>}
      {pending && (
        <p className={`text-[11px] ${pending.count > 0 ? 'text-emerald-400' : 'text-gray-500'}`}>
          {pending.count > 0 ? `Ready — ${pending.detail}` : `Idle — ${pending.detail}`}
        </p>
      )}
    </div>
  );
}
