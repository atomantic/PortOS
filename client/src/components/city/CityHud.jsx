import { useState, useEffect, useMemo } from 'react';
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
  if (onlineRatio >= 1.0) return { text: 'CLEAR', color: 'text-emerald-400' };
  if (onlineRatio >= 0.8) return { text: 'FAIR', color: 'text-cyan-400' };
  if (onlineRatio >= 0.5) return { text: 'OVERCAST', color: 'text-amber-400' };
  if (onlineRatio >= 0.2) return { text: 'RAIN', color: 'text-orange-400' };
  return { text: 'STORM', color: 'text-red-400' };
};

export default function CityHud({ cosStatus, cosAgents, agentMap, eventLogs, connected, apps, productivityData }) {
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
        <div className="bg-black/70 backdrop-blur-sm border border-cyan-500/30 rounded-lg px-4 py-2.5">
          <div className="font-pixel text-cyan-400 text-lg tracking-wider">
            {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
          <div className="font-pixel text-[10px] text-cyan-600 tracking-wide">
            {activeApps}/{totalApps} SYSTEMS ONLINE
          </div>
        </div>

        {/* System Vitals panel */}
        <div className="mt-2 bg-black/70 backdrop-blur-sm border border-cyan-500/20 rounded-lg px-3 py-2 space-y-1">
          <div className="font-pixel text-[9px] text-cyan-500/60 tracking-wider mb-1">VITALS</div>

          {/* Uptime */}
          <div className="flex items-center justify-between gap-4">
            <span className="font-pixel text-[9px] text-gray-500 tracking-wide">UPTIME</span>
            <span className="font-pixel text-[10px] text-cyan-400">{formatUptime(uptimeSeconds)}</span>
          </div>

          {/* Weather (system health) */}
          <div className="flex items-center justify-between gap-4">
            <span className="font-pixel text-[9px] text-gray-500 tracking-wide">WEATHER</span>
            <span className={`font-pixel text-[10px] ${weather.color}`}>{weather.text}</span>
          </div>

          {/* Active agents */}
          <div className="flex items-center justify-between gap-4">
            <span className="font-pixel text-[9px] text-gray-500 tracking-wide">AGENTS</span>
            <span className={`font-pixel text-[10px] ${activeAgentCount > 0 ? 'text-emerald-400' : 'text-gray-600'}`}>
              {activeAgentCount} ACTIVE
            </span>
          </div>

          {/* Stopped count */}
          {stoppedApps > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span className="font-pixel text-[9px] text-gray-500 tracking-wide">STOPPED</span>
              <span className="font-pixel text-[10px] text-amber-400">{stoppedApps}</span>
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
              <span className="font-pixel text-[10px] text-purple-400">
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
        </div>
      </div>

      {/* Top-center: CyberCity title */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-none">
        <div className="font-pixel text-cyan-400/40 text-xs tracking-[0.3em]">
          CYBERCITY
        </div>
      </div>

      {/* Top-right: Connection + CoS status */}
      <div className="absolute top-3 right-3 pointer-events-auto">
        <div className="bg-black/70 backdrop-blur-sm border border-cyan-500/30 rounded-lg px-3 py-2 flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
            <span className="font-pixel text-[10px] text-gray-400 tracking-wide">
              {connected ? 'LINK' : 'OFFLINE'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${cosStatus?.running ? 'bg-cyan-400 animate-pulse' : 'bg-gray-600'}`} />
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
    </div>
  );
}
