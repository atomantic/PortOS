import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import SatPhoneComposer from './SatPhoneComposer';

export default function SatPhoneConversation({
  history,
  scrollRef,
  interimTranscript,
  draft,
  onDraft,
  onSend,
  onClear,
  collapsed,
  onToggleCollapsed,
  conversationId,
  inputRef,
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="satphone-log-well rounded-xl border p-2.5">
        <div className="flex items-center justify-between gap-1.5 pb-1.5 border-b border-port-border/60">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] opacity-80">
            Transmission log
          </span>
          <div className="flex items-center gap-1">
            {history.length > 0 && onClear && (
              <button
                type="button"
                onClick={onClear}
                title="Clear conversation"
                aria-label="Clear conversation"
                className="inline-flex items-center justify-center rounded p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 opacity-75 hover:opacity-100 hover:text-port-error-text"
              >
                <Trash2 size={11} aria-hidden="true" />
              </button>
            )}
            {history.length > 0 && onToggleCollapsed && (
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-expanded={!collapsed}
                aria-controls={conversationId}
                title={collapsed ? 'Show conversation' : 'Hide conversation'}
                aria-label={collapsed ? 'Show conversation' : 'Hide conversation'}
                className="inline-flex items-center justify-center rounded p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 opacity-75 hover:opacity-100"
              >
                {collapsed ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
              </button>
            )}
          </div>
        </div>

        {!collapsed && (
          <div
            id={conversationId}
            ref={scrollRef}
            className="mt-1.5 max-h-28 overflow-y-auto pr-1"
          >
            <div
              role="log"
              aria-live="polite"
              aria-label="Conversation"
              className="space-y-1.5 break-words font-mono text-[11px] leading-relaxed"
            >
              {history.length === 0 && !interimTranscript && (
                <p className="opacity-60">Standby — press TALK or type below.</p>
              )}
              {history.map((turn, i) => (
                <p key={i} className={turn.role === 'user' ? 'opacity-75' : ''}>
                  <span className="mr-1.5 text-[9px] font-bold uppercase tracking-wider text-port-accent">
                    {turn.role === 'user' ? 'TX>' : 'RX<'}
                  </span>
                  {turn.text}
                </p>
              ))}
            </div>
            {interimTranscript && (
              <p aria-hidden="true" className="mt-1 font-mono text-[11px] italic opacity-65">
                <span className="mr-1.5 text-[9px] font-bold uppercase tracking-wider text-port-accent-2">TX…</span>
                {interimTranscript}
              </p>
            )}
          </div>
        )}
      </div>

      <SatPhoneComposer draft={draft} onDraft={onDraft} onSend={onSend} inputRef={inputRef} />
    </div>
  );
}
