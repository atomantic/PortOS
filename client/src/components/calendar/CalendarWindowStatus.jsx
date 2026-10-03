export default function CalendarWindowStatus({ complete, error, retry }) {
  if (complete) return null;
  return (
    <div role={error ? 'alert' : 'status'} className="flex flex-wrap items-center gap-3 rounded border border-port-border bg-port-card p-3 text-sm text-gray-400">
      <p>{error
        ? 'Calendar events are incomplete. Some events could not be loaded; empty times may still be busy.'
        : 'Loading calendar events… Empty times may still be busy until all events are loaded.'}</p>
      {error && (
        <button type="button" onClick={retry} className="min-h-[44px] rounded px-3 py-2 text-port-accent hover:bg-port-border">
          Retry
        </button>
      )}
    </div>
  );
}
