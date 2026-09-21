import { isCliReviewer } from '../../lib/reviewerConfig.js';
import { localApiBaseUrl } from '../../lib/networkExposure.js';
import { fileURLToPath } from 'node:url';

export const CLI_REVIEW_OUTCOME_GUIDE = fileURLToPath(new URL('../../../docs/CLI_REVIEW_OUTCOMES.md', import.meta.url));

/** Shared by claim prompts and pre-/post-PR review loops, including CLI-only runs. */
export function buildCliReviewerOutcomeInstructions(reviewers = []) {
  if (!reviewers.some(isCliReviewer)) return '';
  return `**CLI outcomes (orchestrator only):** After each attempt, READ \`${CLI_REVIEW_OUTCOME_GUIDE}\` and POST its bounded report to ${localApiBaseUrl()}/api/code-review/cli-outcome. Never give reviewers the API token.`;
}
