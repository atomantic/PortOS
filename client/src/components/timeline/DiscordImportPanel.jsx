import { MessageSquare } from 'lucide-react';
import * as api from '../../services/api';
import ActivityImportPanel, { dateRangeLabel } from './ActivityImportPanel';

// Bulk-backfill importer for the Discord "data package" export (#2160) → the
// messages you sent across every channel/DM as message.sent events, built on the
// shared ActivityImportPanel seam.
export default function DiscordImportPanel({ onImported }) {
  return (
    <ActivityImportPanel
      icon={MessageSquare}
      title="Import Discord history"
      noun="message"
      importFn={api.importDiscordHistory}
      onImported={onImported}
      help={(
        <>
          Request your <span className="text-gray-300">data package</span> from Discord
          (Settings → Data &amp; Privacy → Request all of my Data), then upload the ZIP (or a
          single <span className="font-mono">messages.json</span>/<span className="font-mono">.csv</span>)
          here. Only the messages you sent are imported. Re-imports are safe.
        </>
      )}
      renderPreview={(summary) => (
        <>
          <div>{summary.messages} message(s) across {summary.uniqueChannels} channel(s)</div>
          {dateRangeLabel(summary.from, summary.to) && (
            <div>Range: {dateRangeLabel(summary.from, summary.to)}</div>
          )}
          {summary.topChannels?.length > 0 && (
            <div className="mt-1 truncate">
              Top: {summary.topChannels.slice(0, 5).map((c) => c.name).join(', ')}
            </div>
          )}
        </>
      )}
    />
  );
}
