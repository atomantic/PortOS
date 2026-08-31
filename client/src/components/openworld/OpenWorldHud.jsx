import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { Camera, Compass, History, Map as MapIcon, Settings } from 'lucide-react';
import { noPointerFocusSurfaceProps } from '../../lib/a11yKeyboard';
import OpenWorldIntelPane from './OpenWorldIntelPane';
import OpenWorldFocusPanel from './OpenWorldFocusPanel';
import OpenWorldAgentBar from './OpenWorldAgentBar';
import OpenWorldFilterBar from './OpenWorldFilterBar';
import OpenWorldXpBadge from './OpenWorldXpBadge';
import OpenWorldMiniMap from './OpenWorldMiniMap';
import OpenWorldHudCompact from './OpenWorldHudCompact';
import OpenWorldInteractionPrompt from './OpenWorldInteractionPrompt';
import OpenWorldSpeedometer from './OpenWorldSpeedometer';
import { HealthBar, getHealthSentinel, metricColor } from './openWorldHudBits';
import useOpenWorldViewport from '../../hooks/useOpenWorldViewport';
import { formatClockTime } from '../../utils/formatters';

// The first drop-in hint is intentionally a small invitation, not a manual. The full
// control reference remains discoverable from the settings drawer and keyboard behavior.
function ControlsHint({ visible, isDesktop }) {
  const [show, setShow] = useState(false);
  const hasShownRef = useRef(false);

  useEffect(() => {
    if (visible && !hasShownRef.current) {
      hasShownRef.current = true;
      setShow(true);
      const timer = setTimeout(() => setShow(false), 4500);
      return () => clearTimeout(timer);
    }
    if (!visible) setShow(false);
  }, [visible]);

  if (!show || !isDesktop) return null;

  return (
    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none animate-in fade-in duration-500">
      <div className="openworld-hud-panel px-5 py-4 text-center">
        <div className="openworld-hud-eyebrow mb-2">WELCOME TO THE VILLAGE</div>
        <div className="mb-3 font-pixel text-[9px] tracking-[0.14em] text-[rgb(var(--port-text))]">
          TAKE THE LONG WAY · THERE IS ALWAYS SOMETHING AROUND THE BEND
        </div>
        <div className="mb-3 flex items-center justify-center gap-1.5">
          {['W', 'A', 'S', 'D'].map((key) => (
            <span key={key} className="flex h-7 w-7 items-center justify-center rounded-lg border border-[rgb(var(--port-accent)/.28)] bg-[rgb(var(--port-accent)/.08)] font-pixel text-[10px] text-[rgb(var(--port-text))]">
              {key}
            </span>
          ))}
        </div>
        <div className="font-pixel text-[8px] tracking-wide text-[rgb(var(--port-text-muted))]">
          WASD DRIVE <span className="mx-1 opacity-50">·</span> SHIFT BOOST <span className="mx-1 opacity-50">·</span> F VISIT <span className="mx-1 opacity-50">·</span> SPACE HOP <span className="mx-1 opacity-50">·</span> M VILLAGE MAP
        </div>
      </div>
    </div>
  );
}

function SystemMetric({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-1">
      <span className="font-pixel text-[8px] tracking-[0.12em] text-[rgb(var(--port-text-muted))]">{label}</span>
      <span className={`font-pixel text-[9px] tracking-wide ${metricColor(value)}`}>
        {value != null ? `${value}%` : '—'}
      </span>
    </div>
  );
}

// The HUD floats over a keyboard-driven world: a pointer click must not leave
// focus parked on the button, or Space stops jumping and starts re-pressing it.
function HudAction({ icon: Icon, label, hint, active, primary = false, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
     
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={`openworld-hud-action ${primary ? 'openworld-hud-action--primary' : ''}`}
    >
      <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
      <span className="openworld-hud-action-copy">{label}</span>
      {hint && <span className="openworld-hud-action-hint">{hint}</span>}
    </button>
  );
}

