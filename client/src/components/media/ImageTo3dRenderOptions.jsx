import FormField from '../ui/FormField';
import {
  ALPHA_MODE_PRESETS, DETAIL_PRESETS, SEED_MAX, STEPS_PRESETS,
} from '../../lib/imageTo3dRenderOptions';

// Per-run sampler knobs for image-to-3D generation, shared by the /3d
// workspace and the /3d/:id detail page. Controlled, with per-field props
// (the documented convention for knob grids — see ImageGenControls.jsx).
// Image-to-3D-specific by design: the presets bake in TRELLIS.2's 12-step
// default and the keying toggle has no analogue in image/video gen.
//
// Not every target honors every knob — Pixal3D's upstream CLI has no per-phase step
// override — so `stepsSupported={false}` disables the Quality control and says why,
// rather than offering a setting the runner silently drops. `detailSupported` and
// `alphaModeSupported` do the same for the other two: the TRELLIS.2 CUDA lane takes
// no pipeline-type override at all, and Pixal3D derives its resolution from VRAM
// (overriding it could hand a small card a config that OOMs mid-render).
//
// Detail and Transparency sit on their own row above the sampler knobs because they
// change what gets built, while steps/seed/keying change how it is sampled.
//
// Value conventions (see lib/imageTo3dRenderOptions.js for the body mapping):
//  - steps: '' = pipeline default, else a preset number string.
//  - seed:  '' = a fresh random seed every render; a value pins this run.
//  - keyBackground: key a solid-color backdrop to transparency before render.
//    Off by default: writing an alpha channel makes the pipeline SKIP its own
//    learned matte, so keying is a downgrade on anything but a flat chroma backdrop.
//  - detail: 'auto' = derive the pipeline tier from hardware, else a named tier.
//  - alphaMode: '' = leave PortOS's force-opaque normalization on (the default);
//    any explicit value turns it off so a transparent subject can stay transparent.

const FIELD_LABEL_CLASS = 'mb-1 block text-xs text-gray-400';
const FIELD_INPUT_CLASS = 'w-full rounded-md border border-port-border bg-port-bg px-2 py-1.5 text-xs text-gray-200 disabled:opacity-40';

export default function ImageTo3dRenderOptions({
  steps,
  onStepsChange,
  seed,
  onSeedChange,
  keyBackground,
  onKeyBackgroundChange,
  detail = 'auto',
  onDetailChange,
  alphaMode = '',
  onAlphaModeChange,
  normalMap = true,
  onNormalMapChange,
  disabled = false,
  stepsSupported = true,
  detailSupported = true,
  alphaModeSupported = true,
  normalMapSupported = true,
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Detail"
          labelClassName={FIELD_LABEL_CLASS}
          hint={detailSupported
            ? undefined
            : 'This model picks its own resolution from your hardware'}
        >
          <select
            id="image-to-3d-detail"
            value={detailSupported ? detail : 'auto'}
            onChange={(e) => onDetailChange(e.target.value)}
            disabled={disabled || !detailSupported}
            className={FIELD_INPUT_CLASS}
          >
            {DETAIL_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>{preset.label}</option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Transparency"
          labelClassName={FIELD_LABEL_CLASS}
          hint={alphaModeSupported
            ? undefined
            : 'This model always exports a solid material'}
        >
          <select
            id="image-to-3d-alpha-mode"
            value={alphaModeSupported ? alphaMode : ''}
            onChange={(e) => onAlphaModeChange(e.target.value)}
            disabled={disabled || !alphaModeSupported}
            className={FIELD_INPUT_CLASS}
          >
            {ALPHA_MODE_PRESETS.map((preset) => (
              <option key={preset.value || 'default'} value={preset.value}>{preset.label}</option>
            ))}
          </select>
        </FormField>
      </div>
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
          <div className="flex flex-col gap-1.5">
            {/* Opt-in, not default-on. Handing the pipeline an alpha channel makes it
                skip its own learned matte, and a border flood fill can't remove a cast
                shadow — which then becomes geometry. Only a flat chroma backdrop is
                better keyed deterministically than matted. */}
            <label
              htmlFor="image-to-3d-key-background"
              className="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-300"
              title="For a source on a flat chroma backdrop (green/blue screen), where a deterministic key beats automatic matting. Leave off otherwise: keying replaces the model's own background removal, and a flood fill can't remove a cast shadow — which then gets built as geometry."
            >
              <input
                id="image-to-3d-key-background"
                type="checkbox"
                checked={keyBackground}
                onChange={(e) => onKeyBackgroundChange(e.target.checked)}
                disabled={disabled}
                className="h-3.5 w-3.5 rounded border-port-border bg-port-bg accent-port-accent disabled:opacity-40"
              />
              Key out flat backdrop
            </label>
            {/* Opt-in, not default-on. It recovers shading detail the decimation
                discards, but the bake runs before the GLB is written and builds a BVH
                over a mesh larger than its dependency's tests cover — a hard crash
                there (segfault / OOM / GPU watchdog) loses the whole render, which no
                Python guard can catch. */}
            <label
              htmlFor="image-to-3d-normal-map"
              className="inline-flex cursor-pointer items-center gap-2 text-xs text-gray-300"
              title={normalMapSupported
                ? 'Recover shading detail the decimation discards, by baking a normal map from the full-resolution mesh. Adds time, and on a very large mesh can crash the render outright — retry without it if a render dies during texture baking.'
                : 'This model does not bake a normal map'}
            >
              <input
                id="image-to-3d-normal-map"
                type="checkbox"
                checked={normalMapSupported ? normalMap : false}
                onChange={(e) => onNormalMapChange(e.target.checked)}
                disabled={disabled || !normalMapSupported}
                className="h-3.5 w-3.5 rounded border-port-border bg-port-bg accent-port-accent disabled:opacity-40"
              />
              Bake normal map
            </label>
          </div>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-gray-500">
        <span className="font-medium text-gray-400">Best source images:</span> one subject,
        front or ¾ view, filling the frame, with no parts hidden behind others (tails, wings,
        props) — the model has to guess anything it can’t see. A transparent PNG is used as-is;
        anything else is background-removed by the model itself, which also drops cast shadows.
        Only turn on keying for a flat chroma backdrop — it replaces that automatic removal,
        and a cast shadow it leaves behind gets built as geometry.
      </p>
    </div>
  );
}
