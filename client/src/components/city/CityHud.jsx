import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import CityIntelPane from './CityIntelPane';
import CityAgentBar from './CityAgentBar';
import CityFilterBar from './CityFilterBar';
import CityXpBadge from './CityXpBadge';
import CityMiniMap from './CityMiniMap';
import CityVitalsList from './CityVitalsList';
import CityHudCompact from './CityHudCompact';
import { HudCorner, HealthBar, getHealthSentinel } from './cityHudBits';
import useCityViewport from '../../hooks/useCityViewport';

// WASD controls hint shown briefly on first exploration entry
function ControlsHint({ visible }) {
  const [show, setShow] = useState(false);
  const hasShownRef = useRef(false);

  useEffect(() => {
    if (visible && !hasShownRef.current) {
      hasShownRef.current = true;
      setShow(true);
      const timer = setTimeout(() => setShow(false), 5000);
      return () => clearTimeout(timer);
    }
    if (!visible) setShow(false);
  }, [visible]);

  if (!show) return null;

  return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none animate-in fade-in duration-500">
      <div className="bg-black/85 border border-cyan-500/40 rounded-lg px-6 py-4 text-center">
        <div className="font-pixel text-[11px] text-cyan-400 tracking-wider mb-3" style={{ textShadow: '0 0 8px rgba(6,182,212,0.5)' }}>
          EXPLORATION MODE
        </div>
        <div className="grid grid-cols-3 gap-1 w-fit mx-auto mb-3">
          <div />
          <div className="font-pixel text-[10px] text-gray-300 bg-gray-800/60 border border-gray-600/40 rounded px-2 py-1 text-center">W</div>
          <div />
          <div className="font-pixel text-[10px] text-gray-300 bg-gray-800/60 border border-gray-600/40 rounded px-2 py-1 text-center">A</div>
          <div className="font-pixel text-[10px] text-gray-300 bg-gray-800/60 border border-gray-600/40 rounded px-2 py-1 text-center">S</div>
          <div className="font-pixel text-[10px] text-gray-300 bg-gray-800/60 border border-gray-600/40 rounded px-2 py-1 text-center">D</div>
        </div>
        <div className="font-pixel text-[8px] text-gray-500 tracking-wide space-y-1">
          <div>MOUSE: LOOK AROUND (CLICK TO LOCK)</div>
          <div>WASD: MOVE · Q/E: DOWN/UP</div>
          <div>SHIFT: SPRINT</div>
          <div>F: INTERACT WITH BUILDING</div>
          <div>TAB: FLY OUT</div>
        </div>
      </div>
    </div>
  );
}

function Crosshair() {
  return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
      <div className="relative w-6 h-6">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-px h-2 bg-cyan-400/60" />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-px h-2 bg-cyan-400/60" />
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-2 h-px bg-cyan-400/60" />
        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2 h-px bg-cyan-400/60" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-cyan-400/40" />
      </div>
    </div>
  );
}

