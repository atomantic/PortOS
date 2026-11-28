export const WORLD_ACTION_ICONS = {
  mw_explore: '🌍',
  mw_build: '🧱',
  mw_think: '💭',
  mw_say: '💬',
  mw_heartbeat: '💓',
  mw_interact: '🤝'
};

export function summarizeWorldAction(action, params) {
  if (!params) return '';
  if (action === 'mw_explore' || action === 'mw_heartbeat') {
    const parts = [];
    if (params.x != null && params.y != null) parts.push(`(${params.x}, ${params.y})`);
    if (params.thinking) parts.push(`"${params.thinking.substring(0, 40)}..."`);
    return parts.join(' ');
  }
  if (action === 'mw_think') return params.thought ? `"${params.thought.substring(0, 50)}"` : '';
  if (action === 'mw_say') return params.message ? `"${params.message.substring(0, 50)}"` : '';
  if (action === 'mw_build') return `(${params.x},${params.y},${params.z}) ${params.type || 'stone'} ${params.action || 'place'}`;
  return '';
}
