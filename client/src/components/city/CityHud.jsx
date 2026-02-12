import { useState, useEffect, useMemo, useRef } from 'react';
import CityActivityLog from './CityActivityLog';
import CityAgentBar from './CityAgentBar';

// Format uptime from page load
const formatUptime = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

// Weather status text based on system health
const getWeatherStatus = (onlineRatio) => {
  if (onlineRatio >= 1.0) return { text: 'CLEAR', color: 'text-emerald-400', icon: '//' };
  if (onlineRatio >= 0.8) return { text: 'FAIR', color: 'text-cyan-400', icon: '~' };
  if (onlineRatio >= 0.5) return { text: 'OVERCAST', color: 'text-amber-400', icon: '%%' };
  if (onlineRatio >= 0.2) return { text: 'RAIN', color: 'text-orange-400', icon: '||' };
  return { text: 'STORM', color: 'text-red-400', icon: '!!' };
};

// Animated corner decoration for HUD panels
function HudCorner({ position = 'tl', color = 'cyan' }) {
  const corners = {
    tl: 'top-0 left-0 border-t border-l',
    tr: 'top-0 right-0 border-t border-r',
    bl: 'bottom-0 left-0 border-b border-l',
    br: 'bottom-0 right-0 border-b border-r',
  };

  return (
    <div
      className={`absolute w-2 h-2 ${corners[position]} border-${color}-400/60`}
      style={{ borderWidth: '1px' }}
    />
  );
}

// Glitch text effect - brief visual corruption
function GlitchTitle({ text, className }) {
  const [glitching, setGlitching] = useState(false);
  const intervalRef = useRef(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      if (Math.random() > 0.92) {
        setGlitching(true);
        setTimeout(() => setGlitching(false), 100 + Math.random() * 150);
      }
    }, 2000);
    return () => clearInterval(intervalRef.current);
  }, []);

  return (
    <div className={`relative ${className}`}>
      <span className={glitching ? 'opacity-0' : ''}>{text}</span>
      {glitching && (
        <>
          <span
            className="absolute inset-0 text-red-400/60"
            style={{ transform: 'translateX(2px)' }}
          >
            {text}
          </span>
          <span
            className="absolute inset-0 text-cyan-400/60"
            style={{ transform: 'translateX(-2px)' }}
          >
            {text}
          </span>
        </>
      )}
    </div>
  );
}

// System health bar visualization
function HealthBar({ value, max, color }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="w-full h-1 bg-gray-800/60 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-1000"
        style={{
          width: `${pct}%`,
          backgroundColor: color,
          boxShadow: `0 0 4px ${color}`,
        }}
      />
    </div>
  );
}

