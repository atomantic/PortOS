// FLUX.2 multi-reference uploader — up to 4 fixed, positional slots, each
// carrying an uploaded File + a 0..1 strength weight. The caller owns the
// `referenceImages` array (`[{ file, previewUrl, strength }]`) and the slot
// mutations; this component only renders the grid of thumbnails / Add tiles /
// strength sliders.
//
// References are conditioned via diffusers' Flux2KleinKVPipeline (K/V-cache
// reference-token attention). First-time use prompts the user to accept the
// FLUX.2-klein-9B-kv license on Hugging Face. Per-reference strengths are
// honored end-to-end: scripts/flux2_macos.py patches Flux2KVLayerCache.store +
// _flux2_kv_causal_attention so each reference's V slice is scaled by its
// strength (1.0 = full influence, 0.0 = ignored).
//
// `onPick(slotIndex, event)` receives the raw file-input change event so the
// caller can run EXIF orientation normalization before storing the File.

import { Image as ImageIcon, X } from 'lucide-react';

export default function ReferenceImagePicker({
  referenceImages = [],
  onPick,
  onClear,
  onStrengthChange,
  disabled = false,
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1">
        Reference images <span className="text-gray-500 font-normal">(up to 4 images for FLUX.2 multi-reference edit)</span>
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {referenceImages.map((slot, i) => {
          const slotId = `ref-image-${i}`;
          const strengthId = `ref-strength-${i}`;
          return (
            <div key={i} className="flex flex-col gap-1 p-2 rounded-lg border border-port-border bg-port-bg/30">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Ref {i + 1}</div>
              {slot.previewUrl ? (
                <>
                  <div className="relative">
                    <img
                      src={slot.previewUrl}
                      alt={`Reference ${i + 1}`}
                      className="w-full h-16 object-cover rounded border border-port-border bg-port-bg"
                    />
                    <button
                      type="button"
                      onClick={() => onClear(i)}
                      disabled={disabled}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-port-card border border-port-border text-gray-300 hover:text-white hover:bg-port-error/40 flex items-center justify-center disabled:opacity-50"
                      aria-label={`Remove reference ${i + 1}`}
                      title={`Remove reference ${i + 1}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <label htmlFor={strengthId} className="block text-[10px] text-gray-500">
                    Strength {slot.strength.toFixed(2)}
                  </label>
                  <input
                    id={strengthId}
                    type="range" min={0} max={1} step={0.05}
                    value={slot.strength}
                    disabled={disabled}
                    onChange={(e) => onStrengthChange(i, Number(e.target.value))}
                    className="w-full accent-port-accent"
                  />
                </>
              ) : (
                <label
                  htmlFor={slotId}
                  className="flex flex-col items-center justify-center gap-1 h-[88px] border border-dashed border-port-border rounded text-[10px] text-gray-500 hover:text-white hover:border-port-accent cursor-pointer transition-colors"
                >
                  <ImageIcon className="w-4 h-4" />
                  Add
                  <input
                    id={slotId}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => onPick(i, e)}
                    disabled={disabled}
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
