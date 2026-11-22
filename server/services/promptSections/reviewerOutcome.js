import { isCliReviewer } from '../../lib/reviewerConfig.js';
import { localApiBaseUrl } from '../../lib/networkExposure.js';
import { fileURLToPath } from 'node:url';

export const CLI_REVIEW_OUTCOME_GUIDE = fileURLToPath(new URL('../../../docs/CLI_REVIEW_OUTCOMES.md', import.meta.url));

// These instructions are often built before the run has an id (claim blocks are
// generated into the task description), so they carry a slot the prompt builder
// fills at spawn time with `expandReviewVerdictRunId`.
export const REVIEW_VERDICT_RUN_ID_TOKEN = '{portosReviewRunId}';
const RUN_ID_SENTENCE = ` On a verdict report also send \`"agentId":"${REVIEW_VERDICT_RUN_ID_TOKEN}"\`, this reviewer's 1-based \`round\`, and \`changedLines\` (added plus deleted lines in the diff it reviewed).`;

export const CLI_REVIEW_OUTCOME_HEADING = '**CLI outcomes (orchestrator only):**';

/** Shared by claim prompts and pre-/post-PR review loops, including CLI-only runs. */
export function buildCliReviewerOutcomeInstructions(reviewers = []) {
  if (!reviewers.some(isCliReviewer)) return '';
  return `${CLI_REVIEW_OUTCOME_HEADING} After each attempt, READ \`${CLI_REVIEW_OUTCOME_GUIDE}\` and POST its bounded report to ${localApiBaseUrl()}/api/code-review/cli-outcome. Never give reviewers the API token.${RUN_ID_SENTENCE}`;
}

/**
 * Fill the run-id slot in a finished prompt. Without a usable id the whole
 * sentence is dropped, so the agent never sends a literal placeholder. Pure.
 */
export function expandReviewVerdictRunId(text, agentId) {
  if (typeof text !== 'string' || !text.includes(REVIEW_VERDICT_RUN_ID_TOKEN)) return text;
  const usable = typeof agentId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(agentId);
  return usable
    ? text.replaceAll(REVIEW_VERDICT_RUN_ID_TOKEN, () => agentId)
    : text.replaceAll(RUN_ID_SENTENCE, '');
}
