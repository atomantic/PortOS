/** Why a render is held after a failed cast-guide read, with the way to fix it in place. */
export default function CastGuidesRetry({ onRetry, consequence }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-[11px] text-port-warning">
      <span>Cast guides could not be loaded, so {consequence} will not render.</span>
      <button type="button" onClick={onRetry} className="pointer-coarse:min-h-11 px-2 py-0.5 rounded border border-port-border hover:bg-port-border/30">Retry</button>
    </p>
  );
}
