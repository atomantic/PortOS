import { AGENT_STATES } from './constants';

export default function StateLabel({ state, compact = false }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;

  if (compact) {
    return (
      <div
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-full font-mono text-[10px]"
        style={{
          background: 'rgba(15, 23, 42, 0.8)',
          border: `1px solid ${stateConfig.color}`
        }}
      >
        <span className="text-xs">{stateConfig.icon}</span>
        <span className="text-gray-100">{stateConfig.label}</span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-1 sm:py-2 rounded-full mt-1 sm:mt-4 font-mono text-[10px] sm:text-xs"
      style={{
        background: 'rgba(15, 23, 42, 0.8)',
        border: `1px solid ${stateConfig.color}`,
        boxShadow: `0 0 20px rgba(99, 102, 241, 0.2)`
      }}
    >
      <span className="text-xs sm:text-base">{stateConfig.icon}</span>
      <span className="text-gray-100">{stateConfig.label}</span>
    </div>
  );
}
