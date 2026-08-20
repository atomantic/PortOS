import FormField from '../ui/FormField';
import { SEED_MAX, STEPS_PRESETS } from '../../lib/imageTo3dRenderOptions';

// Per-run sampler knobs for image-to-3D generation, shared by the /3d
// workspace and the /3d/:id detail page. Controlled, with per-field props
// (the documented convention for knob grids — see ImageGenControls.jsx).
// Image-to-3D-specific by design: the presets bake in TRELLIS.2's 12-step
// default and the keying toggle has no analogue in image/video gen.
//
// Not every target honors every knob — Pixal3D's upstream CLI has no per-phase step
// override — so `stepsSupported={false}` disables the Quality control and says why,
// rather than offering a setting the runner silently drops.
//
// Value conventions (see lib/imageTo3dRenderOptions.js for the body mapping):
//  - steps: '' = pipeline default, else a preset number string.
//  - seed:  '' = a fresh random seed every render; a value pins this run.
//  - keyBackground: key a solid-color backdrop to transparency before render.

const FIELD_LABEL_CLASS = 'mb-1 block text-xs text-gray-400';
const FIELD_INPUT_CLASS = 'w-full rounded-md border border-port-border bg-port-bg px-2 py-1.5 text-xs text-gray-200 disabled:opacity-40';

export default function ImageTo3dRenderOptions({
  steps,
  onStepsChange,
  seed,
  onSeedChange,
  keyBackground,
  onKeyBackgroundChange,
  disabled = false,
  stepsSupported = true,
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField
          label="Quality"
          labelClassName={FIELD_LABEL_CLASS}
          hint={stepsSupported ? undefined : 'This model has no step control'}
        >
          <select
            value={stepsSupported ? steps : ''}
            onChange={(e) => onStepsChange(e.target.value)}
            disabled={disabled || !stepsSupported}
            className={FIELD_INPUT_CLASS}
          >
            {STEPS_PRESETS.map((preset) => (
              <option key={preset.value || 'default'} value={preset.value}>{preset.label}</option>
            ))}
            {/* A run can carry a non-preset steps value (set via the API) — surface it
                rather than silently snapping the select to the default. */}
            {steps !== '' && !STEPS_PRESETS.some((preset) => preset.value === steps) && (
              <option value={steps}>{`Custom (${steps} steps)`}</option>
            )}
          </select>
        </FormField>
        <FormField label="Seed" labelClassName={FIELD_LABEL_CLASS}>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={SEED_MAX}
            step={1}
            value={seed}
            onChange={(e) => onSeedChange(e.target.value)}
            placeholder="Random each render"
            disabled={disabled}
            className={`${FIELD_INPUT_CLASS} placeholder:text-gray-600`}
          />
        </FormField>
        <div className="flex items-end pb-1.5">
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-300">
            <input
              type="checkbox"
              checked={keyBackground}
              onChange={(e) => onKeyBackgroundChange(e.target.checked)}
              disabled={disabled}
              className="h-3.5 w-3.5 rounded border-port-border bg-port-bg accent-port-accent disabled:opacity-40"
            />
            Key out solid background
          </label>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-gray-500">
        <span className="font-medium text-gray-400">Best source images:</span> one subject,
        front or ¾ view, filling the frame, with no parts hidden behind others (tails, wings,
        props) — the model has to guess anything it can’t see. A transparent PNG is used as-is;
        a solid-color backdrop is keyed out automatically when enabled here; busy backgrounds
        fall back to automatic matting, which can leave soft edges.
      </p>
    </div>
  );
}
