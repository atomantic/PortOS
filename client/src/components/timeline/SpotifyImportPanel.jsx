import { Music } from 'lucide-react';
import * as api from '../../services/api';
import { formatDurationSec } from '../../utils/formatters';
import ActivityImportPanel, { dateRangeLabel } from './ActivityImportPanel';

// Bulk-backfill importer for Spotify "Extended streaming history" exports (#2160),
// built on the shared ActivityImportPanel seam.
export default function SpotifyImportPanel({ onImported }) {
  return (
    <ActivityImportPanel
      icon={Music}
      title="Import Spotify history"
      noun="play"
      importFn={api.importSpotifyHistory}
      onImported={onImported}
      help={(
        <>
          Request your <span className="text-gray-300">Extended streaming history</span> from
          Spotify (Account → Privacy), then upload the ZIP (or a single
          <span className="font-mono"> Streaming_History_Audio_*.json</span>) here. Re-imports are safe —
          already-recorded plays are skipped.
        </>
      )}
      renderPreview={(summary) => (
        <>
          <div>{summary.plays} play(s) across {summary.uniqueTracks} unique track(s)</div>
          {dateRangeLabel(summary.from, summary.to) && (
            <div>Range: {dateRangeLabel(summary.from, summary.to)}</div>
          )}
          {summary.totalMs > 0 && (
            <div>Total listening: {formatDurationSec(Math.round(summary.totalMs / 1000))}</div>
          )}
          {summary.topArtists?.length > 0 && (
            <div className="mt-1 truncate">
              Top: {summary.topArtists.slice(0, 5).map((a) => a.name).join(', ')}
            </div>
          )}
        </>
      )}
    />
  );
}
