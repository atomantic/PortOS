import { Loader2, MessageSquare } from 'lucide-react';
import Modal from '../../ui/Modal';
import { formatCount } from '../../../utils/formatters';

export default function AgentPromptDrawer({ prompt }) {
  const { promptOpen, closePrompt, promptContent, loadingPrompt, promptError, copyPromptToClipboard } = prompt;
  return (
    <Modal
      open={promptOpen}
      onClose={closePrompt}
      size="2xl"
      usePortal
      panelClassName="bg-port-card border border-port-border rounded-lg flex flex-col"
      ariaLabel="Agent prompt"
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-port-border shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare size={14} className="text-gray-400" aria-hidden="true" />
          <span className="text-sm text-gray-300">Agent prompt</span>
          {promptContent && (
            <span className="text-xs text-gray-500 font-mono">
              {formatCount(promptContent.length)} chars · {formatCount(promptContent.split('\n').length)} lines
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {promptContent && (
            <button
              onClick={copyPromptToClipboard}
              className="text-xs px-2 py-1 rounded bg-port-border/40 text-gray-400 hover:text-white"
            >
              Copy
            </button>
          )}
          <button
            onClick={closePrompt}
            className="text-xs px-2 py-1 rounded bg-port-border/40 text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Close prompt viewer"
          >
            Close
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {loadingPrompt && (
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <Loader2 size={14} aria-hidden="true" className="animate-spin" />
            Loading prompt…
          </div>
        )}
        {promptError && (
          <div role="status" className="text-port-error text-sm">{promptError}</div>
        )}
        {!loadingPrompt && !promptError && promptContent != null && (
          <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words">{promptContent}</pre>
        )}
      </div>
    </Modal>
  );
}
