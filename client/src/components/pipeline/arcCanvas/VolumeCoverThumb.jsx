// Tiny thumb cell — shows the rendered image when present, and keeps the
// queued/rendering state visible while VolumeCoverLiveUpdates waits for the
// completed filename socket event.
export default function VolumeCoverThumb({ slot, label, emptyHint }) {
  const filename = slot?.filename || null;
  const inFlight = !filename && !!slot?.jobId;
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      {filename ? (
        <a
          href={`/data/images/${filename}`}
          target="_blank"
          rel="noreferrer"
          className="block aspect-[3/4] bg-port-bg border border-port-border rounded overflow-hidden hover:border-port-accent/40"
        >
          <img src={`/data/images/${filename}`} alt={label} className="w-full h-full object-cover" />
        </a>
      ) : (
        <div className="aspect-[3/4] bg-port-bg border border-dashed border-port-border rounded flex items-center justify-center text-[10px] text-gray-500 text-center p-2">
          {inFlight ? 'Rendering...' : emptyHint}
        </div>
      )}
    </div>
  );
}
