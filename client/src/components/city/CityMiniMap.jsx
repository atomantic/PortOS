import { useMemo } from 'react';
import { computeCityLayout } from './cityLayout';
import { useCityPalette } from './CityPaletteContext';
import { computeMiniMap } from '../../utils/cityMiniMap';

// CyberCity mini-map overlay (roadmap 2.8). A compact top-down map in a HUD corner showing
// every building as a dot at its REAL layout position, colored by status. The layout comes
// from `computeCityLayout(apps)` — the same function CityScene uses to place buildings — so
// the map can't drift from the actual city. Status colors reuse `getBuildingColor`, so a dot
// matches its building's color exactly.
//
// Click-to-select reuses the existing building-click plumbing: `onSelectApp(app)` is the same
// callback CityScene fires on a building click (CyberCity navigates to /apps/:id). When no
// callback is supplied the map is purely informational.
//
// Hidden on very small screens (per CityHud conventions — the right-side intel pane and
// bottom agent bar already crowd a phone viewport). It's flow-positioned (no absolute) so it
// stacks cleanly at the top of CityHud's bottom-left rail above the status legend.

// Map box size in px. Fixed so the projection has a stable target on desktop.
const MAP_SIZE = 132;

export default function CityMiniMap({ apps, onSelectApp, selectedAppId = null, alwaysShow = false }) {
  // Status colors track the theme accent for 'online' (the rest stay semantic), so a
  // dot matches its building exactly. Read from the palette the city page provides.
  const { getBuildingColor } = useCityPalette();
  const view = useMemo(() => {
    const positions = computeCityLayout(Array.isArray(apps) ? apps : []);
    return computeMiniMap(apps, positions, { geography: true });
  }, [apps]);

  if (view.empty) return null;

  return (
    <div className={`${alwaysShow ? 'block' : 'hidden md:block'} mb-2 pointer-events-auto`}>
      <div className="relative bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg p-2">
        <div className="flex items-center justify-between mb-1.5 px-0.5">
          <span className="font-pixel text-[8px] text-cyan-500/60 tracking-wider">MAP</span>
          <span className="font-pixel text-[8px] text-cyan-400/80 tracking-wider">{view.count}</span>
        </div>

        <div
          className="relative rounded-sm border border-cyan-500/20 bg-cyan-500/[0.03] overflow-hidden"
          style={{ width: MAP_SIZE, height: MAP_SIZE }}
        >
          {/* The bay: everything above the shoreline reads as water, matching the city's
              real geography (the bay sits north / -Z, projected to the top of the map). */}
          {view.geography && (
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <div
                className="absolute left-0 right-0 top-0 bg-cyan-400/10 border-b border-cyan-400/25"
                style={{ height: `${(view.geography.shorelineY * 100).toFixed(2)}%` }}
              />
              {/* Data Harbor pier marker. */}
              <div
                className="absolute w-1 h-1 rounded-[1px] bg-cyan-300/70 -translate-x-1/2 -translate-y-1/2 rotate-45"
                style={{
                  left: `${(view.geography.harbor.nx * 100).toFixed(2)}%`,
                  top: `${(view.geography.harbor.ny * 100).toFixed(2)}%`,
                  boxShadow: '0 0 3px rgba(103, 232, 249, 0.8)',
                }}
                title={view.geography.harbor.label}
              />
            </div>
          )}

          {/* Faint grid lines for orientation */}
          <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
            <div className="absolute top-1/2 left-0 right-0 h-px bg-cyan-500/10" />
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-cyan-500/10" />
          </div>

          {view.dots.map((dot) => {
            const color = getBuildingColor(dot.status, dot.archived);
            const left = `${(dot.nx * 100).toFixed(2)}%`;
            const top = `${(dot.ny * 100).toFixed(2)}%`;
            const dotStyle = {
              left,
              top,
              backgroundColor: color,
              boxShadow: `0 0 4px ${color}`,
            };
            const isSelected = selectedAppId != null && dot.id === selectedAppId;
            const title = `${dot.name} — ${dot.status.replace(/_/g, ' ')}${isSelected ? ' (focused)' : ''}`;

            if (onSelectApp) {
              return (
                <button
                  key={dot.id}
                  type="button"
                  onClick={() => onSelectApp({ id: dot.id })}
                  title={title}
                  aria-label={title}
                  aria-current={isSelected ? 'true' : undefined}
                  className={`absolute w-1.5 h-1.5 rounded-full -translate-x-1/2 -translate-y-1/2 hover:scale-[2] hover:z-10 transition-transform focus:outline-none focus:ring-1 focus:ring-cyan-400 ${
                    isSelected ? 'ring-2 ring-cyan-200 scale-[1.8] z-10' : ''
                  }`}
                  style={dotStyle}
                />
              );
            }
            return (
              <span
                key={dot.id}
                title={title}
                className="absolute w-1.5 h-1.5 rounded-full -translate-x-1/2 -translate-y-1/2"
                style={dotStyle}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
