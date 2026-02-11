import { AGENT_STATES } from '../cos/constants';

export default function CityAgentBar({ cosAgents, agentMap }) {
  // Only show active/running agents
  const activeAgents = (cosAgents || []).filter(a =>
    a.status === 'running' || a.state === 'coding' || a.state === 'thinking' || a.state === 'investigating'
  );

  if (activeAgents.length === 0) return null;

  // Find which app each agent is working on
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
      <div className="bg-black/60 backdrop-blur-sm border border-cyan-500/20 rounded-lg px-3 py-2">
        <div className="flex items-center gap-3 overflow-x-auto">
          <span className="text-cyan-400 text-[10px] font-mono font-bold shrink-0">AGENTS</span>
          {activeAgents.map((agent, i) => {
            const state = agent.state || 'coding';
            const stateConfig = AGENT_STATES[state];
            const appName = getAppName(agent);

            return (
              <div
                key={agent.agentId || i}
                className="flex items-center gap-1.5 px-2 py-1 bg-black/40 border border-white/10 rounded text-[10px] font-mono shrink-0"
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: stateConfig?.color || '#06b6d4' }}
                />
                <span className="text-gray-300">{agent.type || 'agent'}</span>
                {appName && (
                  <>
                    <span className="text-gray-600">|</span>
                    <span className="text-cyan-400/70 truncate max-w-[100px]">{appName}</span>
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
