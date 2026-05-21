// Placeholder rendered while a lazy-loaded dashboard widget is in flight.
// Fills the grid cell so the dashboard layout doesn't reflow during fetch.
export default function WidgetSkeleton({ label }) {
  return (
    <div
      role="status"
      aria-label={label ? `Loading ${label}` : 'Loading widget'}
      className="h-full w-full rounded-lg border border-port-border bg-port-card animate-pulse flex items-center justify-center text-xs text-gray-500"
    >
      {label ?? 'Loading…'}
    </div>
  );
}
