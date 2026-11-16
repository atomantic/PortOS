/**
 * Client mirror of the server-owned CoS feedback eligibility contract.
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
