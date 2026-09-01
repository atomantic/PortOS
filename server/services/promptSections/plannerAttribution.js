/**
 * Planner-attribution prompt section (`planner:<model>`).
 *
 * An issue-filing agent cannot reliably name its own model — self-identification
 * is exactly the thing LLMs get wrong — so PortOS resolves the run's identity at
 * spawn time (`resolvePlannerId` over the provider + model `agentLifecycle`
 * actually dispatched with) and hands the agent the finished label. The shared
 * dispatch guidance in `lib/dispatchLabels.js` tells every planner prompt that
 * the axis exists and to take its value verbatim from HERE.
 *
 * Emitted for every run rather than only the ones we predict will file: a task
 * that files an issue is not identifiable from its metadata (a claim run files
 * follow-ups, an audit run files findings), and the section is four lines.
 */

import { formatPlannerLabelGuidance, resolvePlannerId } from '../../lib/dispatchLabels.js';

/**
 * The `## Planner Attribution` section for one run, or '' when PortOS could not
 * resolve an identity — an unattributable run says nothing rather than inviting
 * the agent to guess a label.
 *
 * @param {object} options
 * @param {string|null} [options.providerId] - resolved provider id
 * @param {string|null} [options.model] - resolved per-task model
 * @param {'gh'|'glab'} [options.forgeCli] - forge the run would file into
 * @returns {string}
 */
export function buildPlannerAttributionSection({ providerId = null, model = null, forgeCli = 'gh' } = {}) {
  const guidance = formatPlannerLabelGuidance(
    resolvePlannerId({ providerId, model }),
    { cli: forgeCli === 'glab' ? 'glab' : 'gh' }
  );
  if (!guidance) return '';
  return `## Planner Attribution\n\n${guidance}`;
}
