/**
 * One burn job inside a family's ordered plan: its type, its per-job model, its
 * type-specific params, and the controls that move/remove/run it.
 *
 * Order is meaningful — the runner takes the FIRST enabled job with pending
 * work — so the move controls are part of the configuration, not a convenience.
 */

import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Play, Trash2 } from 'lucide-react';
import JobParamField from './JobParamField';
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
  const spec = catalog.jobTypes.find((type) => type.id === job.jobType);
  const idPrefix = `burn-job-${job.id}`;
  const setParam = (key, value) => onChange({ ...job, params: { ...job.params, [key]: value } });
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
          placeholder={spec?.label || 'Job name'}
          aria-label={`Name for step ${index + 1}`}
          onChange={(event) => onChange({ ...job, label: event.target.value })}
        />
        <div className="flex items-center gap-1">
          <button type="button" className="p-1 text-gray-400 hover:text-white disabled:opacity-30" disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={`Move step ${index + 1} earlier`}><ArrowUp size={14} /></button>
          <button type="button" className="p-1 text-gray-400 hover:text-white disabled:opacity-30" disabled={index === total - 1} onClick={() => onMove(index, 1)} aria-label={`Move step ${index + 1} later`}><ArrowDown size={14} /></button>
          <button type="button" className="p-1 text-port-accent hover:text-white disabled:opacity-30" disabled={actionsBusy} onClick={() => onRun(job)} aria-label={`Run step ${index + 1} now`} title="Run this job now, ignoring the reset window"><Play size={14} /></button>
          {armed ? (
            <>
              <button type="button" className="p-1 text-red-400 hover:text-red-300" onClick={() => onRemove(index)} aria-label={`Confirm removing step ${index + 1}`} title="Click to confirm — this discards the job's prompt"><Check size={14} /></button>
              <button type="button" className="text-[11px] text-gray-400 hover:text-white px-1" onClick={() => setArmed(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="p-1 text-red-400 hover:text-red-300 disabled:opacity-30" onClick={() => setArmed(true)} aria-label={`Remove step ${index + 1}`}><Trash2 size={14} /></button>
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
            onChange={(event) => onChange({ ...job, jobType: event.target.value, params: {} })}
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

      {spec?.description && <p className="text-[11px] text-gray-500">{spec.description}</p>}
      {pending && (
        <p className={`text-[11px] ${pending.count > 0 ? 'text-emerald-400' : 'text-gray-500'}`}>
          {pending.count > 0 ? `Ready — ${pending.detail}` : `Idle — ${pending.detail}`}
        </p>
      )}
    </div>
  );
}
