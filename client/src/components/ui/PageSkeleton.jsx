// Shared full-page loading skeleton. Reserves the dimensions a page renders
// once loaded so the first paint doesn't reflow (issue #2843 — most pages used
// to show a centered BrailleSpinner with no reserved layout, so content popped
// in above the fold on every navigation).
//
// Three axes cover every primary page shape in PortOS:
//
//   header  'inline' — the page renders its own `<h2>` + action row inside the
//                      padded scrolling main (Apps, DataDog, Jira, GitHub, …).
//           'bar'    — the page renders the shared `PageHeader` bar: icon +
//                      title (+ subtitle) with a `border-b` (Brain, Calendar,
//                      Messages, Wiki, …). Matches PageHeader's compact
//                      `px-3 py-2 sm:px-4 sm:py-3` padding.
//           'none'   — the page already rendered its own header and only the
//                      body region is loading (Goals).
//   layout  'stack'  — vertically stacked cards, optional right sidebar.
//           'grid'   — responsive card grid (dashboard widgets, tiles).
//   tabs    n > 0    — reserves a `TabPills` (underline variant) strip under
//                      the header, matching its `min-h-[44px] sm:min-h-[40px]`.
//
// Container flags:
//   padded     — add page padding. Leave FALSE on routes that render inside
//                Layout's default `overflow-auto p-4 md:p-6` main (padding
//                twice is itself a layout pop); pass TRUE on `isFullWidth`
//                routes, whose main is a bare `relative overflow-hidden`.
//   fullHeight — fill the height and own the scroll, for `isFullWidth` routes.
export default function PageSkeleton({
  header = 'inline',
  titleWidthClass = 'w-48',
  showSubtitle = false,
  showAction = true,
  tabs = 0,
  cards = 3,
  sidebar = true,
  layout = 'stack',
  gridColsClass = 'sm:grid-cols-2 xl:grid-cols-3',
  padded = false,
  fullHeight = false,
}) {
  const cardBlocks = Array.from({ length: Math.max(0, cards) }).map((_, i) => (
    <div
      key={i}
      className="rounded-lg border border-port-border bg-port-card p-4 sm:p-6 animate-pulse"
    >
      <div className="h-5 w-2/3 rounded bg-port-border mb-3" />
      <div className="h-4 w-1/2 rounded bg-port-border mb-2" />
      <div className="h-4 w-1/3 rounded bg-port-border" />
    </div>
  ));

  const body = layout === 'grid'
    ? <div className={`grid grid-cols-1 gap-4 items-start ${gridColsClass}`}>{cardBlocks}</div>
    : (
      <div className={`grid grid-cols-1 gap-6 items-start ${sidebar ? 'lg:grid-cols-[1fr_360px]' : ''}`}>
        <div className="space-y-4">{cardBlocks}</div>
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
    );

  const tabStrip = tabs > 0 ? (
    <div className="shrink-0 flex gap-1 border-b border-port-border overflow-hidden">
      {Array.from({ length: tabs }).map((_, i) => (
        <div key={i} className="h-[44px] sm:h-[40px] w-20 sm:w-24 flex items-center px-2">
          <div className="h-4 w-full rounded bg-port-card animate-pulse" />
        </div>
      ))}
    </div>
  ) : null;

  // `bar` pages are the flex-column shells: the header bar and tab strip are
  // full-bleed, only the body region takes padding and owns the scroll.
  if (header === 'bar') {
    return (
      <div
        className={`flex flex-col min-h-0 ${fullHeight ? 'h-full' : ''}`}
        role="status"
        aria-busy="true"
        aria-label="Loading"
      >
        <div className="shrink-0 px-3 py-2 sm:px-4 sm:py-3 border-b border-port-border">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-6 h-6 sm:w-7 sm:h-7 shrink-0 rounded bg-port-card animate-pulse" />
            <div className="min-w-0 flex-1">
              <div className={`h-6 sm:h-7 rounded bg-port-card animate-pulse ${titleWidthClass}`} />
              {showSubtitle && (
                <div className="hidden sm:block h-4 w-64 max-w-full rounded bg-port-card animate-pulse mt-1" />
              )}
            </div>
            {showAction && <div className="h-6 w-24 rounded bg-port-card animate-pulse" />}
          </div>
        </div>
        {tabStrip}
        <div className={`flex-1 min-h-0 ${fullHeight ? 'overflow-y-auto' : ''} ${padded ? 'p-3 sm:p-4' : ''}`}>
          {body}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${padded ? 'p-4 md:p-6' : ''} ${fullHeight ? 'h-full overflow-y-auto' : ''}`}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {header !== 'none' && (
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
          <div className="min-w-0">
            <div className={`h-8 rounded bg-port-card animate-pulse ${titleWidthClass}`} />
            {showSubtitle && (
              <div className="h-4 w-56 max-w-full rounded bg-port-card animate-pulse mt-2" />
            )}
          </div>
          {showAction && <div className="h-10 w-full sm:w-48 rounded bg-port-card animate-pulse" />}
        </div>
      )}
      {tabStrip && <div className="mb-4">{tabStrip}</div>}
      {body}
    </div>
  );
}
