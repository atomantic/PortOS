import { useMemo } from 'react';
import { computeOpenWorldLayout } from './openWorldLayout';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { computeMiniMap } from '../../utils/openWorldMiniMap';

// OpenWorld mini-map overlay (roadmap 2.8). A compact top-down map in a HUD corner showing
// every building as a dot at its REAL layout position, colored by status. The layout comes
// from `computeOpenWorldLayout(apps)` — the same function OpenWorldScene uses to place buildings — so
// the map can't drift from the actual city. Status colors reuse `getBuildingColor`, so a dot
// matches its building's color exactly.
//
// Click-to-select reuses the existing building-click plumbing: `onSelectApp(app)` is the same
// callback OpenWorldScene fires on a building click (OpenWorld focuses the building in-world).
// When no callback is supplied the map is purely informational.
//
// Hidden on very small screens (per OpenWorldHud conventions — the right-side intel pane and
// bottom agent bar already crowd a phone viewport). It's flow-positioned (no absolute) so it
// stacks cleanly at the top of OpenWorldHud's bottom-left rail above the status legend.

// Map box size in px. Fixed so the projection has a stable target on desktop.
const MAP_SIZE = 132;

export default function OpenWorldMiniMap({
  apps,
  onSelectApp,
  selectedAppId = null,
  alwaysShow = false,
  playerPose = null,
}) {
  const { getBuildingColor, accent } = useOpenWorldPalette();
  const positions = useMemo(() => computeOpenWorldLayout(Array.isArray(apps) ? apps : []), [apps]);
  const view = useMemo(() => {
    return computeMiniMap(apps, positions, {
      geography: true,
      landmarks: true,
      player: playerPose ? { position: playerPose, heading: playerPose.heading || 0 } : null,
    });
  }, [apps, positions, playerPose]);

  if (view.empty) return null;

  return (
    <div className={`${alwaysShow ? 'block' : 'hidden md:block'} mb-2 w-fit pointer-events-auto`}>
      <div className="openworld-hud-panel openworld-hud-map relative w-fit p-2">
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
                className="absolute w-1.5 h-1.5 rounded-[1px] bg-cyan-300/70 -translate-x-1/2 -translate-y-1/2 rotate-45"
                style={{
                  left: `${(view.geography.harbor.nx * 100).toFixed(2)}%`,
                  top: `${(view.geography.harbor.ny * 100).toFixed(2)}%`,
                  boxShadow: '0 0 4px rgba(103, 232, 249, 0.8)',
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

          {/* District landmark indicators */}
          {view.landmarks?.map((lm) => {
            const left = `${(lm.nx * 100).toFixed(2)}%`;
            const top = `${(lm.ny * 100).toFixed(2)}%`;
            return (
              <span
                key={lm.id}
                title={lm.label}
                className="absolute w-1 h-1 rounded-xs -translate-x-1/2 -translate-y-1/2 opacity-70"
                style={{
                  left,
                  top,
                  backgroundColor: lm.color,
                  boxShadow: `0 0 2px ${lm.color}`,
                }}
              />
            );
          })}

          {/* App building dots */}
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

          {/* Live Player Pose Blip & Heading Arrow */}
          {view.player && (
            <div
              className="absolute pointer-events-none z-20 -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${(view.player.nx * 100).toFixed(2)}%`,
                top: `${(view.player.ny * 100).toFixed(2)}%`,
              }}
            >
              <div
                className="w-0 h-0 border-l-[3.5px] border-l-transparent border-r-[3.5px] border-r-transparent border-b-[8px] filter drop-shadow-[0_0_4px_rgba(6,182,212,0.9)]"
                style={{
                  borderBottomColor: accent || '#06b6d4',
                  transform: `rotate(${view.player.rotationDeg}deg)`,
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
