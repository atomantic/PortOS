/**
 * Planner-attribution prompt section (`planner:<model>`). An agent cannot reliably
 * name its own model, so PortOS resolves the identity at spawn time
 * (`resolvePlannerId`) and hands over the finished label; emitted for every run
 * since filing an issue isn't knowable from task metadata.
 */

import { formatPlannerLabelGuidance, resolvePlannerId, MANDATORY_DISPATCH_HINT_GUIDANCE } from '../../lib/dispatchLabels.js';

/** The `## Planner Attribution` section, or '' when no identity resolves (never invite a guessed label). */
export function buildPlannerAttributionSection({ providerId = null, model = null, forgeCli = 'gh' } = {}) {
  const guidance = formatPlannerLabelGuidance(
    resolvePlannerId({ providerId, model }),
    { cli: forgeCli === 'glab' ? 'glab' : 'gh' }
  );
  if (!guidance) return '';
  return `## Planner Attribution\n\n${guidance}`;
}

const collapseWhitespace = (text) => String(text || '').replace(/\s+/g, ' ');
const EMBEDDED_CONTRACT = collapseWhitespace(MANDATORY_DISPATCH_HINT_GUIDANCE);

/**
 * Runtime contract for stored/custom tasks and follow-ups, skipped when the task body
 * already embeds it (templates keep their embed so the prompt editor shows a complete
 * prompt). Whitespace-collapsed match: an indented copy matches, a paraphrase does not.
 * Attribution is always emitted: a task cannot name its own model.
 * @param {string[]} [options.taskBody] - rendered task parts (description, context)
 */
export function buildIssueFilingSection({ taskBody = [], ...options } = {}) {
  const attribution = buildPlannerAttributionSection(options);
  if (taskBody.some((part) => collapseWhitespace(part).includes(EMBEDDED_CONTRACT))) return attribution;
  return `## Issue Filing Labels\n\n${MANDATORY_DISPATCH_HINT_GUIDANCE}${attribution ? `\n\n${attribution}` : ''}`;
}
