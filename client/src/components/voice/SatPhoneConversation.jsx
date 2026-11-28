import { ChevronDown, ChevronUp, Send, Trash2 } from 'lucide-react';

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

      {/* Integrated message composer */}
      <form
        onSubmit={(event) => { event.preventDefault(); onSend(); }}
        className="flex min-w-0 items-center gap-1.5"
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="Transmit text…"
          aria-label="Message to the voice assistant"
          className="min-w-0 flex-1 rounded-lg border border-port-border bg-port-bg px-2.5 py-2 font-mono text-xs text-port-text placeholder:text-port-text-muted focus:border-port-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          title="Send text (Enter)"
          aria-label="Send text"
          className="satphone-key inline-flex min-h-9 min-w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 items-center justify-center rounded-lg border px-2.5 text-port-accent-text disabled:opacity-35"
        >
          <Send size={13} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
