/**
 * SyncDetailDrawer — deep-linkable right-side panel showing per-peer sync
 * status for a single record, plus action buttons.
 *
 * Reusable across kinds: 'mediaCollection', 'universe', 'series'.
 *
 * Props:
 *   kind       — record kind ('mediaCollection' | 'universe' | 'series')
 *   recordId   — the record's id (from URL param)
 *   onClose    — called to navigate back (e.g. useNavigate() back to list)
 *
 * Deep-linkability: mounted under kind-specific routes via SyncView.
 * Fetches all its own data so it loads standalone from a direct URL.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { X, RefreshCw, ArrowUpCircle, Download, CheckCircle2, AlertTriangle, WifiOff, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { useSyncIntegrity } from '../../hooks/useSyncIntegrity';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { getMediaCollection, getUniverse, getPipelineSeries, syncRecordToPeer, pullMissingMetadata } from '../../services/api';
import MediaImage from '../MediaImage';

// ── Per-kind record fetcher ──────────────────────────────────────────────────
// Returns a promise resolving to { name, ...rest } for use in the drawer header.
// Only mediaCollection additionally exposes an `items` array for the thumbnail grid.
const KIND_FETCHER = {
  mediaCollection: getMediaCollection,
  universe: getUniverse,
  series: getPipelineSeries,
};

// ── Per-status display config ────────────────────────────────────────────────
const STATUS_CONFIG = {
  'in-parity': {
    label: 'In parity',
    className: 'text-port-success',
    Icon: CheckCircle2,
  },
  diverged: {
    label: 'Diverged',
    className: 'text-port-warning',
    Icon: AlertTriangle,
  },
  'assets-missing': {
    label: 'Assets missing',
    className: 'text-port-warning',
    Icon: AlertTriangle,
  },
  'local-only': {
    label: 'Local only',
    className: 'text-port-warning',
    Icon: AlertTriangle,
  },
  'peer-only': {
    label: 'On peer only',
    className: 'text-port-warning',
    Icon: AlertTriangle,
  },
};

function StatusPill({ status }) {
  const config = STATUS_CONFIG[status];
  if (!config) return <span className="text-gray-400 text-xs">{status ?? '—'}</span>;
  const { label, className, Icon } = config;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${className}`}>
      <Icon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}

// ── Collection preview (mediaCollection kind) ────────────────────────────────
// Presentational only — the collection state is owned by the drawer (fetched
// once there) and passed down, so the "Pull missing metadata" action can read
// the same already-loaded record without a second fetch.
function CollectionPreview({ collection, loading }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 text-sm py-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </div>
    );
  }
  if (!collection) {
    return <p className="text-gray-500 text-sm">Collection not found.</p>;
  }

  const items = collection.items ?? [];
  const imageItems = items.filter((it) => it.kind === 'image').slice(0, 8);

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-white font-medium text-sm">{collection.name}</h3>
        <p className="text-gray-500 text-xs">{items.length} item{items.length !== 1 ? 's' : ''}</p>
      </div>
      {imageItems.length > 0 && (
        <div className="grid grid-cols-4 gap-1">
          {imageItems.map((it) => (
            <MediaImage
              key={`${it.kind}:${it.ref}`}
              src={`/data/images/${it.ref}`}
              alt={it.ref}
              className="w-full aspect-square object-cover rounded"
            />
          ))}
        </div>
      )}
      {imageItems.length === 0 && (
        <p className="text-gray-600 text-xs">No image thumbnails available.</p>
      )}
    </div>
  );
}

// Friendly labels for the `{ pushed:false, reason }` shapes the server's
// forcePushRecord → pushRecordToPeer can return with HTTP 200 (the push was
// accepted as a request but no bytes actually went out). Unmapped reasons
// (e.g. `http-409`) fall back to the raw string.
const PUSH_SKIP_LABELS = {
  'category-disabled': 'this category is not enabled for that peer',
  'peer-disallows-outbound': 'that peer does not accept outbound sync',
  'peer-not-found': 'peer not found',
  'record-not-found': 'record missing locally',
  'peer-schema-behind': 'peer is on an older PortOS version',
  'peer-schema-behind-cooldown': 'peer is on an older PortOS version',
  'invalid-subscription': 'subscription is invalid',
  unchanged: 'already up to date',
  network: 'network error reaching the peer',
};

// ── Peer row with per-peer sync action ───────────────────────────────────────
function PeerRow({ entry, kind, recordId, onRefresh }) {
  const { peerId, peerName, status } = entry;
  const needsAction = status !== 'in-parity';

  const [syncToPeer, syncing] = useAsyncAction(async () => {
    // The endpoint returns 200 even when nothing was pushed ({ pushed:false,
    // reason }) — toasting success unconditionally would mislead the user.
    const result = await syncRecordToPeer(peerId, kind, recordId, { silent: true });
    if (result?.pushed) {
      toast.success(`Synced to ${peerName}`);
    } else {
      const reason = result?.reason;
      const detail = reason ? ` — ${PUSH_SKIP_LABELS[reason] ?? reason}` : '';
      toast.error(`Nothing synced to ${peerName}${detail}`);
    }
    onRefresh();
  }, { errorMessage: `Failed to sync to ${peerName}` });

  return (
    <div className="flex items-center justify-between gap-2 py-2 border-b border-port-border/60 last:border-0">
      <div className="min-w-0">
        <p className="text-sm text-white truncate">{peerName}</p>
        <StatusPill status={status} />
      </div>
      {needsAction && (
        <button
          type="button"
          onClick={() => syncToPeer()}
          disabled={syncing}
          className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent/20 hover:bg-port-accent/40 text-port-accent disabled:opacity-40"
        >
          {syncing
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <ArrowUpCircle className="w-3 h-3" />}
          Sync to peer
        </button>
      )}
    </div>
  );
}

// ── Main drawer ──────────────────────────────────────────────────────────────
export default function SyncDetailDrawer({ kind, recordId, onClose }) {
  const { byPeer, noSyncingPeers, integrityUnavailable, loading, error, refresh } = useSyncIntegrity(kind);
  const peerEntries = byPeer.get(recordId) ?? [];

  // Record state is owned here (fetched once) so the preview and the
  // "Pull missing metadata" action share the same record — no second fetch
  // and no double-toast (kind fetchers have no {silent} support).
  // For non-mediaCollection kinds we still fetch to show the record name in
  // the header, but skip the thumbnail grid and pull-metadata button.
  const fetcher = KIND_FETCHER[kind] ?? null;
  const [record, setRecord] = useState(null);
  const [recordLoading, setRecordLoading] = useState(!!fetcher);

  // Drop async results that resolve after the drawer unmounts (fast route
  // change / close while a fetch is in flight) to avoid setState-on-unmounted
  // warnings. Never reset to true — handles dev-mode double-mount cleanly.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // Generation counter so only the LATEST in-flight fetch commits state — a
  // rapid recordId change (or switch to empty) bumps this, and an older fetch
  // that resolves afterward fails the equality check and is dropped, instead
  // of overwriting the newer record with a stale name/preview.
  const loadGenRef = useRef(0);

  const loadRecord = useCallback(() => {
    if (!fetcher) return;
    const gen = ++loadGenRef.current; // invalidates any prior in-flight fetch
    const fresh = () => mountedRef.current && gen === loadGenRef.current;
    // An empty recordId (e.g. a param-less route mount) would fetch
    // `/media/collections/` and 404/toast — skip the request, and clear any
    // previously-loaded record so a stale name/preview can't linger.
    if (!recordId) { setRecord(null); setRecordLoading(false); return; }
    setRecordLoading(true);
    fetcher(recordId)
      .then((data) => { if (fresh()) setRecord(data); })
      .catch(() => { if (fresh()) setRecord(null); })
      .finally(() => { if (fresh()) setRecordLoading(false); });
  }, [fetcher, recordId]);

  useEffect(() => { loadRecord(); }, [loadRecord]);

  // Keep the mediaCollection-specific alias in scope so the pull action below
  // can read it without changing its reference to `collection`.
  const collection = kind === 'mediaCollection' ? record : null;
  const collectionLoading = kind === 'mediaCollection' ? recordLoading : false;

  // Convenience alias so the header can show `record?.name` regardless of kind.
  const recordName = record?.name ?? null;

  // Read the image filenames from the already-loaded collection state.
  // Only runs for mediaCollection — the button is gated to that kind below.
  const [pullMissing, pulling] = useAsyncAction(async () => {
    if (!collection) { toast.error('Collection not loaded yet'); return; }
    const filenames = (collection.items ?? [])
      .filter((it) => it.kind === 'image')
      .map((it) => it.ref);
    if (filenames.length === 0) { toast('No image files to pull'); return; }
    const result = await pullMissingMetadata(filenames, { silent: true });
    const recovered = result?.recovered ?? 0;
    const attempted = result?.attempted ?? filenames.length;
    // Mirror MediaCollectionDetail's Unsorted "Pull missing prompts": only
    // claim success when something was actually recovered — recovered=0 (or
    // attempted=0) is a neutral "nothing to do", not a win.
    if (recovered > 0) {
      toast.success(`Pulled ${recovered}/${attempted} metadata item${attempted === 1 ? '' : 's'}`);
    } else {
      toast(`No missing metadata found (${attempted} checked)`);
    }
    refresh();
    loadRecord(); // refresh the preview thumbnails post-pull
  }, { errorMessage: 'Failed to pull missing metadata' });

  // Esc key support
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Lock the body scroll while the drawer is open (matches Drawer.jsx).
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Sync details"
        className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-port-card border-l border-port-border shadow-2xl flex flex-col"
      >
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-port-border">
          <div className="min-w-0">
            <h2 className="text-base font-medium text-white">Sync Details</h2>
            {recordName && (
              <p className="text-xs text-gray-400 truncate">{recordName}</p>
            )}
            {!recordName && recordLoading && (
              <p className="text-xs text-gray-500">Loading…</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-port-border/50 min-h-[40px] min-w-[40px] flex items-center justify-center"
            aria-label="Close sync details"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Collection preview */}
          {kind === 'mediaCollection' && (
            <section>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Collection</h3>
              <CollectionPreview collection={collection} loading={collectionLoading} />
            </section>
          )}

          {/* Per-peer breakdown */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Peer Status</h3>
              <button
                type="button"
                onClick={refresh}
                title="Refresh sync status"
                className="p-1 text-gray-500 hover:text-gray-300 rounded"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {loading && (
              <div className="flex items-center gap-2 text-gray-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Checking peers…
              </div>
            )}

            {!loading && error && (
              <p className="text-port-error text-sm">Failed to load sync status.</p>
            )}

            {/* noSyncingPeers is also true when peers EXIST but this category's
                toggle is off — so the copy must not imply "no peers at all"
                (mirrors the SyncBadge 'not-syncing' tooltip). */}
            {!loading && !error && noSyncingPeers && (
              <div className="flex items-center gap-2 text-gray-500 text-sm">
                <WifiOff className="w-4 h-4" />
                No peers are syncing this category — enable it for a peer to sync this record.
              </div>
            )}

            {/* Eligible peers exist but none returned integrity data (all
                offline / unreachable / on an older PortOS). Distinct from the
                "record not present anywhere" case below — otherwise this would
                read as a misleading "No peer data for this record." */}
            {!loading && !error && !noSyncingPeers && integrityUnavailable && (
              <div className="flex items-center gap-2 text-gray-500 text-sm">
                <WifiOff className="w-4 h-4" />
                Sync status unavailable — every peer was offline, unreachable, or on an older PortOS.
              </div>
            )}

            {!loading && !error && !noSyncingPeers && !integrityUnavailable && peerEntries.length === 0 && (
              <p className="text-gray-500 text-sm">No peer data for this record.</p>
            )}

            {!loading && !error && peerEntries.length > 0 && (
              <div>
                {peerEntries.map((entry) => (
                  <PeerRow
                    key={entry.peerId}
                    entry={entry}
                    kind={kind}
                    recordId={recordId}
                    onRefresh={refresh}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Actions — only mediaCollection has pull-metadata right now */}
          {kind === 'mediaCollection' && (
            <section>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Actions</h3>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => pullMissing()}
                  disabled={pulling}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm bg-port-accent/20 hover:bg-port-accent/40 text-port-accent disabled:opacity-40"
                >
                  {pulling
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Download className="w-4 h-4" />}
                  Pull missing metadata
                </button>
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
