/** Define the issue comment identity, content fingerprint, queue bounds, and analysis response contract shared by intake and output. */
import { z } from 'zod';
import { modelAbuseContentFingerprint } from '../../lib/modelAbuseGuard.js';

export const MAX_ISSUE_COMMENTS_PER_RUN = 25;

export const MAX_PENDING_ISSUE_COMMENTS = 250;

// One key for a screened issue comment across screening, assignment, coverage and ageing.
export const issueCommentKey = (item) => `${item?.issueNumber}:${item?.commentId}`;

export const issueAbuseInput = (item) => [
  'Issue title:', item.issueTitle,
  'Issue description:', item.issueBody,
  'External actor:', item.commentAuthor,
  'External comment:', item.commentBody,
].join('\n\n');

// Only issue comments reach the abuse screen here; external PR intake belongs
// exclusively to pr-reviewer, which stamps its own fingerprint.
export function abuseFingerprint(item, content) {
  const kind = 'issue-comment';
  return modelAbuseContentFingerprint(kind, { kind, issueNumber: item.issueNumber, commentId: item.commentId }, content);
}

export const issueAnalysisSchema = z.object({
  issueComments: z.array(z.object({
    issueNumber: z.number().int().positive(),
    commentId: z.number().int().nonnegative(),
    action: z.enum(['reply', 'none']),
    body: z.string().max(5_000),
  }).strict()).max(MAX_ISSUE_COMMENTS_PER_RUN),
  pullRequests: z.array(z.never()).max(0),
}).strict();
