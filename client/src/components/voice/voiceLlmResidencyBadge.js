// Display copy for a Voice LLM residency state; `null` for states with nothing honest to say (hosted or unread).
const BADGES = {
  loaded: { label: 'In memory', short: 'ready', led: 'bg-port-success' },
  loading: { label: 'Loading into memory…', short: 'loading', led: 'bg-port-warning animate-pulse' },
  unloaded: { label: 'Not loaded · loads on first reply', short: 'not loaded', led: 'bg-port-text-muted' },
  offline: { label: 'Model server offline', short: 'offline', led: 'bg-port-error' },
};

export const voiceLlmResidencyBadge = (state) => BADGES[state] || null;
