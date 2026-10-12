import { FAL_DEFAULT_IMAGE_VIDEO_MODEL, FAL_IMAGE_VIDEO_MODELS, describeFalVideoRate, getFalVideoModel } from '../../lib/falVideoModels.js';

/**
 * Where one shot's clip renders, picked on its card: the project's saved
 * renderer, local LTX, Grok, or a fal.ai model. LTX is local only, so fal
 * offers only its curated start-frame models; a lip-synced or music-driven
 * shot renders on fal's source-audio route, so fal is one choice there, and
 * Grok (no audio) renders cutaways only.
 * The pick is a value string: '' (saved), 'local', 'grok', 'fal' or 'fal:<modelId>'.
 */
const BACKEND_LABELS = { local: 'Local LTX', grok: 'Grok', fal: 'fal.ai' };

function savedLabel(saved) {
  if (saved.backend === 'fal') return `fal.ai · ${getFalVideoModel(saved.falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL)?.label || 'video'}`;
  return BACKEND_LABELS[saved.backend] || 'install default';
}

export function renderTargetOptions({ performance, saved }) {
  return [
    { value: '', label: `Project setting · ${savedLabel(saved)}` },
    { value: 'local', label: performance ? 'Local LTX-2.5 lip-sync (free)' : 'Local LTX' },
    { value: 'grok', label: performance ? 'Grok (cutaways only)' : 'Grok', disabled: performance },
    ...(performance
      ? [{ value: 'fal', label: 'fal.ai (song-driven)' }]
      : FAL_IMAGE_VIDEO_MODELS.map((model) => {
        const rate = describeFalVideoRate(model.id);
        return { value: `fal:${model.id}`, label: `fal.ai · ${model.label}${rate ? ` · ${rate}` : ''}` };
      })),
  ];
}

/** The settings overrides a pick makes for this render, or null for the project's saved renderer. */
export function renderTargetOverrides(value, saved) {
  if (!value) return null;
  if (!value.startsWith('fal')) return { backend: value };
  const falModelId = value.slice(4) || null;
  if (!falModelId) return { backend: 'fal' };
  // Each model has its own resolutions, so the saved one only carries over to the saved model.
  const sameModel = falModelId === (saved.falModelId || FAL_DEFAULT_IMAGE_VIDEO_MODEL);
  // A picked model is the one this render uses, end frame or not.
  return { backend: 'fal', falModelId, falEndFrameModelId: falModelId, ...(sameModel ? {} : { falResolution: null, falDuration: null }) };
}

export default function SceneRenderTarget({ id, value, onChange, performance, saved, disabled = false }) {
  return (
    <>
      <label htmlFor={id} className="text-xs">Render on</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
        title="Where this shot's clip renders. Only this shot; the project setting stays as it is."
        className="min-w-0 max-w-full flex-1 basis-48 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 sm:flex-none disabled:opacity-50">
        {renderTargetOptions({ performance, saved }).map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    </>
  );
}
