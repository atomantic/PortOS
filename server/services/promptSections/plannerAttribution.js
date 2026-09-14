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

import { formatPlannerLabelGuidance, resolvePlannerId, MANDATORY_DISPATCH_HINT_GUIDANCE } from '../../lib/dispatchLabels.js';

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

/**
 * Runtime contract reaches stored/custom tasks and follow-ups, even without a
 * planner identity.
 *
 * `taskText` is the task body the agent is about to read (description plus
 * context). The shipped claim-issue / issue-reconcile prompts embed the very
 * same contract at their top, so a run built from one of them would otherwise
 * read the ~3KB block twice — once in the task, once here. When the body
 * already carries it verbatim, only the planner attribution (which the task
 * cannot know about itself) is emitted; a customized prompt that dropped or
 * paraphrased the contract still gets the full section.
 *
 * @param {object} [options]
 * @param {string} [options.taskText] - rendered task body to dedupe against
 */
export function buildIssueFilingSection({ taskText = '', ...options } = {}) {
  const attribution = buildPlannerAttributionSection(options);
  if (taskText.includes(MANDATORY_DISPATCH_HINT_GUIDANCE)) return attribution;
  return `## Issue Filing Labels\n\n${MANDATORY_DISPATCH_HINT_GUIDANCE}${attribution ? `\n\n${attribution}` : ''}`;
}
