import { useMemo } from 'react';
import { computeOpenWorldLayout } from './openWorldLayout';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { computeMiniMap } from '../../utils/openWorldMiniMap';

// OpenWorld's compact top-down Signal Map. It shows the authored archipelago and every
// building at its real layout position, colored by status. The layout comes
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

  if (view.empty && !view.geography) return null;

  return (
    <div className={`${alwaysShow ? 'block' : 'hidden md:block'} mb-2 w-fit pointer-events-auto`}>
      <div className="openworld-hud-panel openworld-hud-map relative w-fit p-2">
        <div className="flex items-center justify-between mb-1.5 px-0.5">
          <span className="font-pixel text-[8px] text-cyan-500/60 tracking-wider">SIGNAL MAP</span>
          <span className="font-pixel text-[8px] text-cyan-400/80 tracking-wider">{view.count} LIVE</span>
        </div>

        <div
          className="relative rounded-sm border border-cyan-500/20 bg-[#061520]/90 overflow-hidden"
          style={{ width: MAP_SIZE, height: MAP_SIZE }}
        >
          {/* The same island/link graph that drives the 3D terrain. SVG keeps the shape
              legible at this compact size without creating dozens of positioned divs. */}
          {view.geography && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" aria-hidden="true">
              <defs>
                <filter id="signal-map-glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="1.1" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              {view.geography.links.map((link) => (
                <polyline
                  key={link.id}
                  points={link.points.map((point) => `${point.nx * 100},${point.ny * 100}`).join(' ')}
                  fill="none"
                  stroke="rgba(103,232,249,0.78)"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter="url(#signal-map-glow)"
                />
              ))}
              {view.geography.islands.map((island) => (
                <ellipse
                  key={island.id}
                  cx={island.nx * 100}
                  cy={island.ny * 100}
                  rx={island.radiusX * 100}
                  ry={island.radiusY * 100}
                  fill={island.id === 'core' ? 'rgba(74,138,112,0.74)' : 'rgba(51,104,93,0.78)'}
                  stroke="rgba(165,243,224,0.52)"
                  strokeWidth="0.7"
                />
              ))}
            </svg>
          )}

          {/* Cardinal ticks replace the old city-block grid. */}
          <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
            <span className="absolute top-1 left-1/2 -translate-x-1/2 font-pixel text-[6px] text-cyan-200/45">N</span>
            <span className="absolute bottom-1 left-1/2 -translate-x-1/2 font-pixel text-[6px] text-cyan-200/35">S</span>
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
