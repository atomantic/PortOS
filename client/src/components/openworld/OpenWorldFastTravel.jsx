import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../ui/Modal';
import { MINI_MAP_PADDING, projectGeography, projectPoint, spreadProjectedPoints } from '../../utils/openWorldMiniMap';
import { listRegions, searchRegions } from '../../utils/openWorldRegions';
import { WORLD } from '../../utils/openWorldPlan';
import useOpenWorldViewport from '../../hooks/useOpenWorldViewport';

// OpenWorld's world map — the thing that makes this an open world rather than one city you pan
// around. Every named region is a warp destination: pick one and the camera (or, in exploration
// mode, the player) travels there. The region metadata describes the PortOS area represented by
// the district; this panel never opens that area as a separate page.
//
// Selection is NOT held here. Clicking a region navigates to `/openworld/region/:regionId`
// and the route param drives the camera — the same URL-is-the-source-of-truth rule building
// focus follows, so a warp is shareable, bookmarkable, and reachable from ⌘K and voice.
//
// The dialog chrome (backdrop, Esc, click-outside, focus trap, and the module-scope Esc
// stack that keeps layered dialogs from both closing on one keystroke) comes from the shared
// <Modal> primitive — the same one OpenWorldPhotoOverlay's postcard uses. Portaled, which is safe
// here because every class this panel wears (`port-media-overlay*`) is global rather than
// scoped under `.openworld-themed`.

// The map plate's world extent: the whole playable square, so a region's marker sits where
// the district actually is rather than being normalized against a shifting building cloud.
const MAP_BOUNDS = {
  minX: -WORLD.landHalf - 8,
  maxX: WORLD.landHalf + 8,
  minZ: WORLD.shorelineZ - 20,
  maxZ: WORLD.landHalf + 8,
};

// Waterfront on the plate, read from the same projector the mini-map uses so the two can't
// disagree about where the bay starts.
const GEOGRAPHY = projectGeography(MAP_BOUNDS, MINI_MAP_PADDING);

export default function OpenWorldFastTravel({ open, onClose, onTravel, activeRegionId, onLeaveRegion }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const { isCondensed } = useOpenWorldViewport();

  const regions = useMemo(() => listRegions(), []);
  const matches = useMemo(() => searchRegions(query), [query]);
  const matchIds = useMemo(() => new Set(matches.map((r) => r.id)), [matches]);
  const mapMarkers = useMemo(
    () => spreadProjectedPoints(regions.map((region) => {
      const { nx, ny } = projectPoint({ x: region.anchor[0], z: region.anchor[2] }, MAP_BOUNDS, MINI_MAP_PADDING);
      return { id: region.id, nx, ny };
    })),
    [regions],
  );
  const markersById = useMemo(() => new Map(mapMarkers.map((marker) => [marker.id, marker])), [mapMarkers]);

  // Reopening always starts from the full list — a stale filter from the last visit would
  // read as "half my world is missing".
  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Modal renders null while closed, but only AFTER the caller has built the children
  // tree. This page re-renders on every socket event, so return early and skip ~60
  // discarded elements (and 14 projections) per event while the panel is shut.
  if (!open) return null;

  const travel = (region) => {
    onTravel?.(region);
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="none"
      usePortal
      ariaLabel="World map"
      panelClassName="w-full max-w-3xl max-h-[85vh] rounded-xl border port-media-overlay flex flex-col overflow-hidden"
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-current/10">
        <div className="font-pixel text-[12px] tracking-widest">WORLD MAP</div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search regions…"
          aria-label="Search regions"
          className="flex-1 min-w-0 font-pixel text-[11px] px-2 py-1.5 rounded border border-current/20 bg-transparent focus:outline-none focus:border-current/50"
        />
        {/* The only way back out of a region to the whole-world overview — without it a
            warp is a one-way trip until you pick another region. */}
        {activeRegionId && onLeaveRegion && (
          <button
            type="button"
            onClick={() => { onLeaveRegion(); onClose?.(); }}
            className="port-media-overlay-item shrink-0 font-pixel text-[10px] px-2 py-1.5 rounded border border-current/20 tracking-wide"
          >
            OVERVIEW
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="port-media-overlay-item font-pixel text-[10px] px-2 py-1.5 rounded border border-current/20"
        >
          ESC
        </button>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3 p-3 overflow-hidden">
        {/* World plate — regions in their real plan positions, so the list and the map
            can't disagree about where a place is. Compact viewports get a full-width
            touch-sized plate above the searchable list; desktop keeps the square rail. */}
        <div
          className={`${isCondensed ? 'block w-full aspect-[4/3]' : 'hidden md:block aspect-square'} relative rounded-lg border border-current/15 overflow-hidden`}
          role="region"
          aria-label="World map"
        >
          <div className="absolute inset-0 bg-current/5" />
          {GEOGRAPHY && (
            <div
              className="absolute inset-x-0 top-0 bg-current/10"
              style={{ height: `${GEOGRAPHY.shorelineY * 100}%` }}
              aria-hidden="true"
            />
          )}
          {regions.map((region) => {
            const { nx, ny } = markersById.get(region.id);
            const isActive = region.id === activeRegionId;
            const isMatch = matchIds.has(region.id);
            return (
              <button
                key={region.id}
                type="button"
                title={region.label}
                aria-label={`Teleport to ${region.label}`}
                onClick={() => travel(region)}
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border transition-all flex items-center justify-center ${
                  isActive
                    ? 'w-11 h-11 md:w-3.5 md:h-3.5 border-current bg-current'
                    : isMatch
                      ? 'w-11 h-11 md:w-2.5 md:h-2.5 border-current/70 bg-current/50 md:hover:w-3.5 md:hover:h-3.5'
                      : 'w-11 h-11 md:w-2 md:h-2 border-current/30 bg-current/10'
                }`}
                style={{ left: `${nx * 100}%`, top: `${ny * 100}%` }}
              >
                <span className="w-2 h-2 md:w-1.5 md:h-1.5 rounded-full bg-current" aria-hidden="true" />
              </button>
            );
          })}
        </div>

        <ul className="min-h-0 overflow-y-auto space-y-1.5 pr-1">
          {matches.length === 0 && (
            <li className="font-pixel text-[10px] opacity-60 px-2 py-3">NO REGION MATCHES “{query}”</li>
          )}
          {matches.map((region) => (
            <li key={region.id}>
              <div
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                  region.id === activeRegionId ? 'border-current/60 bg-current/10' : 'border-current/15'
                }`}
              >
                <button
                  type="button"
                  onClick={() => travel(region)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="font-pixel text-[11px] tracking-wide truncate">{region.label}</div>
                  <div className="text-[11px] opacity-70 truncate">{region.blurb}</div>
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
