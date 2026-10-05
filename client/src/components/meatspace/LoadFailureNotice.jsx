// Shown when a health read rejected. Distinct from an empty successful payload:
// a failed load must never be phrased as "no data" (see MeatSpace tabs).
export default function LoadFailureNotice({ message, onRetry }) {
  return (
    <div role="alert" className="bg-port-card border border-port-error/40 rounded-xl p-4 flex flex-wrap items-center gap-3">
      <p className="text-sm text-port-error">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1.5 min-h-[40px] text-sm border border-port-border text-gray-300 rounded-lg hover:border-gray-500 hover:text-white"
        >
          Retry
        </button>
      )}
    </div>
  );
}
