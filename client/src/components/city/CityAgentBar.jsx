import { AGENT_STATES } from '../cos/constants';

export default function CityAgentBar({ cosAgents, agentMap }) {
  const activeAgents = (cosAgents || []).filter(a =>
    a.status === 'running' || a.state === 'coding' || a.state === 'thinking' || a.state === 'investigating'
  );

  if (activeAgents.length === 0) return null;

  const getAppName = (agent) => {
    for (const [, data] of agentMap) {
      if (data.agents.some(a => a.agentId === agent.agentId)) {
        return data.app.name;
      }
    }
    return null;
  };

  return (
    <div className="absolute bottom-3 left-3 right-3 pointer-events-auto">
      <div className="bg-black/80 backdrop-blur-sm border border-cyan-500/25 rounded-lg px-3 py-2.5">
        <div className="flex items-center gap-3 overflow-x-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(6,182,212,0.2) transparent' }}>
          <span className="text-cyan-400 text-[11px] font-pixel tracking-wider font-bold shrink-0">AGENTS</span>
          <div className="w-px h-4 bg-cyan-500/20 shrink-0" />
          {activeAgents.map((agent, i) => {
            const state = agent.state || 'coding';
            const stateConfig = AGENT_STATES[state];
            const appName = getAppName(agent);
            const stateLabel = stateConfig?.label || state;

            return (
              <div
                key={agent.agentId || i}
                className="flex items-center gap-2 px-2.5 py-1.5 bg-black/50 border border-white/10 rounded-md text-[9px] font-pixel tracking-wide shrink-0 min-h-[32px]"
                title={`${agent.type || 'agent'} - ${stateLabel}${appName ? ` (${appName})` : ''}`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0 animate-pulse"
                  style={{
                    backgroundColor: stateConfig?.color || '#06b6d4',
                    boxShadow: `0 0 6px ${stateConfig?.color || '#06b6d4'}`,
                  }}
                />
                <span className="text-gray-300">{agent.type || 'agent'}</span>
                {appName && (
                  <>
                    <span className="text-gray-600">|</span>
                    <span className="text-cyan-400/70 truncate max-w-[120px]">{appName}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
