/**
 * Symmetric frame picker for the FFLF + image modes. Each slot accepts EITHER
 * a gallery filename OR a fresh upload; the preview renders whichever is
 * currently set, and clearing either one snaps the slot back to the dual
 * upload+gallery picker.
 *
 * Presentational — all selection state and the visible-gallery list are owned
 * by the VideoGen page and passed in. `visibleGallery` is the pre-filtered
 * gallery option list (shared across pickers so the filter runs once per
 * gallery change).
 */
import { Upload } from 'lucide-react';
import ImagePreview from './ImagePreview';

export default function FramePanel({
  label,
  file,
  upload,
  uploadUrl,
  visibleGallery,
  onPickGallery,
  onUpload,
  onClear,
  alt,
  advisoryNote,
  hint,
}) {
  // Clear button shows as soon as the user picks anything (state-only).
  // Preview gates on `uploadUrl` instead of the raw `upload` File because
  // the object URL is generated in a useEffect — without this, the render
  // between "user picked a file" and "useEffect ran" would mount an
  // <img src={null}> for one frame.
  const hasSelection = !!(file || upload);
  const canPreview = !!(file || uploadUrl);
  return (
    <div className="border border-port-border/50 rounded-lg p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-gray-400">{label}</span>
        {hasSelection && (
          <button type="button" onClick={onClear} className="text-[11px] text-port-error hover:underline">Clear</button>
        )}
      </div>
      {canPreview ? (
        <ImagePreview
          src={file ? `/data/images/${file}` : uploadUrl}
          alt={alt}
          label={file || upload?.name}
        />
      ) : (
        <div className="space-y-1.5">
          <select
            value=""
            onChange={(e) => onPickGallery(e.target.value || null)}
            aria-label={`${label} — pick from gallery`}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
          >
            <option value="">Pick from gallery…</option>
            {visibleGallery.map((img) => (
              <option key={img.filename} value={img.filename}>{img.filename}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-[11px] text-gray-400 cursor-pointer hover:text-white">
            <Upload className="w-3.5 h-3.5" />
            <span className="truncate">Upload an image</span>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => onUpload(e.target.files?.[0] || null)}
              className="hidden"
            />
          </label>
        </div>
      )}
      {advisoryNote && (
        <p className="text-[10px] text-gray-500 leading-snug" title={advisoryNote.title}>
          {advisoryNote.text}
        </p>
      )}
      {hint && (
        <p className="text-[10px] text-port-accent/80 leading-snug" title={hint.title}>
          {hint.text}
        </p>
      )}
    </div>
  );
}
