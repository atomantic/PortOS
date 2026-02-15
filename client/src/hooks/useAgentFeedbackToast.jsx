import { useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import socket from '../services/socket';
import * as api from '../services/api';

/**
 * Hook that shows proactive feedback toast when agents complete tasks.
 * Prompts users for quick feedback directly in the toast notification,
 * improving feedback collection without requiring navigation to the Agents tab.
 */
export function useAgentFeedbackToast() {
  // Track which agents we've shown feedback toasts for to avoid duplicates
  const shownFeedbackFor = useRef(new Set());

  // Submit feedback for an agent
  const submitFeedback = useCallback(async (agentId, rating, toastId) => {
    const result = await api.submitCosAgentFeedback(agentId, { rating }).catch(() => null);

    // Dismiss the feedback toast
    toast.dismiss(toastId);

    if (result?.success) {
      const emoji = rating === 'positive' ? '👍' : rating === 'negative' ? '👎' : '💬';
      toast(`Feedback recorded ${emoji}`, { duration: 2000 });
    }
  }, []);

  useEffect(() => {
    // Subscribe to CoS events
    socket.emit('cos:subscribe');

    // Handle agent completion events
    const handleAgentCompleted = (data) => {
      // Skip system agents and already-shown agents
      const agentId = data?.id || data?.agentId;
      const isSystem = data?.taskId?.startsWith('sys-') || agentId?.startsWith('sys-');

      if (!agentId || isSystem || shownFeedbackFor.current.has(agentId)) {
        return;
      }

      // Mark as shown to prevent duplicates
      shownFeedbackFor.current.add(agentId);

      // Get task description for display
      const taskDesc = data?.metadata?.taskDescription || data?.taskId || 'Task';
      const shortDesc = taskDesc.length > 50 ? taskDesc.substring(0, 50) + '...' : taskDesc;
      const success = data?.result?.success;

      // Generate unique toast ID
      const toastId = `feedback-${agentId}`;

      // Show custom toast with inline feedback buttons
      toast(
        (t) => (
          <div className="flex flex-col gap-2 max-w-xs">
            <div className="flex items-center gap-2">
              <span className={success ? 'text-green-500' : 'text-red-500'}>
                {success ? '✓' : '✗'}
              </span>
              <span className="font-medium text-white text-sm">Agent completed</span>
            </div>
            <p className="text-xs text-gray-400 truncate" title={taskDesc}>
              {shortDesc}
            </p>
            <div className="flex items-center gap-2 pt-1 border-t border-port-border/30">
              <span className="text-xs text-gray-500">Was this helpful?</span>
              <div className="flex gap-1 ml-auto">
                <button
                  onClick={() => submitFeedback(agentId, 'positive', t.id)}
                  className="p-1.5 rounded bg-green-500/20 hover:bg-green-500/30 text-green-400 transition-colors"
                  title="Helpful"
                  aria-label="Mark as helpful"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                  </svg>
                </button>
                <button
                  onClick={() => submitFeedback(agentId, 'negative', t.id)}
                  className="p-1.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
                  title="Not helpful"
                  aria-label="Mark as not helpful"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
                  </svg>
                </button>
                <button
                  onClick={() => toast.dismiss(t.id)}
                  className="p-1.5 rounded text-gray-500 hover:text-gray-300 transition-colors"
                  title="Dismiss"
                  aria-label="Dismiss notification"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ),
        {
          id: toastId,
          duration: 15000, // 15 seconds - enough time to react but not annoying
          style: {
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            padding: '12px 16px',
            borderRadius: '8px'
          }
        }
      );
    };

    // Register handler
    socket.on('cos:agent:completed', handleAgentCompleted);

    return () => {
      socket.off('cos:agent:completed', handleAgentCompleted);
      // Don't unsubscribe from cos since other components may use it
    };
  }, [submitFeedback]);

  // Clean up old entries periodically (keep last 50)
  useEffect(() => {
    const cleanup = setInterval(() => {
      const entries = Array.from(shownFeedbackFor.current);
      if (entries.length > 50) {
        shownFeedbackFor.current = new Set(entries.slice(-50));
      }
    }, 60000); // Every minute

    return () => clearInterval(cleanup);
  }, []);
}
