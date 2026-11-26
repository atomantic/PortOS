import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, ThumbsDown, ThumbsUp } from 'lucide-react';
import { isAgentFeedbackUpdateTarget } from '../../../lib/cosAgentFeedback';
import { submitCosAgentFeedback } from '../../../services/apiAgents.js';
import toast from '../../ui/Toast';

export default function AgentFeedbackForm({ agent, remote, onFeedbackChange }) {
  const [feedbackState, setFeedbackState] = useState(agent.feedback?.rating || null);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [showFeedbackComment, setShowFeedbackComment] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState(agent.feedback?.comment || '');

  // Sync feedback state when parent refreshes agent data
  useEffect(() => {
    if (agent.feedback?.rating) setFeedbackState(agent.feedback.rating);
  }, [agent.feedback?.rating]);

  // Handle feedback submission
  const submitFeedback = useCallback(async (rating) => {
    if (submittingFeedback) return;
    setSubmittingFeedback(true);

    const result = await submitCosAgentFeedback(agent.id, {
      rating,
      comment: feedbackComment || undefined
    }, { silent: true }).catch(err => {
      toast.error(`Failed to submit feedback: ${err.message}`);
      return null;
    });

    setSubmittingFeedback(false);

    if (result?.success) {
      setFeedbackState(rating);
      setShowFeedbackComment(false);
      setFeedbackComment(result.agent?.feedback?.comment || '');
      toast.success(`Feedback recorded: ${rating}`);
      onFeedbackChange?.(result.agent, agent);
    }
  }, [agent, feedbackComment, submittingFeedback, onFeedbackChange]);

  /* Feedback section - shown for completed, manually-run, non-system local
      agents. A handoff has no result to rate — the continuation run asks for
      the rating that covers this work — so it is excluded UNLESS a rating is
      already on the record: pre-upgrade handoffs were ratable, and hiding the
      block outright would swallow a verdict the user did give. */
  if (!isAgentFeedbackUpdateTarget(agent) || remote) return null;

  return (
    <div className="mt-2 pt-1 border-t border-port-border/50">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-500">Was this helpful?</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => submitFeedback('positive')}
            disabled={submittingFeedback}
            className={`min-h-[44px] min-w-[44px] flex items-center justify-center p-1.5 rounded transition-colors ${
              feedbackState === 'positive'
                ? 'bg-port-success/30 text-port-success'
                : 'text-gray-500 hover:text-port-success hover:bg-port-success/10'
            } disabled:opacity-50`}
            title="Helpful"
            aria-label={`Mark as helpful: ${agent.id}`}
            aria-pressed={feedbackState === 'positive'}
          >
            <ThumbsUp size={14} />
          </button>
          <button
            onClick={() => submitFeedback('negative')}
            disabled={submittingFeedback}
            className={`min-h-[44px] min-w-[44px] flex items-center justify-center p-1.5 rounded transition-colors ${
              feedbackState === 'negative'
                ? 'bg-port-error/30 text-port-error'
                : 'text-gray-500 hover:text-port-error hover:bg-port-error/10'
            } disabled:opacity-50`}
            title="Not helpful"
            aria-label={`Mark as not helpful: ${agent.id}`}
            aria-pressed={feedbackState === 'negative'}
          >
            <ThumbsDown size={14} />
          </button>
          <button
            onClick={() => setShowFeedbackComment(!showFeedbackComment)}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1.5 rounded text-gray-500 hover:text-white hover:bg-port-border/50 transition-colors"
            title={feedbackState ? 'Add feedback detail' : 'Add feedback comment'}
            aria-label={`${feedbackState ? 'Add feedback detail' : 'Add feedback comment'}: ${agent.id}`}
            aria-expanded={showFeedbackComment}
          >
            <MessageSquare size={14} />
          </button>
        </div>
        {feedbackState && (
          <span className={`text-xs ${feedbackState === 'positive' ? 'text-port-success' : feedbackState === 'negative' ? 'text-port-error' : 'text-gray-400'}`}>
            {feedbackState === 'positive' ? 'Thanks for the feedback!' : feedbackState === 'negative' ? 'We\'ll improve' : 'Feedback recorded'}
          </span>
        )}
      </div>
      {/* Comment input */}
      {showFeedbackComment && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={feedbackComment}
            onChange={(e) => setFeedbackComment(e.target.value)}
            placeholder="What made this work well or poorly?"
            aria-label="Feedback comment"
            className="flex-1 px-2 py-1 text-sm bg-port-bg border border-port-border rounded text-white placeholder-gray-500 focus:outline-hidden focus:border-port-accent min-h-[32px]"
            maxLength={200}
          />
          {feedbackState ? (
            <button
              onClick={() => submitFeedback(feedbackState)}
              disabled={submittingFeedback || !feedbackComment.trim()}
              className="px-3 py-1 text-xs bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50 min-h-[32px]"
            >
              Save detail
            </button>
          ) : (
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => submitFeedback('positive')}
                disabled={submittingFeedback || !feedbackComment.trim()}
                className="px-2 py-1 text-xs text-port-success border border-port-success/40 hover:bg-port-success/10 rounded disabled:opacity-50 min-h-[32px]"
              >
                Helpful
              </button>
              <button
                onClick={() => submitFeedback('negative')}
                disabled={submittingFeedback || !feedbackComment.trim()}
                className="px-2 py-1 text-xs text-port-error border border-port-error/40 hover:bg-port-error/10 rounded disabled:opacity-50 min-h-[32px]"
              >
                Needs work
              </button>
              <button
                onClick={() => submitFeedback('neutral')}
                disabled={submittingFeedback || !feedbackComment.trim()}
                className="px-2 py-1 text-xs text-gray-300 border border-port-border hover:bg-port-border/50 rounded disabled:opacity-50 min-h-[32px]"
              >
                Neutral
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
