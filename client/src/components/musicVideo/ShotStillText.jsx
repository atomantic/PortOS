/** A sheet-built still's assembled text, read-only: edit the general prompt or a detail to change it. */
export default function ShotStillText({ text }) {
  return (
    <div className="min-w-0 rounded border border-port-border/60 bg-port-bg/40 p-1.5 text-xs" data-testid="assembled-still-prompt">
      <span className="block text-[11px] text-port-text-muted">Still prompt (built from the above)</span>
      <p className="whitespace-pre-line break-words text-port-text">{text || 'Fill in a detail or the general prompt.'}</p>
    </div>
  );
}
