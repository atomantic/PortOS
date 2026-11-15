/**
 * Client mirror of the server-owned CoS feedback eligibility contract.
 *
 * Client mirror of the server-owned CoS feedback eligibility, rating, legacy-update-target, and
 * archive-locator predicates.
 */

export {
  FEEDBACK_RATINGS,
  feedbackArchiveDate,
  hasValidAgentFeedback,
  isAgentFeedbackEligible,
  isAgentFeedbackTarget,
  isAgentFeedbackUpdateTarget,
  isFeedbackRating,
  isManualUserAgent,
  isSystemAgent,
} from '../../../server/lib/cosAgentFeedback.js';
