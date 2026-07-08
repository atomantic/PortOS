import { useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import * as api from '../../services/api';
import ActivityImportPanel, { dateRangeLabel } from './ActivityImportPanel';

// Bulk-backfill importer for a WhatsApp "Export chat" transcript (#2160), built on
// the shared ActivityImportPanel seam. WhatsApp exports don't mark which sender is
// "you", so an optional "your name" field classifies direction: a sender matching
// it becomes a sent message, everyone else received. Left blank, every message is
// a neutral event (the sender is always kept per event). An optional "chat label"
// scopes the dedupe key to a stable chat name so two different chats that share a
// same-named sender + identical message never collapse into one event; left blank,
// the legacy un-scoped key is used unchanged.
export default function WhatsappImportPanel({ onImported }) {
  const [yourName, setYourName] = useState('');
  const [chatLabel, setChatLabel] = useState('');
  const trimmedName = yourName.trim();
  const trimmedLabel = chatLabel.trim();
  const importOptions = (trimmedName || trimmedLabel)
    ? { ...(trimmedName ? { yourName: trimmedName } : {}), ...(trimmedLabel ? { chatLabel: trimmedLabel } : {}) }
    : undefined;

  return (
    <ActivityImportPanel
      icon={MessagesSquare}
      title="Import WhatsApp chat"
      noun="message"
      importFn={api.importWhatsappHistory}
      onImported={onImported}
      accept=".txt,.zip,text/plain,application/zip"
      importOptions={importOptions}
      help={(
        <>
          In WhatsApp, open a chat → <span className="text-gray-300">⋯ More → Export chat</span> (without
          media is smaller), then upload the <span className="font-mono">.txt</span> (or the
          exported <span className="font-mono">.zip</span>) here. Both sides of the conversation are
          imported. Re-imports are safe.
        </>
      )}
      controls={({ disabled }) => (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="whatsapp-your-name" className="text-xs text-gray-400">
              Your name in this chat <span className="text-gray-600">(optional — marks your messages as sent)</span>
            </label>
            <input
              id="whatsapp-your-name"
              type="text"
              value={yourName}
              onChange={(e) => setYourName(e.target.value)}
              disabled={disabled}
              placeholder="e.g. how your contacts saved you"
              className="w-full max-w-xs rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-gray-200 placeholder:text-gray-600 focus:border-port-accent focus:outline-none disabled:opacity-40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="whatsapp-chat-label" className="text-xs text-gray-400">
              Chat label <span className="text-gray-600">(optional — keeps distinct chats from merging; use the same label each time)</span>
            </label>
            <input
              id="whatsapp-chat-label"
              type="text"
              value={chatLabel}
              onChange={(e) => setChatLabel(e.target.value)}
              disabled={disabled}
              placeholder="e.g. Family group"
              className="w-full max-w-xs rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-gray-200 placeholder:text-gray-600 focus:border-port-accent focus:outline-none disabled:opacity-40"
            />
          </div>
        </div>
      )}
      renderPreview={(summary) => (
        <>
          <div>{summary.messages} message(s) from {summary.uniqueSenders} sender(s)</div>
          {summary.directionKnown && (
            <div>{summary.sent} sent, {summary.received} received</div>
          )}
          {summary.chatTitle && <div>Chat: {summary.chatTitle}</div>}
          {dateRangeLabel(summary.from, summary.to) && (
            <div>Range: {dateRangeLabel(summary.from, summary.to)}</div>
          )}
          {summary.topSenders?.length > 0 && (
            <div className="mt-1 truncate">
              Top: {summary.topSenders.slice(0, 5).map((s) => s.name).join(', ')}
            </div>
          )}
        </>
      )}
    />
  );
}
