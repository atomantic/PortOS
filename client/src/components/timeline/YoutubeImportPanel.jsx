import { MonitorPlay } from 'lucide-react';
import * as api from '../../services/api';
import ActivityImportPanel, { dateRangeLabel } from './ActivityImportPanel';

// Bulk-backfill importer for Google Takeout YouTube watch history (#2153), built
// on the shared ActivityImportPanel seam. This is the reliable historical path
// (and a fallback whenever the live scrape breaks).
export default function YoutubeImportPanel({ onImported }) {
  return (
    <ActivityImportPanel
      icon={MonitorPlay}
      title="Import YouTube watch history"
      noun="watch"
      importFn={api.importYoutubeHistory}
      onImported={onImported}
      help={(
        <>
          Request your <span className="text-gray-300">YouTube and YouTube Music → history</span> from
          <a href="https://takeout.google.com" target="_blank" rel="noreferrer" className="text-port-accent hover:underline"> Google Takeout</a>,
          then upload the ZIP (or a single <span className="font-mono">watch-history.json</span>) here. Re-imports are
          safe — already-recorded watches are skipped.
        </>
      )}
      renderPreview={(summary) => (
        <>
          <div>{summary.watches} watch(es) across {summary.uniqueVideos} unique video(s)</div>
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
