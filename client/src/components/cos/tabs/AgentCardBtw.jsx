import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Loader2, MessageSquare, Send } from 'lucide-react';
import { sendCosAgentBtw } from '../../../services/apiAgents.js';
import { formatTimeOfDay } from '../../../utils/formatters';
import toast from '../../ui/Toast';

const FINISH_SENTINEL_MESSAGE = 'Finish work and write sentinel.';

export default function AgentCardBtw({ agent, inactive, remote }) {
  const [btwInput, setBtwInput] = useState('');
  const [sendingBtw, setSendingBtw] = useState(false);
  const [btwMessages, setBtwMessages] = useState(agent.btwMessages || []);

  // Sync btw messages from parent when agent data refreshes
  useEffect(() => {
    setBtwMessages(agent.btwMessages || []);
  }, [agent.btwMessages]);

  // Send a message to the running agent
  const sendBtw = useCallback(async (message = btwInput.trim(), label = 'BTW message') => {
    if (sendingBtw || !message) return;
    setSendingBtw(true);

    const result = await sendCosAgentBtw(agent.id, message, { silent: true }).catch(err => {
      toast.error(`Failed to send: ${err.message}`);
      return null;
    });

    setSendingBtw(false);

    if (result?.success) {
      setBtwMessages(prev => [...prev, { message, timestamp: new Date().toISOString() }]);
      if (message === btwInput.trim()) setBtwInput('');
      toast.success(`${label} sent to agent`);
    }
  }, [agent.id, btwInput, sendingBtw]);

  return (
    <>
      {/* BTW messages sent to this agent */}
      {btwMessages.length > 0 && (
        <div className="mt-2 space-y-1">
          {btwMessages.map((btw, i) => (
            <div key={i} className="flex items-start gap-2 text-xs bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-1.5">
              <MessageSquare size={12} className="text-yellow-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0">
                <span className="text-yellow-400">BTW:</span>{' '}
                <span className="text-gray-300">{btw.message}</span>
                <span className="text-gray-600 ml-2">{formatTimeOfDay(btw.timestamp)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!inactive && !remote && agent.metadata?.executionMode === 'tui' && agent.metadata?.tuiKind === 'claude' && (
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={btwInput}
            onChange={(e) => setBtwInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendBtw()}
            placeholder="Send additional context to agent..."
            aria-label="Additional context for the agent"
            className="flex-1 px-2 py-1 text-sm bg-port-bg border border-port-border rounded text-white placeholder-gray-600 focus:outline-hidden focus:border-yellow-500/50 min-h-[32px]"
            maxLength={5000}
            disabled={sendingBtw}
          />
          <button
            onClick={() => sendBtw()}
            disabled={sendingBtw || !btwInput.trim()}
            className="flex items-center gap-1.5 px-3 py-1 text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 rounded transition-colors disabled:opacity-50 min-h-[32px]"
            title="Send BTW message to agent (pastes into the live Claude Code TUI session)"
            data-voice-guard="confirm"
          >
            {sendingBtw ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
            BTW
          </button>
          <button
            onClick={() => sendBtw(FINISH_SENTINEL_MESSAGE, 'Finish message')}
            disabled={sendingBtw}
            className="flex items-center gap-1.5 px-3 py-1 text-xs bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded transition-colors disabled:opacity-50 min-h-[32px]"
            title="Tell the agent to finish work and write the sentinel"
            aria-label="Finish work and write sentinel"
          >
            {sendingBtw ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <CheckCircle size={12} aria-hidden="true" />}
            Finish
          </button>
        </div>
      )}
    </>
  );
}
