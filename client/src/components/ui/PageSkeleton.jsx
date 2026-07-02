// Lightweight full-page loading skeleton for the DevTools integration pages
// (DataDog / Jira / GitHub). Reserves the header + `[1fr_360px]` card-grid
// dimensions those pages render once loaded so the first paint doesn't reflow.
// Mirrors the WidgetSkeleton pattern (port design tokens + animate-pulse) and
// renders inside Layout's scrolling main — no full-height wrapper.
export default function PageSkeleton({
  titleWidthClass = 'w-48',
  showAction = true,
  cards = 3,
  sidebar = true,
}) {
  return (
    <div className="p-4 sm:p-6" role="status" aria-busy="true" aria-label="Loading">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <div className={`h-8 rounded bg-port-card animate-pulse ${titleWidthClass}`} />
        {showAction && <div className="h-10 w-full sm:w-48 rounded bg-port-card animate-pulse" />}
      </div>
      <div className={`grid grid-cols-1 gap-6 items-start ${sidebar ? 'lg:grid-cols-[1fr_360px]' : ''}`}>
        <div className="space-y-4">
          {Array.from({ length: cards }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg border border-port-border bg-port-card p-4 sm:p-6 animate-pulse"
            >
              <div className="h-5 w-2/3 rounded bg-port-border mb-3" />
              <div className="h-4 w-1/2 rounded bg-port-border mb-2" />
              <div className="h-4 w-1/3 rounded bg-port-border" />
            </div>
          ))}
        </div>
        {sidebar && (
          <div className="rounded-lg border border-port-border bg-port-card p-4 sm:p-6 animate-pulse">
            <div className="h-5 w-1/3 rounded bg-port-border mb-4" />
            <div className="space-y-2">
              <div className="h-4 w-full rounded bg-port-border" />
              <div className="h-4 w-5/6 rounded bg-port-border" />
              <div className="h-4 w-4/6 rounded bg-port-border" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
