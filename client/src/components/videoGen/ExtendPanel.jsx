/**
 * Extend mode panel — the user picks a prior render whose last frame (legacy
 * mlx_video) or full latent (ltx2) seeds a new generation.
 *
 * Presentational — the picked video id, in-flight extract flag, extracted
 * source-image filename, and the visible history list are owned by the
 * VideoGen page. `onPick('')` clears the selection.
 */
import ImagePreview from './ImagePreview';

export default function ExtendPanel({
  extendFromVideoId,
  extendingFrame,
  sourceImageFile,
  visibleHistory,
  onPick,
}) {
  return (
    <div className="border border-port-border/50 rounded-lg p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-gray-400">Continue from a prior render</span>
        {extendFromVideoId && (
          <button type="button" onClick={() => onPick('')} className="text-[11px] text-port-error hover:underline">Clear</button>
        )}
      </div>
      <select
        value={extendFromVideoId}
        disabled={extendingFrame}
        onChange={(e) => onPick(e.target.value)}
        aria-label="Pick a previous video to extend"
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
      >
        <option value="">Pick a previous video…</option>
        {visibleHistory.slice(0, 50).map((v) => (
          <option key={v.id} value={v.id}>
            {(v.prompt || v.filename || v.id).slice(0, 80)}
          </option>
        ))}
      </select>
      {extendingFrame && (
        <span className="text-[11px] text-gray-500">Extracting last frame…</span>
      )}
      {sourceImageFile && extendFromVideoId && !extendingFrame && (
        <ImagePreview
          src={`/data/images/${sourceImageFile}`}
          alt="Last frame"
          label={`Starts from: ${sourceImageFile}`}
        />
      )}
    </div>
  );
}
