/**
 * ShareToButton — dropdown of registered buckets that toggles subscriptions
 * for series + universes, and does one-shot sharing for media items.
 *
 * Subscription kinds (series, universe):
 *   Each bucket row shows a filled CheckCircle when the (recordKind, recordId)
 *   is currently subscribed to that bucket, or an empty Circle otherwise.
 *   Clicking a checked row UNSUBSCRIBES; clicking an unchecked row SUBSCRIBES
 *   (which kicks off the initial export and then auto-re-exports on every
 *   subsequent local edit, debounced).
 *
 * Media kind:
 *   One-shot — clicking a bucket exports the selected items into that bucket
 *   as a manifest. No checked-state tracking because media doesn't mutate
 *   after creation; repeated clicks are repeated shares.
 *
 * Props:
 *   kind: 'series' | 'universe' | 'media'
 *   ids?: string[]            // for series / universe (uses ids[0] as the subject)
 *   items?: [{ kind, ref }]   // for media
 *   label?: string
 *   compact?: boolean
 */

import { useEffect, useRef, useState } from 'react';
import { Share2, Check, Circle, CheckCircle2, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listShareBuckets,
  exportToShareBucket,
  listShareSubscriptions,
  subscribeToShareBucket,
  unsubscribeFromShareBucket,
} from '../../services/api';

const SUBSCRIBABLE_KINDS = new Set(['series', 'universe']);

function renderRowIcon({ busy, subscribable, subscribed }) {
  if (busy) return <Loader2 size={14} className="animate-spin text-port-accent" />;
  if (!subscribable) return <Check size={14} className="text-gray-600" />;
  return subscribed
    ? <CheckCircle2 size={14} className="text-port-success" />
    : <Circle size={14} className="text-gray-600" />;
}

export default function ShareToButton({ kind, ids, items, label = 'Share', compact = false, className = '' }) {
  const [open, setOpen] = useState(false);
  const [buckets, setBuckets] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]); // [{id, bucketId, ...}]
  const [loading, setLoading] = useState(false);
  const [busyBucketId, setBusyBucketId] = useState(null);
  const wrapperRef = useRef(null);

  const isSubscribable = SUBSCRIBABLE_KINDS.has(kind);
  const recordId = isSubscribable && Array.isArray(ids) && ids.length > 0 ? ids[0] : null;

  // Refresh buckets + subscriptions on open. Subscriptions are scoped to the
  // (kind, recordId) being viewed so the "checked" indicator reflects this
  // record specifically, not the bucket's universe of subscriptions.
  const refresh = async () => {
    setLoading(true);
    const tasks = [
      listShareBuckets({ silent: true }).then((r) => r?.buckets || []).catch(() => []),
    ];
    if (isSubscribable && recordId) {
      tasks.push(
        listShareSubscriptions({ recordKind: kind, recordId }, { silent: true })
          .then((r) => r?.subscriptions || [])
          .catch(() => []),
      );
    } else {
      tasks.push(Promise.resolve([]));
    }
    const [b, s] = await Promise.all(tasks);
    setBuckets(b);
    setSubscriptions(s);
    setLoading(false);
  };

  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const subscriptionForBucket = (bucketId) =>
    subscriptions.find((s) => s.bucketId === bucketId) || null;

  // Subscribable path — toggle on click.
  const handleToggleSubscription = async (bucket) => {
    if (!recordId) return;
    setBusyBucketId(bucket.id);
    const existing = subscriptionForBucket(bucket.id);
    if (existing) {
      const ok = await unsubscribeFromShareBucket(existing.id).catch((err) => {
        toast.error(err.message || `Unshare from ${bucket.name} failed`);
        return null;
      });
      if (ok) {
        setSubscriptions((prev) => prev.filter((s) => s.id !== existing.id));
        toast.success(`Unshared from ${bucket.name}`);
      }
    } else {
      const result = await subscribeToShareBucket({
        bucketId: bucket.id,
        recordKind: kind,
        recordId,
      }).catch((err) => {
        toast.error(err.message || `Share to ${bucket.name} failed`);
        return null;
      });
      if (result?.subscription) {
        setSubscriptions((prev) => [...prev, result.subscription]);
        toast.success(`Sharing to ${bucket.name} — updates will sync automatically`);
      }
    }
    setBusyBucketId(null);
  };

  // Media one-shot path — click to send a fresh manifest.
  const handleOneShotShare = async (bucket) => {
    setBusyBucketId(bucket.id);
    const result = await exportToShareBucket(bucket.id, { kind, items: items || [] }).catch((err) => {
      toast.error(err.message || `Share to ${bucket.name} failed`);
      return null;
    });
    setBusyBucketId(null);
    if (!result) return;
    const totals = (result.exports || []).reduce(
      (acc, e) => ({ records: acc.records + (e.recordCount || 0), assets: acc.assets + (e.assetCount || 0) }),
      { records: 0, assets: 0 },
    );
    toast.success(`Shared to ${bucket.name} — ${totals.records} record${totals.records === 1 ? '' : 's'}, ${totals.assets} asset${totals.assets === 1 ? '' : 's'}`);
    setOpen(false);
  };

  const nothingToShare = isSubscribable
    ? !recordId
    : !(Array.isArray(items) && items.length > 0);

  return (
    <div ref={wrapperRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={nothingToShare}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border border-port-border hover:border-port-accent/40 text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${compact ? 'p-1.5' : ''}`}
        title={nothingToShare ? 'Nothing selected to share' : 'Share to a bucket'}
      >
        <Share2 size={12} />
        {!compact && <span>{label}</span>}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 bg-port-card border border-port-border rounded-lg shadow-lg overflow-hidden">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-gray-500 border-b border-port-border">
            {isSubscribable ? 'Subscribe to bucket' : 'Share to bucket'}
          </div>
          {loading ? (
            <div className="px-3 py-3 text-xs text-gray-500 flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Loading buckets…
            </div>
          ) : buckets.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-500">
              No buckets yet. <a href="/sharing" className="text-port-accent hover:underline">Add one</a>.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {buckets.map((b) => {
                const subscribed = isSubscribable && !!subscriptionForBucket(b.id);
                const busy = busyBucketId === b.id;
                const click = isSubscribable ? () => handleToggleSubscription(b) : () => handleOneShotShare(b);
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={click}
                      disabled={busy}
                      className="w-full text-left px-3 py-2 hover:bg-port-bg disabled:opacity-50 flex items-start gap-2"
                    >
                      <span className="mt-0.5 shrink-0">
                        {renderRowIcon({ busy, subscribable: isSubscribable, subscribed })}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white truncate">{b.name}</div>
                        <div className="text-[10px] text-gray-500 truncate">
                          {b.mode === 'auto-merge' ? 'auto-merge' : 'inbox'} · {b.path}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {isSubscribable && subscriptions.length > 0 && (
            <div className="px-3 py-2 text-[10px] text-gray-500 border-t border-port-border">
              Subscribed buckets receive your edits automatically as you save.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
