import { Globe } from 'lucide-react';
import * as api from '../../services/api';
import ActivityImportPanel, { dateRangeLabel } from './ActivityImportPanel';

// Bulk-backfill importer for Google Takeout Chrome browser history (#2160) →
// web.visit events, built on the shared ActivityImportPanel seam.
export default function BrowserHistoryImportPanel({ onImported }) {
  return (
    <ActivityImportPanel
      icon={Globe}
      title="Import browser history"
      noun="visit"
      importFn={api.importBrowserHistory}
      onImported={onImported}
      help={(
        <>
          Request <span className="text-gray-300">Chrome</span> from Google Takeout
          (takeout.google.com), then upload the ZIP (or a single
          <span className="font-mono"> History.json</span>) here. Each page visit is
          imported; ad/embed iframe loads are skipped. Re-imports are safe.
        </>
      )}
      renderPreview={(summary) => (
        <>
          <div>{summary.visits} visit(s) across {summary.uniqueHosts} unique site(s)</div>
          {dateRangeLabel(summary.from, summary.to) && (
            <div>Range: {dateRangeLabel(summary.from, summary.to)}</div>
          )}
          {summary.topHosts?.length > 0 && (
            <div className="mt-1 truncate">
              Top: {summary.topHosts.slice(0, 5).map((h) => h.name).join(', ')}
            </div>
          )}
        </>
      )}
    />
  );
}