export default function CityHud({ cosStatus, cosAgents, agentMap, eventLogs, connected, apps, reviewCounts, instances, productivityData, systemHealth, notificationCounts, character, filter, onFilterChange, onJumpToFirst, matchCount, onToggleExploration, explorationMode, onSelectApp, onEnterPhotoMode, onEnterPlayback }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isDesktop } = useCityViewport();
  const [time, setTime] = useState(new Date());
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date());
      setUptimeSeconds(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const { activeApps, stoppedApps, totalApps, archivedApps } = useMemo(() => {
    const acc = { activeApps: 0, stoppedApps: 0, totalApps: 0, archivedApps: 0 };
    (apps || []).forEach(a => {
      if (a.archived) { acc.archivedApps++; return; }
      acc.totalApps++;
      if (a.overallStatus === 'online') acc.activeApps++;
      else if (a.overallStatus === 'stopped') acc.stoppedApps++;
    });
    return acc;
  }, [apps]);

  const onlineRatio = totalApps > 0 ? activeApps / totalApps : 1;
  const sentinel = useMemo(() => getHealthSentinel(systemHealth, onlineRatio), [systemHealth, onlineRatio]);
  const cpuPct = systemHealth?.system?.cpu?.usagePercent;
  const memPct = systemHealth?.system?.memory?.usagePercent;
  const diskPct = systemHealth?.system?.disk?.usagePercent;
  const pendingReview = reviewCounts?.total || 0;
  const alertCount = reviewCounts?.alert || 0;
  const peers = instances?.peers || [];
  const { onlinePeers, totalNodes } = useMemo(() => {
    let online = 0;
    peers.forEach(p => { if (p.status === 'online') online++; });
    return { onlinePeers: online, totalNodes: peers.length };
  }, [peers]);

  const activeAgentCount = (cosAgents || []).filter(a =>
    a.status === 'running' || a.state === 'coding' || a.state === 'thinking' || a.state === 'investigating'
  ).length;

  // The shared vitals payload — backs both the desktop cockpit's vitals panel and
  // the compact/phone `vitals` disclosure surface (via <CityVitalsList>).
  const vitals = {
    uptimeSeconds,
    sentinel,
    cpuPct,
    memPct,
    diskPct,
    warnings: systemHealth?.warnings,
    activeAgentCount,
    stoppedApps,
    archivedApps,
    pendingReview,
    alertCount,
    onlinePeers,
    totalNodes,
    notificationCounts,
    productivityData,
    activeApps,
    totalApps,
  };

  return (
    // z-20 keeps the HUD above the CityScanlines CRT overlay (z-10) so the vignette
    // + scanline-multiply + chromatic-aberration glow stay on the 3D scene and don't
    // haze the (now theme-colored) HUD panels.
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
      {isDesktop ? (
        <>
          {/* Top-left: Clock + system status + vitals */}
          <div className="absolute top-3 left-3 pointer-events-auto">
            <div className="relative bg-black/85 backdrop-blur-sm border border-cyan-500/40 rounded-lg px-4 py-3 overflow-hidden">
              <HudCorner position="tl" />
              <HudCorner position="tr" />
              <HudCorner position="bl" />
              <HudCorner position="br" />

              <div className="font-pixel text-cyan-400 text-xl tracking-wider" style={{ textShadow: '0 0 10px rgba(6,182,212,0.6)' }}>
                {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
              <div className="font-pixel text-[11px] text-cyan-500 tracking-wide mt-0.5">
                {activeApps}/{totalApps} SYSTEMS ONLINE
              </div>

              {/* System health bar */}
              <div className="mt-2">
                <HealthBar value={activeApps} max={totalApps} color="#06b6d4" />
              </div>
            </div>

            {/* System Vitals panel */}
            <div className="relative mt-2 bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg px-3 py-2.5 overflow-hidden">
              <HudCorner position="tl" />
              <HudCorner position="tr" />
              <HudCorner position="bl" />
              <HudCorner position="br" />

              {/* Animated scan line (CSS-only, no React re-renders) */}
              <div className="absolute left-0 right-0 h-px bg-cyan-400/15 pointer-events-none animate-scanline" />

              <CityVitalsList {...vitals} />
            </div>
          </div>

          {filter && onFilterChange && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2">
              <CityFilterBar
                filter={filter}
                onChange={onFilterChange}
                onJumpToFirst={onJumpToFirst}
                matchCount={matchCount}
              />
            </div>
          )}

          {/* Top-right: Connection + CoS status */}
          <div className="absolute top-3 right-3 pointer-events-auto">
            <div className="relative bg-black/85 backdrop-blur-sm border border-cyan-500/40 rounded-lg px-4 py-2.5 flex items-center gap-4">
              <HudCorner position="tl" />
              <HudCorner position="tr" />
              <HudCorner position="bl" />
              <HudCorner position="br" />

              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-port-success shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-port-error shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse'}`} />
                <span className={`font-pixel text-[11px] tracking-wide ${connected ? 'text-gray-300' : 'text-port-error'}`}>
                  {connected ? 'LINK' : 'OFFLINE'}
                </span>
              </div>
              <div className="w-px h-5 bg-cyan-500/25" />
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${cosStatus?.running ? 'bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(6,182,212,0.6)]' : 'bg-gray-600'}`} />
                <span className={`font-pixel text-[11px] tracking-wide ${cosStatus?.running ? 'text-cyan-400' : 'text-gray-500'}`}>
                  CoS {cosStatus?.running ? 'RUN' : 'IDLE'}
                </span>
              </div>
            </div>
          </div>

          {/* Right side: Intel pane (Attention + Activity tabs) */}
          <CityIntelPane
            apps={apps}
            cosAgents={cosAgents}
            reviewCounts={reviewCounts}
            instances={instances}
            systemHealth={systemHealth}
            notificationCounts={notificationCounts}
            eventLogs={eventLogs}
          />

          {/* Bottom: Agent status bar */}
          <CityAgentBar cosAgents={cosAgents} agentMap={agentMap} />

          {/* Bottom-right: character level / XP HUD badge (roadmap 2.11) */}
          <CityXpBadge character={character} />

          {/* Bottom-left: mini-map + Settings gear + legend + corner decoration */}
          <div className="absolute bottom-16 left-3">
            {/* Top-down mini-map of every building (roadmap 2.8) */}
            <CityMiniMap apps={apps} onSelectApp={onSelectApp} />

            {/* Status legend */}
            <div className="pointer-events-none mb-2 bg-black/70 backdrop-blur-sm border border-cyan-500/15 rounded-lg px-2.5 py-2 space-y-1">
              <div className="font-pixel text-[8px] text-cyan-500/50 tracking-wider mb-1">LEGEND</div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-xs bg-cyan-500" />
                <span className="font-pixel text-[8px] text-gray-400 tracking-wide">ONLINE</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-xs bg-red-500" />
                <span className="font-pixel text-[8px] text-gray-400 tracking-wide">STOPPED</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-xs bg-violet-500" />
                <span className="font-pixel text-[8px] text-gray-400 tracking-wide">NOT STARTED</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-xs bg-slate-500" />
                <span className="font-pixel text-[8px] text-gray-400 tracking-wide">ARCHIVED</span>
              </div>
            </div>

            {/* Drop In / Fly Out button */}
            <button
              onClick={onToggleExploration}
              className={`pointer-events-auto mb-2 relative bg-black/85 backdrop-blur-sm border rounded-lg px-3 py-2 hover:bg-cyan-500/10 transition-all group ${
                explorationMode
                  ? 'border-cyan-400/60 shadow-[0_0_8px_rgba(6,182,212,0.3)]'
                  : 'border-cyan-500/30 hover:border-cyan-400/60'
              }`}
              title={explorationMode ? 'Return to orbital view (Tab)' : 'Enter street-level exploration (Tab)'}
            >
              <HudCorner position="tl" />
              <HudCorner position="br" />
              <div className="font-pixel text-[10px] text-cyan-400 tracking-wider" style={{ textShadow: '0 0 6px rgba(6,182,212,0.4)' }}>
                {explorationMode ? '[ FLY OUT ]' : '[ DROP IN ]'}
              </div>
              <div className="font-pixel text-[7px] text-cyan-500/40 tracking-wide mt-0.5 text-center">(Tab)</div>
            </button>

            {/* Photo mode — cinematic camera + postcard capture */}
            {onEnterPhotoMode && (
              <button
                onClick={onEnterPhotoMode}
                className="pointer-events-auto mb-2 relative bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg w-10 h-10 flex items-center justify-center hover:border-cyan-400/60 hover:bg-cyan-500/10 transition-all group"
                title="Photo mode — cinematic camera & screenshots"
              >
                <HudCorner position="tl" />
                <HudCorner position="br" />
                <svg className="w-4.5 h-4.5 text-cyan-500/70 group-hover:text-cyan-400 transition-colors" style={{ filter: 'drop-shadow(0 0 6px rgba(6,182,212,0.4))' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            )}

            {/* History / playback mode — scrub recorded city-state snapshots */}
            {onEnterPlayback && (
              <button
                onClick={onEnterPlayback}
                className="pointer-events-auto mb-2 relative bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg w-10 h-10 flex items-center justify-center hover:border-cyan-400/60 hover:bg-cyan-500/10 transition-all group"
                title="History — scrub back through past city states"
              >
                <HudCorner position="tl" />
                <HudCorner position="br" />
                <svg className="w-4.5 h-4.5 text-cyan-500/70 group-hover:text-cyan-400 transition-colors" style={{ filter: 'drop-shadow(0 0 6px rgba(6,182,212,0.4))' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v5h5" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.05 13A9 9 0 106 5.3L3 8" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
                </svg>
              </button>
            )}

            <button
              onClick={() => navigate(location.pathname === '/city/settings' ? `/city${location.search}` : `/city/settings${location.search}`)}
              className="pointer-events-auto mb-2 relative bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg w-10 h-10 flex items-center justify-center hover:border-cyan-400/60 hover:bg-cyan-500/10 transition-all group"
              title="Settings"
              aria-label="City settings"
            >
              <HudCorner position="tl" />
              <HudCorner position="br" />
              <svg className="w-4.5 h-4.5 text-cyan-500/70 group-hover:text-cyan-400 transition-colors" style={{ filter: 'drop-shadow(0 0 6px rgba(6,182,212,0.4))' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <div className="pointer-events-none">
              <div className="font-pixel text-[8px] text-cyan-500/20 tracking-widest leading-tight">
                {'>'} SYS.INIT<br/>
                {'>'} NET.LINK<br/>
                {'>'} HUD.READY
              </div>
            </div>
          </div>
        </>
      ) : (
        <CityHudCompact
          time={time}
          vitals={vitals}
          connected={connected}
          cosStatus={cosStatus}
          character={character}
          filter={filter}
          onFilterChange={onFilterChange}
          onJumpToFirst={onJumpToFirst}
          matchCount={matchCount}
          apps={apps}
          cosAgents={cosAgents}
          reviewCounts={reviewCounts}
          instances={instances}
          systemHealth={systemHealth}
          notificationCounts={notificationCounts}
          eventLogs={eventLogs}
          onToggleExploration={onToggleExploration}
          explorationMode={explorationMode}
          onSelectApp={onSelectApp}
          onEnterPhotoMode={onEnterPhotoMode}
          onEnterPlayback={onEnterPlayback}
        />
      )}

      {/* Center crosshair in exploration mode (shared by both layouts) */}
      {explorationMode && <Crosshair />}

      {/* Controls hint overlay (shared) */}
      <ControlsHint visible={explorationMode} />
    </div>
  );
}
