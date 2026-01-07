import { AGENT_STATES } from './constants';

export default function StateLabel({ state }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 rounded-full mt-4 font-mono text-xs"
      style={{
        background: 'rgba(15, 23, 42, 0.8)',
        border: `1px solid ${stateConfig.color}`,
        boxShadow: `0 0 20px rgba(99, 102, 241, 0.2)`
      }}
    >
      <span className="text-base">{stateConfig.icon}</span>
      <span className="text-gray-100">{stateConfig.label}</span>
    </div>
  );
}
