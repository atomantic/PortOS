// Names which Prompt Manager catalogue failed and how to recover. `stale`
// means rows from an earlier successful read are still shown.
export default function CatalogueNotice({ label, stale, onRetry }) {
  return (
    <div role="alert" className="mb-2 rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
      <div>{stale ? `${label} may be out of date — the last refresh failed.` : `${label} are unavailable right now.`}</div>
      <button onClick={onRetry} className="mt-1 text-port-accent hover:underline">Retry {label.toLowerCase()}</button>
    </div>
  );
}
