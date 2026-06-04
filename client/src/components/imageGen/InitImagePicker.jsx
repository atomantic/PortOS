// Single init / source image uploader for the Image Gen page (local mflux/Flux
// image-to-image, plus edit-only models like Qwen-Image-Edit which require a
// source). The caller owns the `initImage` object — `{ source, file, name,
// previewUrl }` — and the 0..1 `strength`; this component only renders the
// thumbnail + clear button + strength slider and a drop-target label when
// empty. `onPick` receives the raw file-input change event so the caller can
// run EXIF orientation normalization before storing the File.
//
// `editOnly` flips the label copy/styling: edit-only models need a source
// image (shown as a required warning), regular i2i is optional.

import { Image as ImageIcon, X } from 'lucide-react';

export default function InitImagePicker({
  initImage,
  initImageStrength,
  onStrengthChange,
  onPick,
  onClear,
  editOnly = false,
  disabled = false,
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1">
        {editOnly ? 'Source image' : 'Init image'}{' '}
        <span className={`font-normal ${editOnly ? 'text-port-warning' : 'text-gray-500'}`}>
          {editOnly ? '(required — this model edits an existing image)' : '(image-to-image — Flux only)'}
        </span>
      </label>
      {initImage.previewUrl ? (
        <div className="flex items-start gap-3">
          <div className="relative shrink-0">
            <img
              src={initImage.previewUrl}
              alt="Init"
              className="w-16 h-16 object-cover rounded-lg border border-port-border bg-port-bg"
            />
            <button
              type="button"
              onClick={onClear}
              disabled={disabled}
              className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-port-card border border-port-border text-gray-300 hover:text-white hover:bg-port-error/40 flex items-center justify-center disabled:opacity-50"
              aria-label="Remove init image"
              title="Remove init image"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="text-xs text-gray-400 truncate" title={initImage.name}>{initImage.name}</div>
            <label className="block text-[11px] text-gray-500">
              Strength {initImageStrength.toFixed(2)}
              <input
                type="range" min={0} max={1} step={0.05}
                value={initImageStrength}
                disabled={disabled}
                onChange={(e) => onStrengthChange(Number(e.target.value))}
                className="w-full accent-port-accent mt-1"
              />
            </label>
          </div>
        </div>
      ) : (
        <label className="flex items-center justify-center gap-2 w-full px-3 py-2 border border-dashed border-port-border rounded-lg text-xs text-gray-400 hover:text-white hover:border-port-accent cursor-pointer transition-colors">
          <ImageIcon className="w-4 h-4" />
          Upload image to remix (PNG/JPG/WebP)
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onPick} disabled={disabled} />
        </label>
      )}
    </div>
  );
}
