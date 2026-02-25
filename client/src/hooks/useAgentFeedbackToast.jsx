import { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { ThumbsUp, ThumbsDown, Loader2 } from 'lucide-react';
import socket from '../services/socket';
import * as api from '../services/api';
import OutputBlocks from '../components/cos/OutputBlocks';

const AUTO_DISMISS_MS = 15000;

/**
 * Toast content component with expandable output and smart auto-dismiss.
 * When collapsed: auto-dismisses after 15s, shows dismiss button.
 * When expanded: no auto-dismiss, no dismiss — must give feedback or collapse first.
 */
function AgentFeedbackToast({ t, agentData, onFeedback }) {
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState(agentData?.output || []);
  const [loadingOutput, setLoadingOutput] = useState(false);
  const dismissTimer = useRef(null);

  const agentId = agentData?.id || agentData?.agentId;
  const taskDesc = agentData?.metadata?.taskDescription || agentData?.taskId || 'Task';
  const shortDesc = taskDesc.length > 50 ? taskDesc.substring(0, 50) + '...' : taskDesc;
  const success = agentData?.result?.success;

  // Auto-dismiss timer: active when collapsed, cleared when expanded
  useEffect(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    if (!expanded) {
      dismissTimer.current = setTimeout(() => toast.dismiss(t.id), AUTO_DISMISS_MS);
    }
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, [expanded, t.id]);

  // Fetch output on expand if not already loaded
  useEffect(() => {
    if (expanded && output.length === 0 && !loadingOutput && agentId) {
      setLoadingOutput(true);
      api.getCosAgent(agentId)
        .then(data => setOutput(data?.output || []))
        .catch(() => {})
        .finally(() => setLoadingOutput(false));
    }
  }, [expanded, output.length, loadingOutput, agentId]);

  return (
    <div className={`flex flex-col gap-2 transition-all ${expanded ? 'w-[480px]' : 'max-w-xs'}`}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className={success ? 'text-green-500' : 'text-red-500'}>
          {success ? '✓' : '✗'}
        </span>
        <span className="font-medium text-white text-sm flex-1">Agent completed</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-gray-500 hover:text-white transition-colors"
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>

      {/* Task description */}
      <p className={`text-xs text-gray-400 ${expanded ? '' : 'truncate'}`} title={taskDesc}>
        {expanded ? taskDesc : shortDesc}
      </p>

      {/* Expanded output */}
      {expanded && (
        <div className="border-t border-port-border/30 pt-2 max-h-[400px] overflow-y-auto">
          {loadingOutput ? (
            <div className="flex items-center gap-2 text-gray-500 text-xs">
              <Loader2 size={12} className="animate-spin" />
              Loading output...
            </div>
          ) : output.length > 0 ? (
            <OutputBlocks output={output} />
          ) : (
            <div className="text-xs text-gray-500">No output captured</div>
          )}
        </div>
      )}

      {/* Feedback buttons */}
      <div className="flex items-center gap-2 pt-1 border-t border-port-border/30">
        <span className="text-xs text-gray-500">Was this helpful?</span>
        <div className="flex gap-1 ml-auto">
          <button
            onClick={() => onFeedback(agentId, 'positive', t.id)}
            className="p-1.5 rounded bg-green-500/20 hover:bg-green-500/30 text-green-400 transition-colors"
            title="Helpful"
            aria-label="Mark as helpful"
          >
            <ThumbsUp size={16} />
          </button>
          <button
            onClick={() => onFeedback(agentId, 'negative', t.id)}
            className="p-1.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
            title="Not helpful"
            aria-label="Mark as not helpful"
          >
            <ThumbsDown size={16} />
          </button>
          {!expanded && (
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
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Hook that shows proactive feedback toast when agents complete tasks.
 * Prompts users for quick feedback directly in the toast notification,
 * with expandable output view reusing shared OutputBlocks component.
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

      // Generate unique toast ID
      const toastId = `feedback-${agentId}`;

      // Show custom toast with inline feedback and expandable output
      toast(
        (t) => (
          <AgentFeedbackToast
            t={t}
            agentData={data}
            onFeedback={submitFeedback}
          />
        ),
        {
          id: toastId,
          duration: Infinity, // Component manages its own auto-dismiss
          style: {
            background: 'rgb(var(--port-card))',
            border: '1px solid rgb(var(--port-border))',
            padding: '12px 16px',
            borderRadius: '8px',
            maxWidth: '520px'
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
