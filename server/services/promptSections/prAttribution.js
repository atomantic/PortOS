import { forgeLabelName, formatLabelCreateCommand, normalizePlannerId } from '../../lib/dispatchLabels.js';
import { shellQuote } from '../../lib/shellQuote.js';

/**
 * Runtime identity reaches stored/custom claim prompts without rewriting them. Nothing reads these
 * labels back, so the section is one best-effort instruction: no read-back, repair or failure report (#16571).
 * Kept to 2 lines on purpose; a test pins it.
 */
export function buildPrAttributionSection({ model = null, forgeCli = 'gh' } = {}) {
  // A provider name identifies a runner, not the model that opened the PR.
  const id = normalizePlannerId(model);
  const heading = '## PR Model Attribution';
  if (!id) return `${heading}\nNo opener model was resolved for this run: label the PR \`implementer:<model>\` only from a model your execution context verifies, never a guess; otherwise omit it.`;
  const cli = forgeCli === 'glab' ? 'glab' : 'gh';
  const label = forgeLabelName(`implementer:${id}`, { cli });
  const create = cli === 'glab' ? 'glab mr create' : 'gh pr create';
  return `${heading}\nWhen YOU open a PR/MR, add \`--label ${shellQuote(label)}\` to \`${create}\` after \`${formatLabelCreateCommand(label, { cli })}\`. Best-effort: no read-back or repair, and keep an existing PR's original label.`;
}
