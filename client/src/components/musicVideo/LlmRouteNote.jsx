import { llmRouteLabel } from '../../lib/musicVideoAutomation.js';

/**
 * The model a Music Video text stage (AI Plan, Treatment compile, Cast & Sets)
 * last ran on, shown the same way beside each of them (#10223). `route` is the
 * stage's recorded route (`project.automation.routes[stage]`) or any
 * `{ providerId, model, … }`; nothing renders until a stage has run. A pin
 * whose provider no longer resolved says what it was replaced.
 */
export default function LlmRouteNote({ route, prefix = 'Ran on', className = '' }) {
  if (!route?.providerId) return null;
  return (
    <span data-testid="llm-route" className={`text-[11px] text-port-text-muted break-words ${className}`}>
      {prefix} {llmRouteLabel(route)}
      {route.requestedProviderId ? ` — replaced the unavailable ${route.requestedProviderId}` : ''}
    </span>
  );
}
