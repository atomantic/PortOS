import { forgeLabelName, formatLabelCreateCommand, normalizePlannerId } from '../../lib/dispatchLabels.js';
import { LOCAL_REVIEW_ATTRIBUTION_GUIDE } from '../../lib/localReviewBridge.js';
import { shellQuote } from '../../lib/shellQuote.js';

/** Runtime identity reaches stored/custom claim prompts without rewriting them. */
export function buildPrAttributionSection({ model = null, forgeCli = 'gh', includeReview = true } = {}) {
  // A provider name identifies a runner, not the model that opened the PR.
  const id = normalizePlannerId(model);
  const reviewNote = includeReview ? `\n\nBefore pre-PR review/creation READ \`${LOCAL_REVIEW_ATTRIBUTION_GUIDE}\`: apply/verify additive \`reviewer:<model>\` labels from executed reviews only. Preserve existing labels; exclude configured/queued reviewers and requested forge users.` : '';
  const heading = '## PR Model Attribution';
  if (!id) return `${heading}\n\nWhen opening a PR/MR, use the model supplied by your trusted execution context for an implementer:<model> label (implementer::<model> on GitLab). PortOS did not resolve a model for this run. Never guess from your provider name, issue routing labels, reviewer model, or self-identification. If no model can be verified, report the missing attribution in your completion summary.${reviewNote}`;
  const cli = forgeCli === 'glab' ? 'glab' : 'gh';
  const label = forgeLabelName(`implementer:${id}`, { cli });
  const create = cli === 'glab' ? 'glab mr create' : 'gh pr create';
  const edit = cli === 'glab' ? `glab mr update <mr> --label ${shellQuote(label)}` : `gh pr edit <pr> --add-label ${shellQuote(label)}`;
  return `${heading}\n\nPR opener model for this run: ${id}. When YOU open a PR/MR (including scheduled claim-issue and manual direct claims), add \`--label ${shellQuote(label)}\` to \`${create}\`. This is independent of issue dispatch tiers (model:/effort:) and planner attribution; never copy those as PR authorship.
Create the repository label if missing: \`${formatLabelCreateCommand(label, { cli })}\`. After creation, read the PR/MR labels back and verify that \`${label}\` is present. If missing, apply \`${edit}\` and verify again. Report any unresolved label failure in your completion summary; do not claim attribution succeeded.
If you delegate PR creation, the opening agent must use its own trusted runtime model, not this coordinator's label or a reviewer's model. When resuming an existing PR, preserve its original opener attribution; repair a missing label only with evidence of the original opener's model.${reviewNote}`;
}
