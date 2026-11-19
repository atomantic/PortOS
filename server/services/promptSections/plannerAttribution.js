/**
 * Planner-attribution prompt section (`planner:<model>`). An agent cannot reliably
 * name its own model, so PortOS resolves the identity at spawn time
 * (`resolvePlannerId`) and hands over the finished label; emitted for every run
 * since filing an issue isn't knowable from task metadata.
 */

import {
  formatPlannerLabelGuidance, resolvePlannerId, mandatoryDispatchHintGuidance,
  MANDATORY_DISPATCH_HINT_GUIDANCE, GITLAB_DISPATCH_SEPARATOR_GUIDANCE,
} from '../../lib/dispatchLabels.js';

/**
 * The `## Planner Attribution` section, or '' when no identity resolves (never invite a guessed label).
 * @param {object} options
 * @param {string|null} [options.providerId] - resolved provider id
 * @param {string|null} [options.model] - resolved per-task model
 * @param {'gh'|'glab'} [options.forgeCli] - forge the run would file into
 */
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
const EMBEDDED_GITLAB_CONTRACT = collapseWhitespace(mandatoryDispatchHintGuidance({ cli: 'glab' }));

/**
 * Runtime contract for stored/custom tasks and follow-ups, skipped when the task body
 * already embeds it (templates keep their embed so the prompt editor shows a complete
 * prompt). Whitespace-collapsed match: an indented copy matches, a paraphrase does not.
 * Attribution is always emitted: a task cannot name its own model. The templates embed the
 * GitHub form (the GitLab claim template embeds the GitLab form), so a `glab` run whose body
 * embeds only the GitHub form still gets the GitLab separator paragraph.
 * @param {string[]} [options.taskBody] - rendered task parts (description, context)
 * @param {object} [options]
 */
export function buildIssueFilingSection({ taskBody = [], ...options } = {}) {
  const attribution = buildPlannerAttributionSection(options);
  const glab = options.forgeCli === 'glab';
  const parts = taskBody.map(collapseWhitespace);
  if (glab && parts.some((part) => part.includes(EMBEDDED_GITLAB_CONTRACT) || part.includes('claim-issue-filing-gitlab'))) return attribution;
  const embedded = parts.some((part) => part.includes(EMBEDDED_CONTRACT) || part.includes('claim-issue-filing-github'));
  if (embedded && !glab) return attribution;
  const contract = embedded ? GITLAB_DISPATCH_SEPARATOR_GUIDANCE : mandatoryDispatchHintGuidance({ cli: glab ? 'glab' : 'gh' });
  return `## Issue Filing Labels\n\n${contract}${attribution ? `\n\n${attribution}` : ''}`;
}
