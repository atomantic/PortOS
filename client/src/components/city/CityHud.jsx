import { useState, useEffect } from 'react';
import CityActivityLog from './CityActivityLog';
import CityAgentBar from './CityAgentBar';

export default function CityHud({ cosStatus, cosAgents, agentMap, eventLogs, connected, apps }) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const activeApps = apps.filter(a => !a.archived && a.overallStatus === 'online').length;
  const totalApps = apps.filter(a => !a.archived).length;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {/* Top-left: Clock + system status */}
      <div className="absolute top-3 left-3 pointer-events-auto">
        <div className="bg-black/70 backdrop-blur-sm border border-cyan-500/30 rounded-lg px-4 py-2.5">
          <div className="font-pixel text-cyan-400 text-lg tracking-wider">
            {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
          <div className="font-pixel text-[10px] text-cyan-600 tracking-wide">
            {activeApps}/{totalApps} SYSTEMS ONLINE
          </div>
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
