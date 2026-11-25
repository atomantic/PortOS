import { useState, useEffect } from 'react';
import { RotateCw } from 'lucide-react';
import { FormField } from '../ui/FormField';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import ModelSelect from '../ModelSelect';
import ImageGenControls from '../imageGen/ImageGenControls';
import ImageModelField, { imageModeHasModel } from '../imageGen/ImageModelField';
import useLocalImageModels from '../../hooks/useLocalImageModels';
import {
  IMAGE_GEN_MODE, CODEX_IMAGEGEN_DEFAULT_EFFORT, localModelSelectOptions, modeLabel,
} from '../../lib/imageGenBackends';
import { effortLevelsForProvider } from '../../utils/providers';
import {
  EFFORT_DEFAULT_OPTION, buildImageRetryOverrides, codexEffortOf, imageRetryModelKey, originalImageModel,
} from './retryOverrides';

const LABEL_CLS = 'block text-xs font-medium text-gray-400 mb-1';
const INPUT_CLS = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

// Inline form for the Edit-and-retry flow of an image job. The knob grid is the
// Image Gen compose grid (ImageGenControls) and the model control is the shared
// per-backend picker, exactly as VideoRetryForm reuses the video compose
// controls: every bound, gate and picker compose has applies here without being
// re-derived. Only the keys the user changed are submitted; unchanged fields stay
// out of the patch so the original job's values ride through. `noValidate`: the
// compose inputs' native min/max/step would otherwise block a prompt-only retry of
// a stored job whose size, steps or guidance sit outside the compose ranges; the
// retry route validates every value that is actually sent.
export default function EditRetryForm({ job, onSubmit, onCancel }) {
  const p = job.params || {};
  const isCodex = p.mode === IMAGE_GEN_MODE.CODEX;
  const isLocal = p.mode === IMAGE_GEN_MODE.LOCAL;
  const modelKey = imageRetryModelKey(p.mode);
  const { models, failed: modelsFailed } = useLocalImageModels(isLocal);
  const [prompt, setPrompt] = useState(p.prompt || '');
  const [negativePrompt, setNegativePrompt] = useState(p.negativePrompt || '');
  const [model, setModel] = useState(originalImageModel(p));
  const [width, setWidth] = useState(p.width ?? '');
  const [height, setHeight] = useState(p.height ?? '');
  const [seed, setSeed] = useState(p.seed ?? '');
  const [steps, setSteps] = useState(p.steps ?? '');
  const [guidance, setGuidance] = useState(p.guidance ?? '');
  const originalEffort = codexEffortOf(p.effort) || EFFORT_DEFAULT_OPTION;
  const [effort, setEffort] = useState(originalEffort);
  // Codex's ladder is MODEL-gated: the gpt-6 family has no `minimal` rung and
  // rejects it with an HTTP 400. An empty override means the shipped default
  // model, whose ladder is the unrestricted one.
  const codexEffortLevels = effortLevelsForProvider({ id: 'codex', command: 'codex' }, model.trim());
  // `effort` only changes on a direct <select> interaction, so a model change to
  // a narrower ladder would leave a stale out-of-ladder level selected.
  useEffect(() => {
    if (effort !== EFFORT_DEFAULT_OPTION && !codexEffortLevels.includes(effort)) {
      setEffort(EFFORT_DEFAULT_OPTION);
    }
  }, [codexEffortLevels, effort]);

  const stepsLocked = isLocal && models?.find((m) => m.id === model)?.samplerLocked === true;

  const submit = (e) => {
    e.preventDefault();
    onSubmit(buildImageRetryOverrides({
      prompt, negativePrompt, model, width, height, seed, steps, guidance, effort, stepsLocked,
    }, p));
  };

  const catalog = isLocal && models?.length > 0 ? localModelSelectOptions(models, model).options : null;
  const modelLabel = isLocal || modelKey === 'modelId' ? 'Model id' : `${modeLabel(p.mode)} model`;

  return (
    <form onSubmit={submit} noValidate className="mt-3 pt-3 border-t border-port-border space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FormField label="Prompt" labelClassName={LABEL_CLS}>
          <AutoSizeTextarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white min-h-[80px]"
            maxLength={8000}
          />
        </FormField>
        <FormField label="Negative prompt" labelClassName={LABEL_CLS}>
          <AutoSizeTextarea
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            rows={3}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white min-h-[80px]"
            maxLength={8000}
          />
        </FormField>
      </div>
      {isLocal && (
        <FormField label={modelLabel} labelClassName={LABEL_CLS}>
          {catalog ? (
            <ModelSelect models={catalog} value={model} onChange={(e) => setModel(e.target.value)} getLabel={(m) => m.name || m.id} />
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={models === null && !modelsFailed}
              placeholder="e.g. z-image-turbo-bf16"
              className={INPUT_CLS}
              maxLength={200}
            />
          )}
        </FormField>
      )}
      {!isLocal && modelKey === 'model' && imageModeHasModel(p.mode, { showLocal: false }) && (
        <FormField label={modelLabel} labelClassName={LABEL_CLS}>
          {/* An empty retry override keeps the job's own model, so the empty
              option reads "Unchanged" rather than a Settings default. */}
          <ImageModelField
            mode={p.mode} value={model || null} onChange={(next) => setModel(next || '')}
            commit="change" falDefaultLabel="Unchanged" ariaLabel={modelLabel} className={INPUT_CLS}
          />
        </FormField>
      )}
      {!isLocal && modelKey === 'modelId' && (
        <FormField label={modelLabel} labelClassName={LABEL_CLS}>
          <input
            type="text" value={model} onChange={(e) => setModel(e.target.value)}
            className={INPUT_CLS} maxLength={200}
          />
        </FormField>
      )}
      <ImageGenControls
        mode={p.mode}
        models={isLocal ? (models ?? []) : []}
        modelId={isLocal ? model : ''}
        showModel={false}
        showQuantize={false}
        showSeed
        width={width} height={height}
        onResolutionChange={(w, h) => { setWidth(w); setHeight(h); }}
        steps={steps} onStepsChange={setSteps}
        guidance={guidance} onGuidanceChange={setGuidance}
        seed={seed} onSeedChange={setSeed}
      />
      {isCodex && (
        <FormField label="Reasoning effort" labelClassName={LABEL_CLS}>
          {/* No fixed id — FormField wires the label to a useId()-generated id,
              so two retry editors open at once don't collide on one shared id. */}
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            className={INPUT_CLS}
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
