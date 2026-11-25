// Shared failed-first-read treatment for the Dashboard widgets fed by the
// apps request. Never fabricates an empty or zero-count view.
export default function AppsLoadError({ message, onRetry, title = 'Apps' }) {
  return (
    <div role="alert" className="bg-port-card border border-port-error/50 rounded-xl p-4 h-full">
      <h2 className="text-sm font-semibold text-white mb-1">{title} unavailable</h2>
      <p className="text-sm text-port-error mb-3">{message || 'Could not load apps.'}</p>
      <button
        type="button"
        onClick={onRetry}
        className="px-3 py-2 min-h-10 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm transition-colors"
      >
        Retry
      </button>
    </div>
  );
}