export default function CityHud({ cosStatus, cosAgents, agentMap, eventLogs, connected, apps, productivityData }) {
  const [time, setTime] = useState(new Date());
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  const [scanLine, setScanLine] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date());
      setUptimeSeconds(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Animated scan line in the vitals panel
  useEffect(() => {
    const interval = setInterval(() => {
      setScanLine(prev => (prev + 1) % 100);
    }, 50);
    return () => clearInterval(interval);
  }, []);

  const activeApps = apps.filter(a => !a.archived && a.overallStatus === 'online').length;
  const stoppedApps = apps.filter(a => !a.archived && a.overallStatus === 'stopped').length;
  const totalApps = apps.filter(a => !a.archived).length;
  const archivedApps = apps.filter(a => a.archived).length;

  const onlineRatio = totalApps > 0 ? activeApps / totalApps : 1;
  const weather = useMemo(() => getWeatherStatus(onlineRatio), [onlineRatio]);

  const activeAgentCount = (cosAgents || []).filter(a =>
    a.status === 'running' || a.state === 'coding' || a.state === 'thinking' || a.state === 'investigating'
  ).length;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {/* Top-left: Clock + system status + vitals */}
      <div className="absolute top-3 left-3 pointer-events-auto">
        <div className="relative bg-black/80 backdrop-blur-sm border border-cyan-500/30 rounded-lg px-4 py-2.5 overflow-hidden">
          <HudCorner position="tl" />
          <HudCorner position="tr" />
          <HudCorner position="bl" />
          <HudCorner position="br" />

          <div className="font-pixel text-cyan-400 text-lg tracking-wider" style={{ textShadow: '0 0 8px rgba(6,182,212,0.5)' }}>
            {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
          <div className="font-pixel text-[10px] text-cyan-600 tracking-wide">
            {activeApps}/{totalApps} SYSTEMS ONLINE
          </div>

          {/* System health bar */}
          <div className="mt-1.5">
            <HealthBar value={activeApps} max={totalApps} color="#06b6d4" />
          </div>
        </div>

        {/* System Vitals panel */}
        <div className="relative mt-2 bg-black/80 backdrop-blur-sm border border-cyan-500/20 rounded-lg px-3 py-2 space-y-1 overflow-hidden">
          <HudCorner position="tl" />
          <HudCorner position="tr" />
          <HudCorner position="bl" />
          <HudCorner position="br" />

          {/* Animated scan line */}
          <div
            className="absolute left-0 right-0 h-px bg-cyan-400/10 pointer-events-none"
            style={{ top: `${scanLine}%` }}
          />

          <div className="font-pixel text-[9px] text-cyan-500/60 tracking-wider mb-1">
            SYSTEM VITALS
          </div>

          {/* Uptime */}
          <div className="flex items-center justify-between gap-4">
            <span className="font-pixel text-[9px] text-gray-500 tracking-wide">UPTIME</span>
            <span className="font-pixel text-[10px] text-cyan-400" style={{ textShadow: '0 0 4px rgba(6,182,212,0.3)' }}>
              {formatUptime(uptimeSeconds)}
            </span>
          </div>

          {/* Weather (system health) */}
          <div className="flex items-center justify-between gap-4">
            <span className="font-pixel text-[9px] text-gray-500 tracking-wide">WEATHER</span>
            <span className={`font-pixel text-[10px] ${weather.color}`}>
              <span className="opacity-50 mr-1">{weather.icon}</span>{weather.text}
            </span>
          </div>

          {/* Active agents */}
          <div className="flex items-center justify-between gap-4">
            <span className="font-pixel text-[9px] text-gray-500 tracking-wide">AGENTS</span>
            <span className={`font-pixel text-[10px] ${activeAgentCount > 0 ? 'text-emerald-400' : 'text-gray-600'}`}>
              {activeAgentCount > 0 && <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse" />}
              {activeAgentCount} ACTIVE
            </span>
          </div>

          {/* Stopped count */}
          {stoppedApps > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span className="font-pixel text-[9px] text-gray-500 tracking-wide">STOPPED</span>
              <span className="font-pixel text-[10px] text-amber-400" style={{ textShadow: '0 0 4px rgba(245,158,11,0.3)' }}>
                {stoppedApps}
              </span>
            </div>
          )}

          {/* Archived */}
          {archivedApps > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span className="font-pixel text-[9px] text-gray-500 tracking-wide">ARCHIVED</span>
              <span className="font-pixel text-[10px] text-gray-600">{archivedApps}</span>
            </div>
          )}

          {/* Productivity - today's tasks */}
          {productivityData?.todaySucceeded > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span className="font-pixel text-[9px] text-gray-500 tracking-wide">TASKS</span>
              <span className="font-pixel text-[10px] text-purple-400" style={{ textShadow: '0 0 4px rgba(168,85,247,0.3)' }}>
                {productivityData.todaySucceeded} TODAY
              </span>
            </div>
          )}

          {/* Streak */}
          {productivityData?.currentDailyStreak > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span className="font-pixel text-[9px] text-gray-500 tracking-wide">STREAK</span>
              <span className={`font-pixel text-[10px] ${productivityData.currentDailyStreak >= 3 ? 'text-orange-400' : 'text-gray-400'}`}>
                {productivityData.currentDailyStreak}d
              </span>
            </div>
          )}

          {/* Divider */}
          <div className="border-t border-cyan-500/10 mt-1 pt-1">
            <div className="flex items-center justify-between">
              <span className="font-pixel text-[8px] text-cyan-500/30 tracking-widest">SYS.OK</span>
              <span className="font-pixel text-[8px] text-cyan-500/30 tracking-widest">
                {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Top-center: CyberCity title with glitch effect */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-none">
        <GlitchTitle
          text="CYBERCITY"
          className="font-pixel text-cyan-400/50 text-sm tracking-[0.4em]"
        />
        <div className="font-pixel text-[8px] text-cyan-400/20 tracking-[0.2em] text-center mt-0.5">
          v{totalApps}.{activeApps}.{activeAgentCount}
        </div>
      </div>

      {/* Top-right: Connection + CoS status */}
      <div className="absolute top-3 right-3 pointer-events-auto">
        <div className="relative bg-black/80 backdrop-blur-sm border border-cyan-500/30 rounded-lg px-3 py-2 flex items-center gap-3">
          <HudCorner position="tl" />
          <HudCorner position="tr" />
          <HudCorner position="bl" />
          <HudCorner position="br" />

          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_6px_rgba(34,197,94,0.5)]' : 'bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.5)]'}`} />
            <span className="font-pixel text-[10px] text-gray-400 tracking-wide">
              {connected ? 'LINK' : 'OFFLINE'}
            </span>
          </div>
          <div className="w-px h-4 bg-cyan-500/20" />
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${cosStatus?.running ? 'bg-cyan-400 animate-pulse shadow-[0_0_6px_rgba(6,182,212,0.5)]' : 'bg-gray-600'}`} />
            <span className="font-pixel text-[10px] text-gray-400 tracking-wide">
              CoS {cosStatus?.running ? 'RUN' : 'IDLE'}
            </span>
          </div>
        </div>
      </div>

      {/* Right side: Activity log */}
      <CityActivityLog logs={eventLogs} />

      {/* Bottom: Agent status bar */}
      <CityAgentBar cosAgents={cosAgents} agentMap={agentMap} />

      {/* Bottom-left corner decoration */}
      <div className="absolute bottom-16 left-3 pointer-events-none">
        <div className="font-pixel text-[8px] text-cyan-500/15 tracking-widest leading-tight">
          {'>'} SYS.INIT<br/>
          {'>'} NET.LINK<br/>
          {'>'} HUD.READY
        </div>
      </div>
    </div>
  );
}
