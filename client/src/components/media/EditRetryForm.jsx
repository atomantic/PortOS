import { useState, useEffect } from 'react';
import { RotateCw } from 'lucide-react';
import { FormField } from '../ui/FormField';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import { IMAGE_GEN_MODE, CODEX_IMAGEGEN_DEFAULT_EFFORT, supportsCloudModelOverride, modeLabel } from '../../lib/imageGenBackends';
import { effortLevelsForProvider, isConfiguredDefaultModel } from '../../utils/providers';
import { codexEffortOf, textChanged, numberChanged } from './retryOverrides';

// Clear-to-default sentinel for the Codex reasoning-effort control — mirrors the
// server's EFFORT_CLEAR_SENTINEL in routes/mediaJobs.js. A job with no explicit
// effort is "using the shipped default", represented in the <select> by this value;
// submitting it against a job that HAD an explicit effort tells the server to reset
// to the default (drop params.effort).
const EFFORT_DEFAULT_OPTION = 'default';

// Inline form for the Edit-and-retry flow. Shows the fields the server's
// retry override schema accepts (prompt, negative, model, dimensions, steps, effort)
// and submits only the keys the user actually changed — leaving unchanged
// fields out of the patch so the original job's values ride through.
export default function EditRetryForm({ job, onSubmit, onCancel }) {
  const p = job.params || {};
  const isCodex = p.mode === IMAGE_GEN_MODE.CODEX;
  // Codex and Agy both run under a CLI model id carried on `params.model`;
  // local jobs use `params.modelId` (a PortOS image-model registry id). Binding
  // an Agy retry to `modelId` would edit a field its provider never reads AND
  // leave the actual model unchangeable, so the field follows `params.model`
  // for every backend that takes a CLI model — the same capability list the
  // gen form's override picker is gated on.
  const usesCliModel = supportsCloudModelOverride(p.mode);
  const [prompt, setPrompt] = useState(p.prompt || '');
  const [negativePrompt, setNegativePrompt] = useState(p.negativePrompt || '');
  // A configured-default sentinel means "let the CLI's own config pick" — display
  // it as an empty field so the "leave empty for default" placeholder is honest.
  // The submit comparison below uses this same blanked value, not the raw
  // `p.model`: otherwise an untouched sentinel field reads as an edit and
  // submits `model: ''` on every retry.
  const originalModel = isConfiguredDefaultModel(p.model) ? '' : (p.model || '');
  const [model, setModel] = useState(originalModel);
  const [modelId, setModelId] = useState(p.modelId || '');
  const [width, setWidth] = useState(p.width ?? '');
  const [height, setHeight] = useState(p.height ?? '');
  const [steps, setSteps] = useState(p.steps ?? '');
  // The job's stored effort (a codex effort level) or the "default" option
  // when it carried none. On submit we only send `effort` when this differs from
  // the original — the sentinel resets to default, a level pins that level.
  const originalEffort = codexEffortOf(p.effort) || EFFORT_DEFAULT_OPTION;
  const [effort, setEffort] = useState(originalEffort);
  // Codex's ladder is MODEL-gated, so the options track the model field above:
  // the gpt-6 family has no `minimal` rung and rejects it with an HTTP 400,
  // failing the retry. An empty override means the shipped default model, whose
  // ladder is the unrestricted one.
  const codexEffortLevels = effortLevelsForProvider({ id: 'codex', command: 'codex' }, model.trim());
  // The ladder is MODEL-gated (comment above), but `effort` only changes on a
  // direct <select> interaction — retyping `model` to a narrower ladder (e.g.
  // gpt-6, which drops `minimal`) left a stale out-of-ladder level selected,
  // so submit still sent it and the server 400ed. Reconcile on every ladder
  // change, not just on model's own onChange, since model is free-typed text.
  useEffect(() => {
    if (effort !== EFFORT_DEFAULT_OPTION && !codexEffortLevels.includes(effort)) {
      setEffort(EFFORT_DEFAULT_OPTION);
    }
  }, [codexEffortLevels, effort]);

  const submit = (e) => {
    e.preventDefault();
    const overrides = {};
    if (textChanged(prompt, p.prompt) && prompt.trim()) overrides.prompt = prompt.trim();
    if (textChanged(negativePrompt, p.negativePrompt)) overrides.negativePrompt = negativePrompt.trim();
    if (usesCliModel && textChanged(model, originalModel)) overrides.model = model.trim();
    if (!usesCliModel && textChanged(modelId, p.modelId)) overrides.modelId = modelId.trim();
    if (numberChanged(width, p.width) && width !== '') overrides.width = Number(width);
    if (numberChanged(height, p.height) && height !== '') overrides.height = Number(height);
    if (numberChanged(steps, p.steps) && steps !== '') overrides.steps = Number(steps);
    // Codex-only: send effort only when changed. The sentinel ('default') resets
    // to the shipped default; a concrete level pins the retry to that level.
    if (isCodex && effort !== originalEffort) overrides.effort = effort;
    onSubmit(Object.keys(overrides).length ? overrides : null);
  };

  return (
    <form onSubmit={submit} className="mt-3 pt-3 border-t border-port-border space-y-2">
      <FormField label="Prompt" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
        <AutoSizeTextarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs min-h-[60px]"
          maxLength={8000}
        />
      </FormField>
      <FormField label="Negative prompt" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
        <AutoSizeTextarea
          value={negativePrompt}
          onChange={(e) => setNegativePrompt(e.target.value)}
          rows={2}
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs min-h-[44px]"
          maxLength={8000}
        />
      </FormField>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {/* 'Codex model' / 'Agy model' come from the shared backend META rather
            than a per-backend ternary ladder — a new CLI backend gets the right
            label from its registry entry alone. */}
        <FormField className="col-span-2" label={usesCliModel ? `${modeLabel(p.mode)} model` : 'Model id'} labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          <input
            type="text"
            value={usesCliModel ? model : modelId}
            onChange={(e) => (usesCliModel ? setModel(e.target.value) : setModelId(e.target.value))}
            placeholder={usesCliModel ? 'leave empty for default' : 'e.g. z-image-turbo-bf16'}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
            maxLength={200}
          />
        </FormField>
        <FormField label="Width" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          <input
            type="number" min={64} max={4096} step={8}
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </FormField>
        <FormField label="Height" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          <input
            type="number" min={64} max={4096} step={8}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </FormField>
        <FormField label="Steps" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          <input
            type="number" min={1} max={200} step={1}
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          />
        </FormField>
      </div>
      {isCodex && (
        <FormField label="Reasoning effort" labelClassName="block text-[10px] uppercase tracking-wide text-port-text-muted">
          {/* No fixed id — FormField wires the label to a useId()-generated id,
              so two retry editors open at once don't collide on one shared id. */}
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
          >
            <option value={EFFORT_DEFAULT_OPTION}>Default ({CODEX_IMAGEGEN_DEFAULT_EFFORT})</option>
            {codexEffortLevels.map((lvl) => (
              <option key={lvl} value={lvl}>{lvl}</option>
            ))}
          </select>
        </FormField>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 text-xs text-port-text-muted hover:text-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="inline-flex items-center gap-1 px-3 py-1 bg-port-accent text-white text-xs rounded hover:bg-port-accent/90"
        >
          <RotateCw className="w-3 h-3" />
          Retry with changes
        </button>
      </div>
    </form>
  );
}
