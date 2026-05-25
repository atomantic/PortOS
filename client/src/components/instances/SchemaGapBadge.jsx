import { AlertTriangle, ArrowUpCircle, ArrowDownCircle } from 'lucide-react';

/**
 * Surfaces a peer's storage-layout schema version gaps so the user knows
 * which direction the mismatch goes and what action is needed.
 *
 * The server populates two distinct gap surfaces:
 *
 *   - `peer.schemaGaps`: per-(peer, snapshot-category) gaps detected by the
 *     60s `syncDataCategoryFromPeer` apply pass. Shape:
 *       { [category]: { ahead, behind, senderPortosVersion, detectedAt } }
 *     Set when the receiver (us) rejected a remote snapshot because the
 *     sender's schemaVersions were ahead of ours.
 *
 *   - `peerSubs[].blockedBySchema`: per-(record-subscription) gaps detected
 *     by the per-record push pipeline. Shape:
 *       { ahead, behind, peerPortosVersion, peerSchemaVersions, detectedAt }
 *     Set when WE pushed to the peer and got a 409 back because the peer's
 *     code is BEHIND ours.
 *
 * Both are rendered as a compact warning block at the top of the peer card.
 * Empty / absent gaps render nothing — peers without a mismatch keep their
 * existing card layout.
 */
export function SchemaGapBadge({ peer, peerSubs = [] }) {
  const snapshotGaps = peer?.schemaGaps && typeof peer.schemaGaps === 'object'
    ? Object.entries(peer.schemaGaps).map(([category, gap]) => ({ category, ...gap, direction: 'receiver-behind' }))
    : [];
  // Map per-record subscription recordKind to the SAME category vocabulary
  // that snapshotGaps uses (dataSync's CHECKSUM_PATHS keys: 'universe'
  // singular, 'pipeline' for series+issues, 'mediaCollections', etc.). The
  // earlier version mapped 'universe' → 'universes' (plural), which made
  // the de-dup key below treat the snapshot and push directions as
  // disjoint label spaces — the same underlying gap then rendered as two
  // rows with inconsistent labels. Keep both directions on the same
  // vocabulary so dedup + label rendering line up.
  const recordKindToCategory = (k) => {
    if (k === 'universe') return 'universe';
    if (k === 'series') return 'pipeline';
    return k;
  };
  const pushGaps = (peerSubs || [])
    .filter((s) => s?.blockedBySchema)
    .map((s) => ({
      category: recordKindToCategory(s.recordKind),
      ahead: s.blockedBySchema.ahead || [],
      behind: s.blockedBySchema.behind || [],
      peerPortosVersion: s.blockedBySchema.peerPortosVersion,
      detectedAt: s.blockedBySchema.detectedAt,
      direction: 'peer-behind',
    }));

  if (snapshotGaps.length === 0 && pushGaps.length === 0) return null;

  // De-dup by `category + direction` — if both transports flag the same
  // (peer, category, direction), show one row.
  const seen = new Set();
  const rows = [...snapshotGaps, ...pushGaps].filter((row) => {
    const key = `${row.direction}:${row.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <div className="mt-2 rounded-lg border border-port-warning/40 bg-port-warning/5 px-3 py-2">
      <div className="flex items-center gap-1.5 text-port-warning text-xs font-medium mb-1">
        <AlertTriangle size={12} />
        <span>Schema version mismatch</span>
      </div>
      <ul className="space-y-1 text-xs text-gray-300">
        {rows.map((row, i) => (
          <li key={`${row.direction}-${row.category}-${i}`} className="flex items-start gap-1.5">
            {row.direction === 'peer-behind' ? (
              <ArrowDownCircle size={12} className="mt-0.5 text-port-warning shrink-0" aria-label="Peer is behind" />
            ) : (
              <ArrowUpCircle size={12} className="mt-0.5 text-port-warning shrink-0" aria-label="Peer is ahead" />
            )}
            <span>
              {row.direction === 'peer-behind' ? (
                <>
                  <span className="text-white">{peer?.name || 'Peer'}</span> is on an older PortOS
                  {row.peerPortosVersion ? <> (<span className="font-mono">{row.peerPortosVersion}</span>)</> : null}
                  {' '}— they need to update before we can sync <span className="font-mono">{row.category}</span>.
                </>
              ) : (
                <>
                  <span className="text-white">{peer?.name || 'Peer'}</span> is on a newer PortOS
                  {row.senderPortosVersion ? <> (<span className="font-mono">{row.senderPortosVersion}</span>)</> : null}
                  {' '}— update PortOS to receive their <span className="font-mono">{row.category}</span> updates.
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
