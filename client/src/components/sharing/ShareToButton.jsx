/**
 * ShareToButton — small dropdown that lists registered share buckets and
 * exports the given record (series / universe / media items) to the chosen
 * bucket. Used on Pipeline.jsx, UniverseBuilder.jsx, and the media gallery.
 *
 * Props:
 *   kind: 'series' | 'universe' | 'media'
 *   ids?: string[]            // for series / universe
 *   items?: [{ kind, ref }]   // for media (mediaCollections item shape)
 *   label?: string            // button label override
 *   compact?: boolean         // icon-only when true
 */

import { useEffect, useRef, useState } from 'react';
import { Share2, Check, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listShareBuckets,
  exportToShareBucket,
} from '../../services/api';

export default function ShareToButton({ kind, ids, items, label = 'Share', compact = false, className = '' }) {
  const [open, setOpen] = useState(false);
  const [buckets, setBuckets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sharingTo, setSharingTo] = useState(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listShareBuckets({ silent: true })
      .then((r) => setBuckets(r?.buckets || []))
      .catch(() => setBuckets([]))
      .finally(() => setLoading(false));
  }, [open]);

  // Close on click-outside.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const handleShare = async (bucket) => {
    setSharingTo(bucket.id);
    const body = { kind };
    if (kind === 'media') body.items = items || [];
    else body.ids = ids || [];
    const result = await exportToShareBucket(bucket.id, body).catch((err) => {
      toast.error(err.message || `Share to ${bucket.name} failed`);
      return null;
    });
    setSharingTo(null);
    if (!result) return;
    const totals = (result.exports || []).reduce(
      (acc, e) => ({ records: acc.records + (e.recordCount || 0), assets: acc.assets + (e.assetCount || 0) }),
      { records: 0, assets: 0 },
    );
    toast.success(`Shared to ${bucket.name} — ${totals.records} record${totals.records === 1 ? '' : 's'}, ${totals.assets} asset${totals.assets === 1 ? '' : 's'}`);
    setOpen(false);
  };

  // Disabled when there's nothing to share.
  const nothingToShare = kind === 'media'
    ? !(Array.isArray(items) && items.length > 0)
    : !(Array.isArray(ids) && ids.length > 0);

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
        <div className="absolute right-0 z-30 mt-1 w-64 bg-port-card border border-port-border rounded-lg shadow-lg overflow-hidden">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-gray-500 border-b border-port-border">
            Share to bucket
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
              {buckets.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => handleShare(b)}
                    disabled={sharingTo === b.id}
                    className="w-full text-left px-3 py-2 hover:bg-port-bg disabled:opacity-50 flex items-start gap-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white truncate">{b.name}</div>
                      <div className="text-[10px] text-gray-500 truncate">
                        {b.mode === 'auto-merge' ? 'auto-merge' : 'inbox'} · {b.path}
                      </div>
                    </div>
                    {sharingTo === b.id ? <Loader2 size={12} className="animate-spin mt-1 text-port-accent" /> : <Check size={12} className="mt-1 text-gray-600" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
