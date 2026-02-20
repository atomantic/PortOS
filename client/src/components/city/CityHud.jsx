import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
  if (onlineRatio >= 1.0) return { text: 'CLEAR', color: 'text-emerald-400', icon: '//', desc: 'All systems operational' };
  if (onlineRatio >= 0.8) return { text: 'FAIR', color: 'text-cyan-400', icon: '~', desc: 'Minor issues detected' };
  if (onlineRatio >= 0.5) return { text: 'OVERCAST', color: 'text-amber-400', icon: '%%', desc: 'Multiple systems down' };
  if (onlineRatio >= 0.2) return { text: 'RAIN', color: 'text-orange-400', icon: '||', desc: 'Significant outages' };
  return { text: 'STORM', color: 'text-red-400', icon: '!!', desc: 'Critical system failure' };
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
  const navigate = useNavigate();
  const location = useLocation();
  const [time, setTime] = useState(new Date());
  const [uptimeSeconds, setUptimeSeconds] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date());
      setUptimeSeconds(prev => prev + 1);
    }, 1000);
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
        <div className="relative mt-2 bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg px-3 py-2.5 space-y-1.5 overflow-hidden">
          <HudCorner position="tl" />
          <HudCorner position="tr" />
          <HudCorner position="bl" />
          <HudCorner position="br" />

          {/* Animated scan line (CSS-only, no React re-renders) */}
          <div
            className="absolute left-0 right-0 h-px bg-cyan-400/15 pointer-events-none animate-scanline"
          />

          <div className="font-pixel text-[10px] text-cyan-500/70 tracking-wider mb-1">
            SYSTEM VITALS
          </div>

          {/* Uptime */}
          <div className="flex items-center justify-between gap-6">
            <span className="font-pixel text-[10px] text-gray-400 tracking-wide">UPTIME</span>
            <span className="font-pixel text-[11px] text-cyan-400" style={{ textShadow: '0 0 6px rgba(6,182,212,0.4)' }}>
              {formatUptime(uptimeSeconds)}
            </span>
          </div>

          {/* Weather (system health) */}
          <div className="flex items-center justify-between gap-6" title={weather.desc}>
            <span className="font-pixel text-[10px] text-gray-400 tracking-wide">WEATHER</span>
            <span className={`font-pixel text-[11px] ${weather.color}`}>
              <span className="opacity-60 mr-1">{weather.icon}</span>{weather.text}
            </span>
          </div>

          {/* Active agents */}
          <div className="flex items-center justify-between gap-6">
            <span className="font-pixel text-[10px] text-gray-400 tracking-wide">AGENTS</span>
            <span className={`font-pixel text-[11px] ${activeAgentCount > 0 ? 'text-emerald-400' : 'text-gray-600'}`}>
              {activeAgentCount > 0 && <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse" />}
              {activeAgentCount} ACTIVE
            </span>
          </div>

          {/* Stopped count */}
          {stoppedApps > 0 && (
            <div className="flex items-center justify-between gap-6">
              <span className="font-pixel text-[10px] text-gray-400 tracking-wide">STOPPED</span>
              <span className="font-pixel text-[11px] text-red-400" style={{ textShadow: '0 0 4px rgba(239,68,68,0.3)' }}>
                {stoppedApps}
              </span>
            </div>
          )}

          {/* Archived */}
          {archivedApps > 0 && (
            <div className="flex items-center justify-between gap-6">
              <span className="font-pixel text-[10px] text-gray-400 tracking-wide">ARCHIVED</span>
              <span className="font-pixel text-[11px] text-gray-500">{archivedApps}</span>
            </div>
          )}

          {/* Productivity - today's tasks */}
          {productivityData?.todaySucceeded > 0 && (
            <div className="flex items-center justify-between gap-6">
              <span className="font-pixel text-[10px] text-gray-400 tracking-wide">TASKS</span>
              <span className="font-pixel text-[11px] text-purple-400" style={{ textShadow: '0 0 4px rgba(168,85,247,0.3)' }}>
                {productivityData.todaySucceeded} TODAY
              </span>
            </div>
          )}

          {/* Streak */}
          {productivityData?.currentDailyStreak > 0 && (
            <div className="flex items-center justify-between gap-6">
              <span className="font-pixel text-[10px] text-gray-400 tracking-wide">STREAK</span>
              <span className={`font-pixel text-[11px] ${productivityData.currentDailyStreak >= 3 ? 'text-orange-400' : 'text-gray-400'}`}>
                {productivityData.currentDailyStreak}d
              </span>
            </div>
          )}

          {/* Divider */}
          <div className="border-t border-cyan-500/15 mt-1.5 pt-1.5">
            <div className="flex items-center justify-between">
              <span className="font-pixel text-[9px] text-cyan-500/40 tracking-widest">SYS.OK</span>
              <span className="font-pixel text-[9px] text-cyan-500/40 tracking-widest">
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
        <div className="relative bg-black/85 backdrop-blur-sm border border-cyan-500/40 rounded-lg px-4 py-2.5 flex items-center gap-4">
          <HudCorner position="tl" />
          <HudCorner position="tr" />
          <HudCorner position="bl" />
          <HudCorner position="br" />

          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse'}`} />
            <span className={`font-pixel text-[11px] tracking-wide ${connected ? 'text-gray-300' : 'text-red-400'}`}>
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

      {/* Right side: Activity log */}
      <CityActivityLog logs={eventLogs} />

      {/* Bottom: Agent status bar */}
      <CityAgentBar cosAgents={cosAgents} agentMap={agentMap} />

      {/* Bottom-left: Settings gear + legend + corner decoration */}
      <div className="absolute bottom-16 left-3">
        {/* Status legend */}
        <div className="pointer-events-none mb-2 bg-black/70 backdrop-blur-sm border border-cyan-500/15 rounded-lg px-2.5 py-2 space-y-1">
          <div className="font-pixel text-[8px] text-cyan-500/50 tracking-wider mb-1">LEGEND</div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-cyan-500" />
            <span className="font-pixel text-[8px] text-gray-400 tracking-wide">ONLINE</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-red-500" />
            <span className="font-pixel text-[8px] text-gray-400 tracking-wide">STOPPED</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-violet-500" />
            <span className="font-pixel text-[8px] text-gray-400 tracking-wide">NOT STARTED</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-slate-500" />
            <span className="font-pixel text-[8px] text-gray-400 tracking-wide">ARCHIVED</span>
          </div>
        </div>

        <button
          onClick={() => navigate(location.pathname === '/city/settings' ? '/city' : '/city/settings')}
          className="pointer-events-auto mb-2 relative bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg w-10 h-10 flex items-center justify-center hover:border-cyan-400/60 hover:bg-cyan-500/10 transition-all group"
          title="Settings"
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
    </div>
  );
}
