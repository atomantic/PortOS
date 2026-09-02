import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../ui/Modal';
import {
  MINI_MAP_PADDING,
  computeBounds,
  projectPoint,
  spreadProjectedPoints,
} from '../../utils/openWorldMiniMap';
import { listRegions, searchRegions } from '../../utils/openWorldRegions';
import { VILLAGE_GROUND, VILLAGE_ROUTES } from '../../utils/openWorldPlan';
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

// The plate projects the same unified ground and curved lane registry as street-level
// rendering. This keeps the map spatially honest without resurrecting the old island graph.
const MAP_BOUNDS = computeBounds([
  { x: VILLAGE_GROUND.center[0] - VILLAGE_GROUND.radiusX, z: VILLAGE_GROUND.center[1] },
  { x: VILLAGE_GROUND.center[0] + VILLAGE_GROUND.radiusX, z: VILLAGE_GROUND.center[1] },
  { x: VILLAGE_GROUND.center[0], z: VILLAGE_GROUND.center[1] - VILLAGE_GROUND.radiusZ },
  { x: VILLAGE_GROUND.center[0], z: VILLAGE_GROUND.center[1] + VILLAGE_GROUND.radiusZ },
]);
const villageCenter = projectPoint({ x: VILLAGE_GROUND.center[0], z: VILLAGE_GROUND.center[1] }, MAP_BOUNDS, MINI_MAP_PADDING);
const villageEdgeX = projectPoint({ x: VILLAGE_GROUND.center[0] + VILLAGE_GROUND.radiusX, z: VILLAGE_GROUND.center[1] }, MAP_BOUNDS, MINI_MAP_PADDING);
const villageEdgeZ = projectPoint({ x: VILLAGE_GROUND.center[0], z: VILLAGE_GROUND.center[1] + VILLAGE_GROUND.radiusZ }, MAP_BOUNDS, MINI_MAP_PADDING);
const MAP_GROUND = {
  nx: villageCenter.nx,
  ny: villageCenter.ny,
  radiusX: Math.abs(villageEdgeX.nx - villageCenter.nx),
  radiusY: Math.abs(villageEdgeZ.ny - villageCenter.ny),
};
const MAP_ROUTES = VILLAGE_ROUTES.map((route) => ({
  ...route,
  points: [...route.points, ...(route.closed ? [route.points[0]] : [])]
    .map(([x, z]) => projectPoint({ x, z }, MAP_BOUNDS, MINI_MAP_PADDING)),
}));

export default function OpenWorldFastTravel({ open, onClose, onTravel, activeRegionId, onLeaveRegion, isFeatureEnabled }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const { isCondensed } = useOpenWorldViewport();

  const regions = useMemo(() => listRegions(isFeatureEnabled), [isFeatureEnabled]);
  const matches = useMemo(() => searchRegions(query, isFeatureEnabled), [query, isFeatureEnabled]);
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
      ariaLabel="Village map"
      zIndexClassName="z-[120]"
      panelClassName="w-full max-w-3xl rounded-xl border port-media-overlay flex flex-col overflow-hidden"
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-current/10">
        <div className="font-pixel text-[12px] tracking-widest">VILLAGE MAP</div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search village places…"
          aria-label="Search village places"
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

      <div className={`flex-1 min-h-0 grid gap-3 p-3 overflow-hidden ${isCondensed ? 'grid-cols-1 grid-rows-[minmax(190px,36vh)_minmax(0,1fr)]' : 'grid-cols-[240px_1fr]'}`}>
        {/* World plate — regions in their real plan positions, so the list and the map
            can't disagree about where a place is. Compact viewports get a full-width
            touch-sized plate above the searchable list; desktop keeps the square rail. */}
        <div
          className="block w-full h-full relative rounded-lg border border-current/15 overflow-hidden"
          role="region"
          aria-label="Village map"
        >
          <div className="absolute inset-0 bg-[#132521]/95" />
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" aria-hidden="true">
            <ellipse
              cx={MAP_GROUND.nx * 100}
              cy={MAP_GROUND.ny * 100}
              rx={MAP_GROUND.radiusX * 100}
              ry={MAP_GROUND.radiusY * 100}
              fill="rgba(116, 156, 91, 0.86)"
              stroke="rgba(228, 218, 163, 0.78)"
              strokeWidth="1.2"
            />
              {MAP_ROUTES.map((route) => (
                <polyline
                  key={route.id}
                  points={route.points.map((point) => `${point.nx * 100},${point.ny * 100}`).join(' ')}
                  fill="none"
                  stroke={route.kind === 'path' ? 'rgba(218, 170, 112, 0.88)' : 'rgba(239, 221, 165, 0.92)'}
                  strokeWidth={route.kind === 'path' ? '1.25' : '2.4'}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
          </svg>
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
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-all flex items-center justify-center ${isCondensed ? 'w-11 h-11' : 'w-5 h-5 hover:scale-125'}`}
                style={{ left: `${nx * 100}%`, top: `${ny * 100}%` }}
              >
                <span
                  className={`rounded-full border shadow-sm ${
                    isActive
                      ? 'w-4 h-4 border-[#fff5c7] bg-[#fff0a6] ring-2 ring-[#fff0a6]/35'
                      : isMatch
                        ? 'w-3 h-3 border-[#f5e7bd] bg-[#f5e7bd]/85'
                        : 'w-2.5 h-2.5 border-current/40 bg-current/25'
                  }`}
                  aria-hidden="true"
                />
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
