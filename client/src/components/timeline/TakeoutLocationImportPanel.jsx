import { MapPin } from 'lucide-react';
import * as api from '../../services/api';
import ActivityImportPanel, { dateRangeLabel } from './ActivityImportPanel';

// Bulk-backfill importer for Google Takeout "Location History (Timeline)"
// exports (#2160) → place.visit events, built on the shared ActivityImportPanel
// seam.
export default function TakeoutLocationImportPanel({ onImported }) {
  return (
    <ActivityImportPanel
      icon={MapPin}
      title="Import Google location history"
      noun="visit"
      importFn={api.importTakeoutLocationHistory}
      onImported={onImported}
      help={(
        <>
          Request <span className="text-gray-300">Location History (Timeline)</span> from
          Google Takeout (takeout.google.com), then upload the ZIP (or a single
          <span className="font-mono"> Semantic Location History</span> JSON) here. Only place
          visits are imported — travel segments are skipped. Re-imports are safe.
        </>
      )}
      renderPreview={(summary) => (
        <>
          <div>{summary.visits} visit(s) across {summary.uniquePlaces} unique place(s)</div>
          {dateRangeLabel(summary.from, summary.to) && (
            <div>Range: {dateRangeLabel(summary.from, summary.to)}</div>
          )}
          {summary.topPlaces?.length > 0 && (
            <div className="mt-1 truncate">
              Top: {summary.topPlaces.slice(0, 5).map((p) => p.name).join(', ')}
            </div>
          )}
        </>
      )}
    />
  );
}
