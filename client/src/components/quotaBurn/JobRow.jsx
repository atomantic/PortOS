/**
 * One burn job inside a family's ordered plan: its type, its per-job model, its
 * type-specific params, and the controls that move/remove/run it.
 *
 * Order is meaningful — the runner takes the FIRST enabled job with pending
 * work — so the move controls are part of the configuration, not a convenience.
 */

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, Play, RotateCcw, Trash2 } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import JobParamField from './JobParamField';
import PresetPicker from './PresetPicker';
import EffortSelect from '../cos/EffortSelect';
import { applyQuotaBurnPreset, quotaBurnJobIsSpent } from '../../lib/quotaBurnPatch';
import { timeAgo } from '../../utils/formatters';
import { commandBasename, effortAwareModelOptions, effortLevelsForProvider, effortSurvivingModel } from '../../utils/providers';
import { inputClass } from './fields';

export default function JobRow({
  job, index, total, catalog, pending, ranAt, actionsBusy,
  familyId,
  expanded = false, onToggleExpand,
  onChange, onMove, onRemove, onRun, onRearm,
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = onToggleExpand !== undefined ? expanded : localExpanded;
  const toggleExpand = onToggleExpand || (() => setLocalExpanded((prev) => !prev));

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
  const spent = quotaBurnJobIsSpent(job, ranAt);
  const actionButtonClass = 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center';
  const setParam = (key, value) => onChange({ ...job, params: { ...job.params, [key]: value } });
  const promptText = String(job.params?.prompt || '').trim();
  const hasPromptText = Boolean(promptText);
  // Which preset this row currently IS, derived rather than stored: a preset is
  // copied into `params.prompt` and nothing on disk points back at its id, so
  // matching the text is the only claim that stays true after an edit. The
  // picker shows the preset while the prompt is verbatim and reverts to its
  // placeholder as soon as the user changes a word.
  const matchedPreset = (catalog.presets || [])
    .find((preset) => promptText && String(preset.params?.prompt || '').trim() === promptText);
  const applyPreset = (preset) => { setPendingPreset(null); onChange(applyQuotaBurnPreset(job, preset)); };
  const optionsFor = (descriptor) => ({
    app: catalog.apps,
    universe: catalog.universes,
    imageMode: catalog.imageModes,
  })[descriptor.kind];

  // Resolve the provider for this family/job to provide model options and effort support
  const familyProviders = (catalog.providers || []).filter((provider) =>
    provider?.enabled !== false &&
    provider?.ollamaBacked !== true && provider?.mtplxBacked !== true &&
    provider?.llamaBacked !== true && provider?.vllmBacked !== true &&
    provider?.sglangBacked !== true &&
    (provider?.type === 'cli' || provider?.type === 'tui') &&
    (commandBasename(provider?.command) === familyId ||
     String(provider?.id || '').toLowerCase().includes(familyId || '') ||
     (familyId === 'agy' && String(provider?.id || '').toLowerCase().includes('antigravity')))
  );

  const selectedProvider = (job.providerId && familyProviders.find((p) => p.id === job.providerId))
    || (job.providerId && (catalog.providers || []).find((p) => p.id === job.providerId))
    || familyProviders.find((p) => p.type === (job.jobType === 'agent-prompt' ? 'tui' : 'cli'))
    || familyProviders[0]
    || null;

  const availableModels = selectedProvider ? effortAwareModelOptions(selectedProvider, job.model) : [];
  const effortLevels = selectedProvider ? effortLevelsForProvider(selectedProvider, job.model) : null;
  const showEffort = Boolean(effortLevels && effortLevels.length > 0);

  const handleModelChange = (modelVal) => {
    const nextModel = modelVal || null;
    let nextEffort = job.effort || null;
    if (job.effort && selectedProvider) {
      const surviving = effortSurvivingModel(selectedProvider, nextModel, job.effort);
      nextEffort = surviving || null;
    }
    onChange({ ...job, model: nextModel, effort: nextEffort });
  };

  return (
    // `bg-port-bg`, not `bg-port-bg/40`: a step sits INSIDE the family card, so
    // it reads as a sunken well only if it carries the page color at full
    // strength. At 40% it composited most of the way back to the card fill and
    // eight steps ran together as one undifferentiated block.
    <div className="rounded border border-port-border/70 bg-port-bg p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="p-1 text-gray-400 hover:text-white"
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
          placeholder={spec ? `Step name (defaults to “${spec.label}”)` : 'Step name'}
          aria-label={`Name for step ${index + 1}`}
          onChange={(event) => onChange({ ...job, label: event.target.value })}
        />
        {!isExpanded && (
          <span className="text-xs text-gray-400 truncate max-w-xs">
            {spec?.label || job.jobType}
            {job.model ? ` · ${job.model}` : ''}
            {job.effort ? ` · ${job.effort}` : ''}
            {job.runOnce ? ' · run once' : ''}
          </span>
        )}
        <div className="flex items-center">
          <div className="flex items-center gap-1">
            <button type="button" className={`${actionButtonClass} text-gray-400 hover:text-white disabled:opacity-30`} disabled={index === 0} onClick={() => onMove(index, -1)} aria-label={`Move step ${index + 1} earlier`}><ArrowUp size={14} /></button>
            <button type="button" className={`${actionButtonClass} text-gray-400 hover:text-white disabled:opacity-30`} disabled={index === total - 1} onClick={() => onMove(index, 1)} aria-label={`Move step ${index + 1} later`}><ArrowDown size={14} /></button>
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
                largeTouchTargets
                onConfirm={() => { setRunArmed(false); onRun(job); }}
                onCancel={() => setRunArmed(false)}
              />
            ) : (
              <button type="button" className={`${actionButtonClass} text-port-accent hover:text-white disabled:opacity-30`} disabled={actionsBusy} onClick={() => { setArmed(false); setRunArmed(true); }} aria-label={`Run step ${index + 1} now`} title="Run this job now, ignoring the reset window (asks to confirm)"><Play size={14} /></button>
            )}
          </div>
          <div className="ml-2 border-l border-port-border/50 pl-2">
            {armed ? (
              <ConfirmButtonPair
                prompt="Discards its prompt."
                confirmText="Delete"
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

      {isExpanded && (
        <>
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
              <select
                id={`${idPrefix}-model`}
                className={inputClass}
                value={job.model || ''}
                onChange={(event) => handleModelChange(event.target.value)}
              >
                <option value="">Default model</option>
                {availableModels.map((m) => {
                  const val = typeof m === 'string' ? m : m.id;
                  const lbl = typeof m === 'string' ? m : (m.name || m.id);
                  return <option key={val} value={val}>{lbl}</option>;
                })}
                {job.model && !availableModels.some((m) => (typeof m === 'string' ? m : m.id) === job.model) && (
                  <option value={job.model}>{job.model}</option>
                )}
              </select>
            </label>
            {showEffort && (
              <label htmlFor={`${idPrefix}-effort`} className="block text-xs text-gray-400">
                Thinking effort (optional)
                <EffortSelect
                  id={`${idPrefix}-effort`}
                  provider={selectedProvider}
                  model={job.model}
                  value={job.effort || ''}
                  onChange={(effort) => onChange({ ...job, effort: effort || null })}
                  className={inputClass}
                />
              </label>
            )}
            {/* The repeat/one-shot choice. The plan is a rotation the runner walks
                lap after lap while the window still has quota, which is right for a
                standing audit and wrong for work that only needs doing once — that
                was simply re-done every lap. */}
            <div className="text-xs text-gray-400">
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
              value={matchedPreset?.id || ''}
              // Re-picking the preset the row already matches is a no-op, so it
              // needs no "replace your text?" confirm — the text IS the preset's.
              onPick={(preset) => (hasPromptText && preset.id !== matchedPreset?.id
                ? setPendingPreset(preset)
                : applyPreset(preset))}
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
