import { useState, useEffect } from 'react';
import { Check, ArrowLeftRight, CheckCircle2, AlertCircle, Clock, RefreshCcw, ChevronDown, ChevronRight, Lock, Globe } from 'lucide-react';
import toast from '../ui/Toast';
import { updatePeer, reciprocatePeer, getPeerFullSyncCoverage } from '../../services/apiSystem.js';
import { pluralize } from '../../lib/textUtils';
import { MEDIA_COLLECTION_KEYS, MEDIA_SYNC_MODE_OPTIONS, SYNC_CATEGORY_META, isCategoryOn } from './syncCategoryMeta';

// Indicator backed by REAL coverage diffing (record IDs vs confirmed pushes),
// not the BIGSERIAL cursors — so "fully mirrored" never lies. Refetches on mount
// and whenever `refreshKey` changes; the caller passes peer.lastSeen, so it
// refreshes on each probe tick — cheap for a single-user box and lets the
// "N pending" count tick down live as the initial back-subscribe converges.
function FullSyncCoverageBadge({ peerId, peerInstanceId, refreshKey }) {
  const [coverage, setCoverage] = useState(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!peerInstanceId) { setCoverage(null); setLoaded(true); return; }
    let cancelled = false;
    setLoaded(false);
    getPeerFullSyncCoverage(peerId, { silent: true })
      .then((r) => { if (!cancelled) setCoverage(r); })
      .catch(() => { if (!cancelled) setCoverage(null); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [peerId, peerInstanceId, refreshKey]);

  if (!peerInstanceId) {
    return <span className="text-[10px] text-gray-600">awaiting first connection…</span>;
  }
  if (!loaded) {
    return <span className="text-[10px] text-gray-600">checking coverage…</span>;
  }
  if (!coverage || coverage.available === false || coverage.partial === true) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-port-warning" title="Coverage could not be verified. Any available counts are partial; retry on the next refresh.">
        <AlertCircle size={11} /> Coverage unavailable
      </span>
    );
  }
  if (coverage.fullyMirrored) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-port-success" title={`All ${pluralize(coverage.total, 'record')} confirmed delivered to this peer`}>
        <CheckCircle2 size={11} /> Fully mirrored · {pluralize(coverage.total, 'record')}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] text-port-warning" title={`${coverage.pending} of ${pluralize(coverage.total, 'record')} not yet confirmed delivered`}>
      <Clock size={11} /> {coverage.pending} pending · {coverage.confirmed}/{coverage.total} mirrored
    </span>
  );
}