export default function OpenWorldHud({
  cosStatus,
  cosAgents,
  agentMap,
  eventLogs,
  connected,
  apps,
  reviewCounts,
  instances,
  productivityData,
  systemHealth,
  notificationCounts,
  character,
  filter,
  onFilterChange,
  onJumpToFirst,
  matchCount,
  onToggleExploration,
  explorationMode,
  onSelectApp,
  onEnterPhotoMode,
  onEnterPlayback,
  focusedAppId,
  focusedApp,
  focusNotFound,
  focusAgents,
  onCloseFocus,
  onFocusInWorld,
  onOpenFastTravel,
  onOpenDestination,
  onAttentionItem,
  activeRegion,
  proximityTarget,
  playerPose = null,
  collectedCount = 0,
  totalShards = 18,
}) {
  const isFocused = Boolean(focusedApp || focusNotFound);
  const navigate = useNavigate();
  const location = useLocation();
  const { isDesktop } = useOpenWorldViewport();
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
    onOpenDestination,
  };

  if (explorationMode) {
    const speedKmh = Math.round(Math.abs(playerPose?.speed || 0) * 3.6);
    const progress = totalShards > 0 ? Math.min(100, Math.round((collectedCount / totalShards) * 100)) : 0;
    const settingsOpen = location.pathname === '/openworld/settings';
    const toggleSettings = () => navigate(settingsOpen ? `/openworld${location.search}` : `/openworld/settings${location.search}`);

    return (
      <div className="absolute inset-0 z-20 pointer-events-none openworld-hud-shell overflow-hidden" {...noPointerFocusSurfaceProps}>
        <div className="openworld-village-status pointer-events-auto">
          <span className={`openworld-village-status__dot ${sentinel.dot}`} aria-hidden="true" />
          <span>
            <small>PORTOS VILLAGE</small>
            <strong>{activeRegion?.label || 'The Common'}</strong>
          </span>
          <span className="openworld-village-status__echo" aria-label={`${collectedCount} of ${totalShards} echoes recovered`}>
            <i style={{ width: `${progress}%` }} />
            ⯁ {collectedCount}/{totalShards}
          </span>
        </div>

        <div className="openworld-village-actions pointer-events-auto" role="toolbar" aria-label="Village controls">
          {onOpenFastTravel && <HudAction icon={MapIcon} label="Village map" hint="M" onClick={onOpenFastTravel} />}
          {onEnterPhotoMode && <HudAction icon={Camera} label="Take a postcard" onClick={onEnterPhotoMode} />}
          <HudAction icon={Compass} label="Fly out to world view" hint="TAB" onClick={onToggleExploration} />
          <HudAction icon={Settings} label="Village settings" active={settingsOpen} onClick={toggleSettings} />
        </div>

        <div className="openworld-village-speed" aria-label={`${speedKmh} kilometers per hour`}>
          <strong>{speedKmh}</strong><span>km/h</span>
        </div>

        {isFocused && (
          <OpenWorldFocusPanel
            app={focusedApp}
            notFound={focusNotFound}
            agents={focusAgents}
            onClose={onCloseFocus}
            onFocusInWorld={onFocusInWorld}
            isDesktop={isDesktop}
          />
        )}
        <OpenWorldInteractionPrompt target={proximityTarget} compact={!isDesktop} />
        <ControlsHint visible isDesktop={isDesktop} />
      </div>
    );
  }

  return (
    // The HUD floats over a keyboard-driven world (WASD to move, Space to jump,
    // the playback transport keys). A click on any HUD control must hand focus
    // straight back, or the next Space re-presses that control instead.
    <div className="absolute inset-0 z-20 pointer-events-none openworld-hud-shell overflow-hidden" {...noPointerFocusSurfaceProps}>
      {isDesktop ? (
        <>
          <div className="absolute left-4 top-4 pointer-events-auto">
            <div className="openworld-hud-panel w-[min(17rem,calc(100vw-2rem))] px-4 py-3.5">
              <div className="flex items-center justify-between gap-4">
                <span className="openworld-hud-eyebrow">{explorationMode ? 'OpenWorld / signal trail' : 'OpenWorld / world view'}</span>
                <span className={`h-2.5 w-2.5 rounded-full ${sentinel.dot}`} title={sentinel.label} aria-label={`World health ${sentinel.label}`} />
              </div>
              {explorationMode ? (
                <>
                  <div className="mt-2 font-pixel text-lg tracking-[0.1em] text-[rgb(var(--port-text))]">{activeRegion?.label || 'THE PORT'}</div>
                  <div className="mt-2 flex items-center justify-between gap-3 border-t border-[rgb(var(--port-accent)/.14)] pt-2 font-pixel text-[9px] tracking-[0.1em]">
                    <span className="text-[rgb(var(--port-text-muted))]">ECHOES RECOVERED</span>
                    <span className="text-[rgb(var(--port-accent))]">⯁ {collectedCount}/{totalShards}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-2 flex items-end justify-between gap-4">
                    <span className="font-pixel text-2xl tracking-[0.12em] text-[rgb(var(--port-text))]">{formatClockTime(time, { seconds: false })}</span>
                    <span className="font-pixel text-[9px] tracking-[0.12em] text-[rgb(var(--port-accent))]">{activeApps}/{totalApps} ACTIVE</span>
                  </div>
                  <div className="mt-2">
                    <HealthBar value={activeApps} max={totalApps} color="rgb(var(--port-accent))" />
                  </div>
                  <div
                    className="mt-2 grid grid-cols-3 gap-3 border-t border-[rgb(var(--port-accent)/.14)] pt-2"
                    aria-label="System resource usage"
                  >
                    <SystemMetric label="CPU" value={cpuPct} />
                    <SystemMetric label="MEM" value={memPct} />
                    <SystemMetric label="DISK" value={diskPct} />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 font-pixel text-[8px] tracking-[0.12em] text-[rgb(var(--port-text-muted))]">
                    <span className="truncate">{activeRegion?.label || 'THE PORT'}</span>
                    <span className={sentinel.text}>{sentinel.label}</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {!explorationMode && filter && onFilterChange && (
            <div className="absolute left-1/2 top-4 -translate-x-1/2">
              <OpenWorldFilterBar
                filter={filter}
                onChange={onFilterChange}
                onJumpToFirst={onJumpToFirst}
                matchCount={matchCount}
              />
            </div>
          )}

          {!explorationMode && <div className="absolute right-4 top-4 pointer-events-auto">
            <div className="openworld-hud-panel openworld-hud-panel--quiet flex items-center gap-3 px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${connected ? 'bg-port-success' : 'bg-port-error animate-pulse'}`} />
                <span className={`font-pixel text-[9px] tracking-[0.12em] ${connected ? 'text-[rgb(var(--port-text-muted))]' : 'text-port-error'}`}>
                  {connected ? 'SYNCED' : 'OFFLINE'}
                </span>
              </div>
              <span className="h-4 w-px bg-[rgb(var(--port-accent)/.22)]" />
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${cosStatus?.running ? 'bg-[rgb(var(--port-accent))] animate-pulse' : 'bg-[rgb(var(--port-text-muted)/.45)]'}`} />
                <span className="font-pixel text-[9px] tracking-[0.12em] text-[rgb(var(--port-text-muted))]">CoS {cosStatus?.running ? 'RUN' : 'IDLE'}</span>
              </div>
            </div>
          </div>}

          {isFocused ? (
            <OpenWorldFocusPanel
              app={focusedApp}
              notFound={focusNotFound}
              agents={focusAgents}
              onClose={onCloseFocus}
              onFocusInWorld={onFocusInWorld}
              isDesktop
            />
          ) : (
            <OpenWorldIntelPane
              apps={apps}
              cosAgents={cosAgents}
              reviewCounts={reviewCounts}
              instances={instances}
              systemHealth={systemHealth}
              notificationCounts={notificationCounts}
              eventLogs={eventLogs}
              onItemActivate={onAttentionItem}
              onOpenFastTravel={onOpenFastTravel}
            />
          )}

          {!explorationMode && <OpenWorldAgentBar cosAgents={cosAgents} agentMap={agentMap} />}
          {!explorationMode && <OpenWorldXpBadge character={character} onOpenDestination={onOpenDestination} />}

          <div className="absolute bottom-4 left-4 pointer-events-auto flex flex-col gap-2 items-start">
            <OpenWorldMiniMap
              apps={apps}
              onSelectApp={onSelectApp}
              selectedAppId={focusedAppId}
              playerPose={playerPose}
            />
            {explorationMode && (
              <OpenWorldSpeedometer
                playerPose={playerPose}
                collectedCount={collectedCount}
                totalShards={totalShards}
              />
            )}
            <div className="openworld-hud-action-rail">
              {onOpenFastTravel && <HudAction icon={MapIcon} label="World map" hint="M" onClick={onOpenFastTravel} />}
              <HudAction
                icon={Compass}
                label={explorationMode ? 'Fly out' : 'Drop in'}
                hint="TAB"
                active={explorationMode}
                primary
                onClick={onToggleExploration}
              />
              {onEnterPhotoMode && <HudAction icon={Camera} label="Photo mode" onClick={onEnterPhotoMode} />}
              {onEnterPlayback && <HudAction icon={History} label="History" onClick={onEnterPlayback} />}
              <HudAction
                icon={Settings}
                label="OpenWorld settings"
                active={location.pathname === '/openworld/settings'}
                onClick={() => navigate(location.pathname === '/openworld/settings' ? `/openworld${location.search}` : `/openworld/settings${location.search}`)}
              />
            </div>
          </div>
        </>
      ) : (
        <OpenWorldHudCompact
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
          focusedAppId={focusedAppId}
          focusedApp={focusedApp}
          focusNotFound={focusNotFound}
          focusAgents={focusAgents}
          onCloseFocus={onCloseFocus}
          onFocusInWorld={onFocusInWorld}
          onOpenFastTravel={onOpenFastTravel}
          onOpenDestination={onOpenDestination}
          onAttentionItem={onAttentionItem}
          proximityTarget={proximityTarget}
          playerPose={playerPose}
          collectedCount={collectedCount}
          totalShards={totalShards}
        />
      )}

      {explorationMode && isDesktop && <OpenWorldInteractionPrompt target={proximityTarget} />}
      <ControlsHint visible={explorationMode} isDesktop={isDesktop} />
    </div>
  );
}
