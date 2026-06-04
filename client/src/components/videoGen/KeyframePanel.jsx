/**
 * Multi-keyframe FFLF picker (LTX-2 / ltx2 runtime only). The user anchors
 * 2–8 gallery images at specific pixel-frame indices and the model
 * interpolates between them.
 *
 * Presentational — keyframe state, mutators, validation error, and the
 * visible-gallery list are owned by the VideoGen page and passed in. Only
 * rendered when the selected model supports keyframes (mode === 'fflf' &&
 * keyframesSupported); the parent gates that.
 */
import { X, ListPlus } from 'lucide-react';
import ImagePreview from './ImagePreview';

export default function KeyframePanel({
  keyframesMode,
  keyframesActive,
  keyframes,
  numFrames,
  visibleGallery,
  keyframesError,
  onToggleMode,
  onAddKeyframe,
  onUpdateKeyframe,
  onRemoveKeyframe,
}) {
  return (
    <div className="border border-port-border/50 rounded-lg p-2 space-y-2">
      <label htmlFor="keyframes-mode" className="flex items-center justify-between gap-2 cursor-pointer">
        <span className="text-[11px] font-medium text-gray-400">
          Multi-keyframe interpolation
          <span className="block text-[10px] text-gray-500 font-normal">Anchor 2–8 gallery frames at frame indices (LTX-2)</span>
        </span>
        <input
          id="keyframes-mode"
          type="checkbox"
          checked={keyframesMode}
          onChange={onToggleMode}
          className="w-4 h-4 accent-port-accent cursor-pointer"
        />
      </label>
      {keyframesActive && (
        <div className="space-y-2">
          {keyframes.map((kf, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1 space-y-1">
                <label htmlFor={`kf-file-${i}`} className="sr-only">{`Keyframe ${i + 1} gallery image`}</label>
                <select
                  id={`kf-file-${i}`}
                  value={kf.file}
                  onChange={(e) => onUpdateKeyframe(i, { file: e.target.value })}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent"
                >
                  <option value="">Pick from gallery…</option>
                  {visibleGallery.map((img) => (
                    <option key={img.filename} value={img.filename}>{img.filename}</option>
                  ))}
                </select>
                {kf.file && (
                  <ImagePreview src={`/data/images/${kf.file}`} alt={`Keyframe ${i + 1}`} label={kf.file} />
                )}
              </div>
              <div className="flex flex-col items-center gap-1">
                <label htmlFor={`kf-index-${i}`} className="text-[10px] text-gray-500">frame</label>
                <input
                  id={`kf-index-${i}`}
                  type="number"
                  min={0}
                  max={numFrames - 1}
                  value={kf.index}
                  onChange={(e) => onUpdateKeyframe(i, { index: e.target.value === '' ? '' : Number(e.target.value) })}
                  aria-label={`Keyframe ${i + 1} frame index`}
                  className="w-16 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent"
                />
              </div>
              <button
                type="button"
                onClick={() => onRemoveKeyframe(i)}
                disabled={keyframes.length <= 2}
                aria-label={`Remove keyframe ${i + 1}`}
                className="mt-5 p-1 text-gray-400 hover:text-port-error disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={onAddKeyframe}
              disabled={keyframes.length >= 8}
              className="flex items-center gap-1.5 text-[11px] text-port-accent hover:text-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ListPlus className="w-3.5 h-3.5" /> Add keyframe
            </button>
            <span className="text-[10px] text-gray-500">{keyframes.length}/8</span>
          </div>
          {keyframesError && <p className="text-[10px] text-port-error leading-snug">{keyframesError}</p>}
          <p className="text-[10px] text-gray-500 leading-snug">
            Keyframes pull from your gallery only. Indices must be strictly ascending and below numFrames ({numFrames}).
          </p>
        </div>
      )}
    </div>
  );
}
