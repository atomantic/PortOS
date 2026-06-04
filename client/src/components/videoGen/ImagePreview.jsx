/**
 * Small thumbnail + caption used by the VideoGen mode panels (frame picker,
 * keyframe rows, extend source preview). Presentational only.
 */
export default function ImagePreview({ src, alt, label }) {
  return (
    <div className="space-y-1">
      <img src={src} alt={alt} className="w-full max-h-48 object-contain rounded border border-port-border bg-port-bg" />
      <div className="text-[11px] text-gray-500 truncate">{label}</div>
    </div>
  );
}
