import { RefreshCw, Database, Brain, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import { timeAgo } from '../../utils/formatters';
import { directionalCounts, describeDirectional } from '../../lib/syncCounts';
import { SNAPSHOT_CATEGORIES, SYNC_CATEGORY_META } from './syncCategoryMeta';

function SyncStatusBadge({ label, icon: Icon, localSeq, peerSeq, cursorSeq, peerCursorForUs, syncing }) {
  // cursorSeq        = how far we've pulled from them (our cursor for their data)
  // localSeq         = our local max seq for this data type
  // peerSeq          = their max seq for this data type (their sync-status endpoint)
  // peerCursorForUs  = how far THEY've pulled from us (their cursor into our data)
  //
  // Two directions, both in plain language (raw seqs live in the tooltip):
  //   toPull = peerSeq - cursorSeq         (their items we haven't pulled)
  //   toPush = localSeq - peerCursorForUs  (our items they haven't pulled)
  const { toPull, toPush } = directionalCounts({
    localMax: localSeq,
    peerMax: peerSeq,
    ourCursor: cursorSeq,
    peerCursorForUs,
  });
  const { state, text } = describeDirectional({ toPull, toPush });

  // Nothing known at all (no probe yet, no cursor) → render nothing.
  if (peerSeq == null && cursorSeq == null && peerCursorForUs == null && localSeq == null) return null;

  const StateIcon = syncing ? RefreshCw : state === 'synced' ? CheckCircle2 : state === 'behind' ? AlertCircle : Clock;
  const iconClass = syncing
    ? 'text-port-accent animate-spin'
    : state === 'synced' ? 'text-port-success' : state === 'behind' ? 'text-port-warning' : 'text-gray-500';
  const textClass = syncing
    ? 'text-port-accent'
    : state === 'synced' ? 'text-port-success' : state === 'behind' ? 'text-port-warning' : 'text-gray-400';

  // Raw sequences retained for debugging in the tooltip.
  const tooltip = `Pulled ${cursorSeq ?? 0} of their ${peerSeq ?? '?'} · `
    + `they pulled ${peerCursorForUs ?? '?'} of our ${localSeq ?? '?'}`;

  return (
    <div className="flex items-center gap-1.5 text-xs min-w-0">
      <Icon size={12} className="text-gray-500 shrink-0" />
      <span className="text-gray-500 shrink-0">{label}:</span>
      <span className="flex items-center gap-1 min-w-0" title={tooltip}>
        <StateIcon size={11} className={`${iconClass} shrink-0`} />
        <span className={`${textClass} truncate`}>{syncing ? 'syncing…' : text}</span>
      </span>
    </div>
  );
}

function SnapshotSyncBadge({ label, icon: Icon, cursorChecksum, remoteChecksum, syncing = false }) {
  const synced = cursorChecksum && remoteChecksum && cursorChecksum === remoteChecksum;
  const behind = cursorChecksum && remoteChecksum && cursorChecksum !== remoteChecksum;

  return (
    <div className="flex items-center gap-1.5 text-xs min-w-0">
      <Icon size={12} className="text-gray-500 shrink-0" />
      <span className="text-gray-500 truncate" title={label}>{label}:</span>
      {syncing ? (
        <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap">
          <RefreshCw size={11} className="text-port-accent animate-spin shrink-0" />
          <span className="text-port-accent">syncing…</span>
        </span>
      ) : synced ? (
        <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap">
          <CheckCircle2 size={11} className="text-port-success shrink-0" />
          <span className="text-port-success">synced</span>
        </span>
      ) : behind ? (
        <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap">
          <AlertCircle size={11} className="text-port-warning shrink-0" />
          <span className="text-port-warning">behind</span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap">
          <Clock size={11} className="text-gray-500 shrink-0" />
          <span className="text-gray-400">pending</span>
        </span>
      )}
    </div>
  );
}

export default function SyncStatusSection({ peer, syncStatus, syncing = false }) {
  if (!syncStatus || !peer.instanceId) return null;

  const cursor = syncStatus.cursors?.[peer.instanceId];
  const remoteSyncSeqs = peer.remoteSyncSeqs;
  // A full-sync peer mirrors every category, so the snapshot sync status should
  // surface them all on (its stored syncCategories map can be all-false
  // underneath). Mirror the server's allSyncCategoriesOn semantics here.
  const categories = peer.fullSync === true
    ? Object.fromEntries(SYNC_CATEGORY_META.map(m => [m.key, true]))
    : (peer.syncCategories || {});
  // The peer's cursor into OUR data (how far it has pulled from us) — the
  // push-frontier toward this peer. Present only when our probe passed `forPeer`
  // and the peer is new enough to report it; absent → push count is "unknown".
  const peerCursorForUs = remoteSyncSeqs?.cursorForYou ?? null;

  // No sync data available at all
  if (!cursor && !remoteSyncSeqs) return null;

  // Only show delta-based status for enabled categories
  const showBrain = categories.brain;
  const showMemory = categories.memory;

  // Show snapshot category sync status for all enabled snapshot categories
  const cursorChecksums = cursor?.checksums || {};
  const remoteChecksums = remoteSyncSeqs?.checksums || {};

  const enabledSnapshots = SNAPSHOT_CATEGORIES
    .map(m => m.key)
    .filter(cat => categories[cat]);

  if (!showBrain && !showMemory && enabledSnapshots.length === 0) return null;

  return (
    <div className="mt-2 pt-2 border-t border-port-border/50">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Database size={12} className="text-gray-500" />
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Sync Status</span>
        {cursor?.lastSyncAt && (
          <span className="text-[10px] text-gray-600 ml-auto">{timeAgo(cursor.lastSyncAt)}</span>
        )}
      </div>
      {/* A cycle in which every category failed leaves lastSyncAt at its old
          value and records why (#7943) — without this the card read "synced N
          seconds ago" while cross-machine sync had been broken for weeks. */}
      {cursor?.lastSyncError && (
        <div role="status" className="flex items-start gap-1.5 mb-1.5 text-[10px] text-port-error" title={cursor.lastSyncError}>
          <AlertCircle size={12} className="shrink-0 mt-px" />
          <span className="truncate">Last sync failed: {cursor.lastSyncError}</span>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
        {showBrain && (
          <SyncStatusBadge
            label="Brain"
            icon={Brain}
            localSeq={syncStatus.local?.brainSeq}
            peerSeq={remoteSyncSeqs?.brainSeq}
            cursorSeq={cursor?.brainSeq}
            peerCursorForUs={peerCursorForUs?.brainSeq}
            syncing={syncing}
          />
        )}
        {showMemory && (
          <SyncStatusBadge
            label="Memory"
            icon={Database}
            localSeq={syncStatus.local?.memorySeq}
            peerSeq={remoteSyncSeqs?.memorySeq}
            cursorSeq={cursor?.memorySeq}
            peerCursorForUs={peerCursorForUs?.memorySeq}
            syncing={syncing}
          />
        )}
        {enabledSnapshots.map(cat => {
          const meta = SYNC_CATEGORY_META.find(m => m.key === cat);
          if (!meta) return null;
          return (
            <SnapshotSyncBadge
              key={cat}
              label={meta.label}
              icon={meta.icon}
              cursorChecksum={cursorChecksums[cat]}
              remoteChecksum={remoteChecksums[cat]}
              syncing={syncing}
            />
          );
        })}
      </div>
    </div>
  );
}
