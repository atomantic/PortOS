// Shared "preset dropdown + custom W×H" resolution control for the image and
// video generators. Both pages drive the same UX off their own preset tables
// (RESOLUTIONS / VIDEO_RESOLUTIONS): a <select> of presets plus a "Custom…"
// sentinel option that reveals gated Width/Height inputs, with a blur-snap that
// clamps each edge to the runner's [min, max] bounds and (when step > 1) snaps
// it down to the nearest multiple of `step`.
//
// Renders as a fragment of sibling FormFields (Resolution, then optionally
// Width + Height + a note) so it slots directly into the caller's field grid —
// the parent supplies the grid; this owns only the resolution cells.
//
// Consumers:
//   - client/src/components/imageGen/ImageGenControls.jsx (image)
//   - client/src/pages/VideoGen.jsx (video)

import { useState, useEffect } from 'react';
import { FormField } from '../ui/FormField';
import {
  resolveResolutionLabel, clampImageEdge, CUSTOM_RESOLUTION_VALUE, MAX_IMAGE_EDGE,
} from '../../lib/imageGenResolutions';

const DEFAULT_INPUT_CLS = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50';

export default function ResolutionField({
  presets = [],
  width, height, onChange,
  // Per-edge bounds mirroring the server: image = [64, 3840] step 8, video =
  // [64, 2048] step 64. `step` sets the number-input spinner increment.
  min = 64, max = MAX_IMAGE_EDGE, step = 8,
  // Whether the blur handler snaps each edge DOWN to a multiple of `step`.
  // Video opts in because the server floors both dims to 64 — showing the
  // floored value up front is honest. Image leaves it off: its route accepts
  // any integer edge (imageEdgeSchema), so a hand-typed 705 must stay 705.
  snapOnBlur = false,
  // When set, shows a total-pixel-cap warning + note (image only). Omit for
  // video, whose per-tier budget is enforced elsewhere.
  maxPixels = null,
  disabled = false,
  inputClassName = DEFAULT_INPUT_CLS,
  labelClassName = 'block text-xs font-medium text-gray-400 mb-1',
  // Override the (non-error) helper note; defaults to a bounds-derived string.
  note,
}) {
  const { matched } = resolveResolutionLabel(presets, width, height);
  // Custom mode is sticky once opened (so a preset-matching size the user is
  // mid-edit doesn't snap the dropdown back to a preset) and also auto-engages
  // whenever the current dimensions match no preset (remix, uploaded photo, a
  // stale off-backend size) so the inputs appear without an extra click.
  const [customOpen, setCustomOpen] = useState(false);
  const isCustom = customOpen || (!matched && !!width && !!height);
  const selectValue = isCustom ? CUSTOM_RESOLUTION_VALUE : (matched?.label ?? '');
  // Latch custom mode stickily once a non-preset size appears. Without this,
  // clearing a Width/Height field to a transient 0 mid-edit would flip
  // `!matched && width && height` false and unmount the inputs the user is
  // typing into — which also skips the blur-snap.
  useEffect(() => {
    if (!matched && width && height) setCustomOpen(true);
  }, [matched, width, height]);

  // Clamp always enforces [min, max]; step-snapping is opt-in per snapOnBlur.
  const bounds = snapOnBlur ? { min, max, step } : { min, max };
  const handleResolution = (e) => {
    if (e.target.value === CUSTOM_RESOLUTION_VALUE) { setCustomOpen(true); return; }
    const r = presets.find((opt) => opt.label === e.target.value);
    if (r) { setCustomOpen(false); onChange?.(r.w, r.h); }
  };
  // Live edits pass through raw so typing feels natural (0 = mid-edit/empty);
  // the blur handler clamps + snaps to the runner's bounds.
  const handleCustomDim = (axis, raw) => {
    const n = Math.floor(Number(raw));
    const v = n > 0 ? Math.min(max, n) : 0;
    if (axis === 'w') onChange?.(v, height || 0);
    else onChange?.(width || 0, v);
  };
  const snapCustomDim = (axis) => {
    if (axis === 'w') onChange?.(clampImageEdge(width, bounds), height || 0);
    else onChange?.(width || 0, clampImageEdge(height, bounds));
  };
  const pixelCount = (width || 0) * (height || 0);
  const overPixelCap = maxPixels != null && pixelCount > maxPixels;
  const defaultNote = `Each edge ${min}–${max}px${maxPixels != null ? `, total ≤ ${maxPixels.toLocaleString()} px` : ''}. Multiples of ${step} render best on local models.`;

  return (
    <>
      <FormField label="Resolution" labelClassName={labelClassName}>
        <select
          value={selectValue}
          onChange={handleResolution}
          disabled={disabled}
          className={inputClassName}
        >
          {presets.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
          <option value={CUSTOM_RESOLUTION_VALUE}>Custom…</option>
        </select>
      </FormField>

      {isCustom && (
        <>
          <FormField label="Width" labelClassName={labelClassName}>
            <input
              type="number" min={min} max={max} step={step}
              value={width || ''}
              onChange={(e) => handleCustomDim('w', e.target.value)}
              onBlur={() => snapCustomDim('w')}
              disabled={disabled}
              className={inputClassName}
            />
          </FormField>
          <FormField label="Height" labelClassName={labelClassName}>
            <input
              type="number" min={min} max={max} step={step}
              value={height || ''}
              onChange={(e) => handleCustomDim('h', e.target.value)}
              onBlur={() => snapCustomDim('h')}
              disabled={disabled}
              className={inputClassName}
            />
          </FormField>
          <p className={`col-span-full text-[10px] -mt-1 ${overPixelCap ? 'text-port-error' : 'text-gray-500'}`}>
            {overPixelCap
              ? `Too large — ${pixelCount.toLocaleString()} px exceeds the ${maxPixels.toLocaleString()} px cap. Reduce width or height.`
              : (note || defaultNote)}
          </p>
        </>
      )}
    </>
  );
}
