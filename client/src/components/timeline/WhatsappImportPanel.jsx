import { MessagesSquare } from 'lucide-react';
import * as api from '../../services/api';
import ActivityImportPanel, { dateRangeLabel } from './ActivityImportPanel';

// Bulk-backfill importer for a WhatsApp "Export chat" transcript (#2160) → every
// message becomes a neutral timeline event, built on the shared
// ActivityImportPanel seam. WhatsApp exports don't mark which sender is "you", so
// direction (sent vs received) is left neutral for now — the sender is kept per
// event for a later reclassification pass.
export default function WhatsappImportPanel({ onImported }) {
  return (
    <ActivityImportPanel
      icon={MessagesSquare}
      title="Import WhatsApp chat"
      noun="message"
      importFn={api.importWhatsappHistory}
      onImported={onImported}
      accept=".txt,.zip,text/plain,application/zip"
      help={(
        <>
          In WhatsApp, open a chat → <span className="text-gray-300">⋯ More → Export chat</span> (without
          media is smaller), then upload the <span className="font-mono">.txt</span> (or the
          exported <span className="font-mono">.zip</span>) here. Both sides of the conversation are
          imported. Re-imports are safe.
        </>
      )}
      renderPreview={(summary) => (
        <>
          <div>{summary.messages} message(s) from {summary.uniqueSenders} sender(s)</div>
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