export default function SyncCategoriesPanel({ peer, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const categories = peer.syncCategories || {};
  const fullSync = peer.fullSync === true;
  // A full-sync peer mirrors every category — present them as locked-on.
  const enabledCount = fullSync ? SYNC_CATEGORY_META.length : SYNC_CATEGORY_META.filter(({ key }) => isCategoryOn(categories, key)).length;
  const mediaSyncMode = peer.mediaSyncMode === 'host' ? 'host' : 'copy';

  const toggleFullSync = async () => {
    await updatePeer(peer.id, { fullSync: !fullSync }).catch(() => null);
    onRefresh();
  };

  // `syncEnabled` is NOT sent: the server derives it from the resulting category
  // map, excluding the default-ON ones. Deriving it here would read `usage: true`
  // as "something is enabled" and widen the peer's outbound push consent.
  const toggleCategory = async (key) => {
    if (fullSync) return; // categories are locked-on under full mirror
    const next = !isCategoryOn(categories, key);
    const keys = key === 'mediaCollections' ? MEDIA_COLLECTION_KEYS : [key];
    await updatePeer(peer.id, { syncCategories: Object.fromEntries(keys.map(k => [k, next])) }).catch(() => null);
    onRefresh();
  };

  const changeMediaSyncMode = async (mode) => {
    if (mode === mediaSyncMode) return;
    await updatePeer(peer.id, { mediaSyncMode: mode }).catch(() => null);
    onRefresh();
  };

  const mediaDeleteAllowed = peer.mediaDeleteAllowed !== false;
  const toggleMediaDeleteAllowed = async () => {
    await updatePeer(peer.id, { mediaDeleteAllowed: !mediaDeleteAllowed }).catch(() => null);
    onRefresh();
  };

  const toggleAll = async (enable) => {
    const updated = {};
    for (const { key } of SYNC_CATEGORY_META) {
      updated[key] = enable;
    }
    updated.videoHistory = enable;
    await updatePeer(peer.id, { syncCategories: updated }).catch(() => null);
    onRefresh();
  };

  // Explicitly push our current category map to the peer so it enables the same
  // toward us. Toggling already auto-reciprocates; this is the catch-up button
  // for peers configured one-directionally before auto-reciprocate existed, or
  // when the peer was offline during an earlier toggle.
  const makeMutual = async () => {
    const result = await reciprocatePeer(peer.id, { silent: true }).catch(() => null);
    if (result?.ok) toast.success(`Asked ${peer.name} to sync the same categories back`);
    else toast.error(`Couldn't reach ${peer.name} to make sync mutual — try again when it's online`);
    onRefresh();
  };

  return (
    <div className="mt-2 pt-2 border-t border-port-border/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full text-left group py-1.5 pointer-coarse:min-h-11"
      >
        {expanded ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
        <RefreshCcw size={12} className={enabledCount > 0 ? 'text-port-accent' : 'text-gray-500'} />
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium group-hover:text-gray-400 transition-colors">
          Sync Categories
        </span>
        <span className={`text-[10px] ml-auto ${enabledCount > 0 ? 'text-port-accent' : 'text-gray-600'}`}>
          {enabledCount}/{SYNC_CATEGORY_META.length}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          {/* Full mirror toggle — when on, every current + future category is
              implied and all subscribable records back-subscribe to this peer. */}
          <button
            onClick={toggleFullSync}
            className={`flex items-start gap-2 w-full px-2 py-1.5 rounded border transition-colors text-left mb-1.5 ${
              fullSync ? 'border-port-accent/60 bg-port-accent/10' : 'border-port-border hover:bg-port-bg/50'
            }`}
          >
            <div className={`w-3 h-3 mt-0.5 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
              fullSync ? 'bg-port-accent border-port-accent' : 'border-gray-600 bg-transparent'
            }`}>
              {fullSync && <Check size={8} className="text-white" />}
            </div>
            <Globe size={12} className={`mt-0.5 ${fullSync ? 'text-port-accent' : 'text-gray-500'}`} />
            <div className="flex-1 min-w-0">
              <span className={`text-xs font-medium ${fullSync ? 'text-white' : 'text-gray-300'}`}>Full mirror</span>
              <p className="text-[10px] text-gray-600 leading-snug">
                Mirror everything to {peer.name || 'this peer'} — every category, all existing
                records, and any new category added in a future version. Reciprocated automatically.
              </p>
              {fullSync && (
                <div className="mt-1">
                  <FullSyncCoverageBadge peerId={peer.id} peerInstanceId={peer.instanceId} refreshKey={peer.lastSeen} />
                </div>
              )}
            </div>
          </button>
          <p className="text-[10px] text-gray-600 mb-1.5 leading-snug">
            {fullSync
              ? 'Categories are locked on while full mirror is enabled. Turn it off to choose categories individually.'
              : <>Enabling a category syncs it both ways — we ask {peer.name || 'the peer'} to sync the same back automatically.</>}
          </p>
          <div className="flex items-center justify-end gap-2 mb-1.5">
            {/* Available whenever we know the peer's identity — NOT gated on
                enabledCount. The worst stale case is disabling the LAST category
                while the peer is offline: the peer keeps its now-stale enabled
                set, and the reciprocate endpoint pushes our all-false map to
                clear it. Gating on enabledCount>0 would hide the control exactly
                when it's needed. */}
            {peer.instanceId && (
              <button
                onClick={makeMutual}
                className="flex items-center gap-1 mr-auto text-[10px] pointer-coarse:min-h-11 text-gray-500 hover:text-port-accent transition-colors"
                title="Push the current categories to this peer so it syncs them back (use if it was offline during a change)"
              >
                <ArrowLeftRight size={10} />
                Make mutual
              </button>
            )}
            {/* Enable/Disable-all are moot under full mirror (categories locked on). */}
            {!fullSync && (
              <>
                <button
                  onClick={() => toggleAll(true)}
                  className="text-[10px] pointer-coarse:min-h-11 text-port-accent hover:text-port-accent/80 transition-colors"
                >
                  Enable all
                </button>
                <button
                  onClick={() => toggleAll(false)}
                  className="text-[10px] pointer-coarse:min-h-11 text-gray-500 hover:text-gray-400 transition-colors"
                >
                  Disable all
                </button>
              </>
            )}
          </div>
          <label htmlFor={`media-delete-${peer.id}`} className="flex items-start gap-2 mb-2 cursor-pointer">
            <input
              id={`media-delete-${peer.id}`}
              type="checkbox"
              checked={mediaDeleteAllowed}
              onChange={toggleMediaDeleteAllowed}
              className="mt-0.5 min-h-[16px] min-w-[16px]"
            />
            <span className="text-xs text-gray-300">
              Allow this peer to delete media on this machine
              <span className="block text-[10px] text-gray-600">When off, deletions this peer makes do not remove your local images or videos.</span>
            </span>
          </label>
          {SYNC_CATEGORY_META.map(({ key, label, icon: Icon, description }) => {
            // Under full mirror every category reads as on and is non-interactive.
            const on = fullSync || isCategoryOn(categories, key);
            return (
            <div key={key}>
            <button
              onClick={() => toggleCategory(key)}
              disabled={fullSync}
              title={fullSync ? 'Locked on by full mirror' : undefined}
              className={`flex items-center gap-2 w-full px-2 py-1.5 rounded text-left transition-colors ${fullSync ? 'opacity-70 cursor-default' : 'hover:bg-port-bg/50'}`}
            >
              <div className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
                on
                  ? 'bg-port-accent border-port-accent'
                  : 'border-gray-600 bg-transparent'
              }`}>
                {on && (fullSync ? <Lock size={7} className="text-white" /> : <Check size={8} className="text-white" />)}
              </div>
              <Icon size={12} className={on ? 'text-port-accent' : 'text-gray-500'} />
              <div className="flex-1 min-w-0">
                <span className={`text-xs ${on ? 'text-white' : 'text-gray-400'}`}>{label}</span>
                <p className="text-[10px] text-gray-600 truncate">{description}</p>
              </div>
            </button>
            {key === 'mediaCollections' && on && (
              <fieldset className="ml-7 mt-1 mb-1.5" aria-label="Media Collections sync method">
                <legend className="sr-only">Media Collections sync method</legend>
                <div className="flex flex-wrap gap-1.5">
                  {MEDIA_SYNC_MODE_OPTIONS.map(option => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => changeMediaSyncMode(option.value)}
                      aria-pressed={mediaSyncMode === option.value}
                      title={option.description}
                      className={`px-2 py-1 min-h-[28px] rounded text-[10px] pointer-coarse:min-h-11 border transition-colors ${
                        mediaSyncMode === option.value
                          ? 'border-port-accent bg-port-accent/20 text-port-accent'
                          : 'border-port-border text-gray-400 hover:bg-port-bg/50'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-600 mt-1">
                  {MEDIA_SYNC_MODE_OPTIONS.find(o => o.value === mediaSyncMode).description}
                  {fullSync ? '. Full mirror still copies the whole media library.' : '.'}
                </p>
              </fieldset>
            )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
