

/**
 * Every runtime PortOS can measure against, and whether it can be reached.
 *
 * `modelCount === null` means the listing FAILED, so the count is unknown — a
 * stopped daemon must not render as "0 models", which reads as "nothing
 * installed" when the fix is to start it.
 */
export default function RuntimeRoster({ runtimes }) {
  const visibleRuntimes = runtimes?.filter((runtime) => !runtime.inactive);
  if (!visibleRuntimes?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleRuntimes.map((runtime) => (
        <span
          key={runtime.id}
          title={runtime.error || undefined}
          className={`px-1.5 py-0.5 text-[10px] rounded border ${
            runtime.error ? 'text-gray-500 border-port-border' : 'text-gray-300 border-port-accent/40'
          }`}
        >
          {runtime.label}
          <span className="ml-1 text-gray-600">
            {runtime.modelCount === null ? 'unreachable' : `${runtime.modelCount} model${runtime.modelCount === 1 ? '' : 's'}`}
          </span>
        </span>
      ))}
    </div>
  );
}
