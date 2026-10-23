import { PR_COMPLETIONS } from '../lib/prDisposition.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';

export async function followUpRoster(task, policy) {
  if (policy !== PR_COMPLETIONS.REVIEW_THEN_MERGE) return { reviewers: [], usernames: [], optionalReviewers: [], reviewerMaxRounds: {} };
  const [{ resolveReviewLoopOptions }, { normalizeReviewers }] = await Promise.all([
    import('./codeReview.js'), import('../lib/validation.js'),
  ]);
  const metadata = { ...task.metadata };
  if (isTruthyMeta(metadata.reviewLoopFollowUp)) {
    for (const [key, saved] of Object.entries({ reviewers: 'reviewLoopReviewers', usernames: 'reviewLoopReviewerUsernames',
      optionalReviewers: 'reviewLoopOptionalReviewers', reviewerMaxRounds: 'reviewLoopReviewerMaxRounds',
      reviewStopMode: 'reviewLoopStopMode', reviewerModels: 'reviewLoopReviewerModels', reviewerEfforts: 'reviewLoopReviewerEfforts' })) {
      if (Object.hasOwn(metadata, saved)) metadata[key] = metadata[saved];
    }
  }
  const options = await resolveReviewLoopOptions(metadata, { normalize: normalizeReviewers });
  return {
    reviewers: options.reviewers, usernames: options.usernames,
    optionalReviewers: options.optionalReviewers, reviewerMaxRounds: options.reviewerMaxRounds,
    reviewStopMode: options.reviewStopMode, reviewerModels: options.reviewerModels, reviewerEfforts: options.reviewerEfforts,
  };
}
