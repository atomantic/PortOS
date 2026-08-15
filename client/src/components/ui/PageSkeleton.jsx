import { SkeletonBlock, SkeletonCard, skeletonRepeat } from './Skeleton';

// Shared full-page loading skeleton. Reserves the dimensions a page renders
// once loaded so the first paint doesn't reflow (issue #2843 — most pages used
// to show a centered BrailleSpinner with no reserved layout, so content popped
// in above the fold on every navigation). Built from the shared placeholder
// primitives in `Skeleton.jsx`, which sub-region skeletons also use (#4147).
//
// Three axes cover every primary page shape in PortOS:
//
//   header  'inline' — the page renders its own `<h2>` + action row inside the
//                      padded scrolling main (Apps, DataDog, Jira, GitHub, …).
//           'bar'    — the page renders a bordered title bar above a scrolling
//                      body (Brain, Calendar, Messages, Wiki, …). Defaults to
//                      the shared `PageHeader`'s compact
//                      `px-3 py-2 sm:px-4 sm:py-3`; pages with a hand-rolled
//                      bar pass their own via `barClassName`.
//           'none'   — the page already rendered its own header and only the
//                      body region is loading (Goals).
//   layout  'stack'  — vertically stacked cards, optional right sidebar.
//           'grid'   — responsive card grid (dashboard widgets, tiles).
//           'split'  — two-pane shell: a fixed-width side rail beside a
//                      flexible main pane that owns the scroll (Chief of
//                      Staff). Unlike `stack`/`grid` this owns the whole
//                      shell, so it ignores `header` (a two-pane page's
//                      title lives inside a pane) and renders the tab strip
//                      INSIDE the main pane where a two-pane page puts it,
//                      not above the split. Tuned by `split*`/`side*` below.
//   tabs    n > 0    — reserves a `TabPills` (underline variant) strip under
//                      the header. A default-size TabPills button is `text-sm`
//                      (20px line box) + `py-3`, i.e. 44px — its
//                      `min-h-[44px] sm:min-h-[40px]` is a floor the content
//                      already exceeds, so reserve a flat 44px at every width.
//                      `tabsInBar` moves the strip INSIDE the header block for
//                      pages that nest their tabs there (Feature Agent detail).
//
// Container flags:
//   padded     — add page padding. Match whatever the LOADED page does: leave
//                FALSE when the page's own root is unpadded (its padding comes
//                from Layout's `overflow-auto p-4 md:p-6` main) and on
//                full-bleed tabs that render edge to edge; pass TRUE when the
//                page root pads itself, and on `isFullWidth` routes, whose main
//                is a bare `relative overflow-hidden`.
//   fullHeight — fill the height and own the scroll, for `isFullWidth` routes.
//
// `label` is the screen-reader announcement — keep it specific ("Loading apps",
// not the bare default) so a page's busy state says WHAT is loading.
export default function PageSkeleton({
  header = 'inline',
  label = 'Loading',
  titleWidthClass = 'w-48',
  showSubtitle = false,
  // PageHeader hides its subtitle below `sm`; hand-rolled bars usually don't.
  subtitleOnMobile = false,
  showAction = true,
  tabs = 0,
  tabsInBar = false,
  cards = 3,
  sidebar = true,
  layout = 'stack',
  gridColsClass = 'sm:grid-cols-2 xl:grid-cols-3',
  padded = false,
  fullHeight = false,
  barClassName = 'px-3 py-2 sm:px-4 sm:py-3',
  bodyClassName = 'p-3 sm:p-4',
  // `layout="split"` only. Mirror whatever the loaded two-pane shell does:
  //   sideCollapsed     — the rail is collapsed on desktop: reserve a
  //                       zero-width track there and keep the rail's mobile
  //                       band, which a collapsible page still renders.
  //   splitColsClass    — the desktop grid tracks. Defaults off
  //                       `sideCollapsed` so a collapsed rail can't reserve a
  //                       320px column of nothing; pass your own when the
  //                       page's rail isn't 320px wide.
  //   sideClassName     — the rail's own box (borders, padding, scroll).
  //   sideHero          — reserve a large circular block (avatar, portrait)
  //                       at the top of the rail.
  //   sideBlocks        — small blocks under the hero: a nav list at
  //                       `grid-cols-1`, a stat grid at `grid-cols-2`.
  sideCollapsed = false,
  splitColsClass = sideCollapsed ? 'lg:grid-cols-[0px_1fr]' : 'lg:grid-cols-[320px_1fr]',
  sideClassName = 'flex flex-col gap-3 border-b lg:border-b-0 lg:border-r border-port-border p-3 lg:p-4 lg:h-full lg:overflow-hidden',
  sideHero = false,
  sideBlocks = 4,
  sideBlockColsClass = 'grid-cols-1',
  // Flex shape of the title/action row. The defaults are the common cases
  // (PageHeader's wrapping row for `bar`, stack-then-row for `inline`); pages
  // that break at a different width — or never stack at all — pass their own,
  // otherwise the skeleton reserves one row where the page renders two.
  headerRowClass,
}) {
  const headerRow = headerRowClass || (header === 'bar'
    ? 'flex flex-wrap items-center justify-between gap-x-3 gap-y-2'
    : 'flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4');

  const cardBlocks = skeletonRepeat(cards).map((_, i) => <SkeletonCard key={i} />);

  const stackedCards = <div className="space-y-4">{cardBlocks}</div>;

  const tabRows = skeletonRepeat(tabs);
  const sideBlockRows = skeletonRepeat(sideBlocks);
  const renderTabStrip = (bordered) => tabRows.length > 0 ? (
    <div className={`shrink-0 flex gap-1 overflow-hidden ${bordered ? 'border-b border-port-border' : ''}`}>
      {tabRows.map((_, i) => (
        <div key={i} className="h-[44px] w-20 sm:w-24 flex items-center px-2">
          <SkeletonBlock className="h-4 w-full" />
        </div>
      ))}
    </div>
  ) : null;

  // `split` pages are the two-pane shells. The rail stacks above the main pane
  // below `lg` (same as the loaded page), so the mobile band is reserved too.
  if (layout === 'split') {
    const sideRail = (
      <>
        <SkeletonBlock className={`h-5 w-2/3 ${sideHero ? 'mx-auto' : ''}`} />
        {sideHero && (
          <SkeletonBlock roundedClass="rounded-full" className="mx-auto h-24 w-24 sm:h-32 sm:w-32 lg:h-40 lg:w-40" />
        )}
        {sideBlockRows.length > 0 && (
          <div className={`grid gap-1.5 ${sideBlockColsClass}`}>
            {sideBlockRows.map((_, i) => (
              <SkeletonBlock key={i} className="h-[52px] border border-port-border" />
            ))}
          </div>
        )}
      </>
    );

    return (
      <div
        className={`relative flex flex-col lg:grid ${splitColsClass} overflow-hidden ${fullHeight ? 'h-full' : ''}`}
        role="status"
        aria-busy="true"
        aria-label={label}
      >
        {sideCollapsed ? (
          <>
            {/* Desktop: the rail is collapsed to a zero-width track, but the
                track still has to exist or the main pane lands in column 1. */}
            <div className="hidden lg:block overflow-hidden min-w-0" />
            <div className={`lg:hidden ${sideClassName}`}>{sideRail}</div>
          </>
        ) : (
          <div className={sideClassName}>{sideRail}</div>
        )}
        {/* The main pane owns the scroll on a `fullHeight` split, same as the
            loaded page — the root is `overflow-hidden`, so without this the
            reserved cards are clipped instead of scrolling. */}
        <div className={`flex-1 min-h-0 min-w-0 ${fullHeight ? 'overflow-y-auto overflow-x-hidden' : 'overflow-hidden'} ${padded ? bodyClassName : ''}`}>
          {tabRows.length > 0 && <div className="mb-4 lg:mb-6">{renderTabStrip(true)}</div>}
          {stackedCards}
        </div>
      </div>
    );
  }

  // Built after the `split` return so a two-pane page doesn't allocate the
  // stack/grid tree (and its sidebar card) it never renders.
  const body = layout === 'grid'
    ? <div className={`grid grid-cols-1 gap-4 items-start ${gridColsClass}`}>{cardBlocks}</div>
    : (
      <div className={`grid grid-cols-1 gap-6 items-start ${sidebar ? 'lg:grid-cols-[1fr_360px]' : ''}`}>
        {stackedCards}
        {sidebar && (
          <SkeletonCard titleWidthClass="w-1/3" lineWidths={['w-full', 'w-5/6', 'w-4/6']} />
        )}
      </div>
    );

  // `bar` pages are the flex-column shells: the header bar and tab strip are
  // full-bleed, only the body region takes padding and owns the scroll.
  if (header === 'bar') {
    return (
      <div
        className={`flex flex-col min-h-0 ${fullHeight ? 'h-full' : ''}`}
        role="status"
        aria-busy="true"
        aria-label={label}
      >
        <div className={`shrink-0 border-b border-port-border ${barClassName}`}>
          <div className={headerRow}>
            {/* Icon + title stay one unit, so a `flex-col` headerRowClass
                stacks the ACTION under the title (what the page does) rather
                than breaking the icon off onto its own line. */}
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <SkeletonBlock className="w-6 h-6 sm:w-7 sm:h-7 shrink-0" />
              <div className="min-w-0">
                <SkeletonBlock className={`h-6 sm:h-7 ${titleWidthClass}`} />
                {showSubtitle && (
                  <SkeletonBlock className={`${subtitleOnMobile ? '' : 'hidden sm:block'} h-4 w-64 max-w-full mt-1`} />
                )}
              </div>
            </div>
            {showAction && <SkeletonBlock className="h-6 w-24" />}
          </div>
          {/* Pages that nest their tab row inside the header block (no divider
              between title and tabs) reserve it here rather than below the bar. */}
          {tabsInBar && <div className="mt-3">{renderTabStrip(false)}</div>}
        </div>
        {!tabsInBar && renderTabStrip(true)}
        <div className={`flex-1 min-h-0 ${fullHeight ? 'overflow-y-auto' : ''} ${padded ? bodyClassName : ''}`}>
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
      aria-label={label}
    >
      {header !== 'none' && (
        <div className={`${headerRow} mb-6`}>
          <div className="min-w-0">
            <SkeletonBlock className={`h-8 ${titleWidthClass}`} />
            {showSubtitle && (
              <SkeletonBlock className="h-4 w-56 max-w-full mt-2" />
            )}
          </div>
          {showAction && <SkeletonBlock className="h-10 w-full sm:w-48" />}
        </div>
      )}
      {tabRows.length > 0 && <div className="mb-4">{renderTabStrip(true)}</div>}
      {body}
    </div>
  );
}
