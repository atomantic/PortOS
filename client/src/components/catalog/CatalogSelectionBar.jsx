import { useRef } from 'react';
import { FolderPlus, Wand2, X } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import ListLoadError from '../ui/ListLoadError';
import useClickOutside from '../../hooks/useClickOutside';
import useEscapeKey from '../../hooks/useEscapeKey';
import useListResource from '../../hooks/useListResource';
import { listPipelineSeriesNames } from '../../services/apiPipeline';

// Remix targets — destinations the user can hand a multi-selected set of
// ingredients off to. Each target accepts the same
// `remix.ingredientIds` navigation state.
const REMIX_TARGETS = [
  { id: 'story-builder', label: 'Story Builder', to: '/story-builder' },
  { id: 'creative-director', label: 'Creative Director', to: '/creative-director' },
];

const fetchPlaceSeries = () => listPipelineSeriesNames({ silent: true });

export default function CatalogSelectionBar({ count, activePopover, onPopoverChange, universesResource, onRemix, onPlace, onClear }) {
  const remixTriggerRef = useRef(null);
  const ownerTriggerRef = useRef(null);
  const membershipTriggerRef = useRef(null);
  const popoverRef = useRef(null);
  const remixMenuOpen = activePopover === 'remix';
  const ownerMenuOpen = activePopover === 'owner';
  const membershipMenuOpen = activePopover === 'membership';
  const addMenuOpen = ownerMenuOpen || membershipMenuOpen;
  const popoverOpen = activePopover !== null;
  const togglePopover = (id) => onPopoverChange((open) => open === id ? null : id);
  const dismissPopover = () => {
    const trigger = remixMenuOpen ? remixTriggerRef : ownerMenuOpen ? ownerTriggerRef : membershipTriggerRef;
    onPopoverChange(null);
    trigger.current?.focus();
  };

  // A click fires after the pointer's default focus change.
  useClickOutside([remixTriggerRef, ownerTriggerRef, membershipTriggerRef, popoverRef], popoverOpen, dismissPopover, { event: 'click' });
  useEscapeKey(popoverOpen, dismissPopover);
  const placeSeriesResource = useListResource(fetchPlaceSeries, { enabled: membershipMenuOpen });
  const placeTargets = {
    universes: universesResource.items.map((u) => ({ refKind: 'universe', refId: u.id, label: u.name || '(untitled universe)' })),
    series: placeSeriesResource.items.map((s) => ({ refKind: 'series', refId: s.id, label: s.name || '(untitled series)' })),
  };
  const placeTargetsLoading = universesResource.state === 'loading' || membershipMenuOpen && placeSeriesResource.state === 'loading';

  // Bulk-place targets are the FULL set of live universes/series — NOT the
  // facet arrays, which only list refs that already have catalog links. A
  // freshly-created (still empty) universe/series must be a valid destination.
  // The resources enable while the menu is open and retain independent retries.
  const noPlaceTargets = universesResource.state === 'ready' && placeTargets.universes.length === 0
    && (ownerMenuOpen || placeSeriesResource.state === 'ready' && placeTargets.series.length === 0);

  const placementPopover = addMenuOpen && (
    // The bar is pinned to the bottom of the viewport and the menu
    // opens upward, so cap it against the viewport rather than a
    // fixed 18rem — in landscape that would run off the top.
    // Same non-menu call as the Remix list above (#7265): a named
    // group of plain buttons, reachable by Tab — no arrow-key
    // roving focus is implemented here.
    <div
      ref={popoverRef}
      role="group"
      aria-label={ownerMenuOpen ? 'Set owning universe' : 'Add to universe or series'}
      className="absolute bottom-full mb-2 left-0 right-0 sm:left-auto sm:min-w-[220px] max-h-[60vh] sm:max-h-72 overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-lg"
    >
      {placeTargetsLoading && placeTargets.universes.length === 0 && (!membershipMenuOpen || placeTargets.series.length === 0) ? (
        <p className="px-3 py-2 text-sm"><BrailleSpinner text="Loading…" /></p>
      ) : noPlaceTargets ? (
        <p className="px-3 py-2 text-sm text-gray-500">{ownerMenuOpen ? 'No universes yet.' : 'No universes or series yet.'}</p>
      ) : (
        <>
          {universesResource.state === 'error' ? (
            <ListLoadError what="universes" error={universesResource.error} onRetry={universesResource.retry} className="m-2" />
          ) : null}
          {membershipMenuOpen && placeSeriesResource.state === 'error' ? (
            <ListLoadError what="series" error={placeSeriesResource.error} onRetry={placeSeriesResource.retry} className="m-2" />
          ) : null}
          {universesResource.state === 'loading' && placeTargets.universes.length === 0 ? (
            <p className="px-3 py-2 text-sm text-gray-500">Loading universes…</p>
          ) : null}
          {membershipMenuOpen && placeSeriesResource.state === 'loading' && placeTargets.series.length === 0 ? (
            <p className="px-3 py-2 text-sm text-gray-500">Loading series…</p>
          ) : null}
          {universesResource.state === 'ready' && placeTargets.universes.length === 0 ? (
            <p className="px-3 py-2 text-sm text-gray-500">No universes yet.</p>
          ) : null}
          {placeTargets.universes.length > 0 && (
            <>
              <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-gray-500">Universes</p>
              {placeTargets.universes.map((t) => (
                <button
                  key={`u-${t.refId}`}
                  type="button"
                  onClick={() => onPlace(t.refKind, t.refId, t.label)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-port-bg hover:text-white"
                >
                  {t.label}
                </button>
              ))}
            </>
          )}
          {membershipMenuOpen && placeTargets.series.length > 0 && (
            <>
              <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-gray-500">Series</p>
              {placeTargets.series.map((t) => (
                <button
                  key={`s-${t.refId}`}
                  type="button"
                  onClick={() => onPlace(t.refKind, t.refId, t.label)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-port-bg hover:text-white"
                >
                  {t.label}
                </button>
              ))}
            </>
          )}
          {membershipMenuOpen && placeSeriesResource.state === 'ready' && placeTargets.series.length === 0 ? (
            <p className="px-3 py-2 text-sm text-gray-500">No series yet.</p>
          ) : null}
        </>
      )}
    </div>
  );

  // Skip the backdrop blur on phones to avoid re-sampling the grid as it scrolls.
  return (
    <div className="sticky bottom-0 left-0 right-0 mt-4 -mx-4 px-4 py-3 bg-port-card/95 sm:backdrop-blur border-t border-port-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 z-20">
      <span className="text-sm text-white font-medium">
        {count} selected
      </span>
      {/* The row is the positioning context under `sm` (the per-button
          wrappers only become `relative` at `sm`), so a menu spans the whole
          bar on a phone instead of hanging off a ~90px button and running
          past the viewport edge. Anything that gives an element between the
          menu and this row a containing block — `relative`, `transform`,
          `filter`, `contain` — silently re-anchors the menus. */}
      <div className="relative flex flex-wrap items-center gap-2">
        <div className="flex-1 sm:relative sm:flex-none">
          <button
            type="button"
            ref={remixTriggerRef}
            onClick={() => togglePopover('remix')}
            aria-expanded={remixMenuOpen}
            aria-label="Remix into…"
            className="inline-flex w-full sm:w-auto items-center justify-center gap-2 px-3 py-2 min-h-[40px] rounded-lg bg-port-accent hover:bg-port-accent/90 text-white text-sm font-medium"
          >
            <Wand2 size={16} className="shrink-0" aria-hidden="true" />
            <span className="truncate">Remix<span className="hidden sm:inline"> into…</span></span>
          </button>
          {remixMenuOpen && (
            // A plain list of actions, NOT role="menu" — that role would
            // promise ArrowUp/ArrowDown roving focus this popover doesn't
            // implement (#7265). The <ul>/<li>/<button> markup already
            // conveys "a list of actions"; aria-expanded on the trigger
            // carries the disclosure.
            <ul
              ref={popoverRef}
              aria-label="Remix targets"
              className="absolute bottom-full mb-2 left-0 right-0 sm:left-auto sm:min-w-[180px] bg-port-card border border-port-border rounded-lg shadow-lg overflow-hidden"
            >
              {REMIX_TARGETS.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onRemix(t)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-port-bg hover:text-white"
                  >
                    {t.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="sm:relative">
          <button
            type="button"
            ref={ownerTriggerRef}
            onClick={() => togglePopover('owner')}
            aria-expanded={ownerMenuOpen}
            className="min-h-[40px] px-3 py-2 text-xs rounded border border-port-border text-port-accent hover:bg-port-bg"
          >
            Set owning universe…
          </button>
          {ownerMenuOpen && placementPopover}
        </div>
        <div className="flex-1 sm:relative sm:flex-none">
          <button
            type="button"
            ref={membershipTriggerRef}
            onClick={() => togglePopover('membership')}
            aria-expanded={membershipMenuOpen}
            aria-label="Add to universe/series…"
            title="Place the selected ingredients into a universe or series"
            className="inline-flex w-full sm:w-auto items-center justify-center gap-2 px-3 py-2 min-h-[40px] rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-white text-sm font-medium disabled:opacity-50"
          >
            <FolderPlus size={16} className="shrink-0" aria-hidden="true" />
            <span className="truncate">Add<span className="hidden sm:inline"> to universe/series…</span></span>
          </button>
          {membershipMenuOpen && placementPopover}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex flex-1 sm:flex-none items-center justify-center gap-1 px-3 py-2 min-h-[40px] rounded-lg border border-port-border text-gray-300 hover:text-white text-sm"
        >
          <X size={16} className="shrink-0" aria-hidden="true" />
          Clear
        </button>
      </div>
    </div>
  );
}
