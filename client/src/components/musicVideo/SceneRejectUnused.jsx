import { useState } from 'react';
import { X } from 'lucide-react';
import { TAKE_SLOT } from '../../lib/musicVideoTakes.js';

const BTN = 'inline-flex min-h-[44px] items-center gap-1 rounded px-2 py-1 text-xs disabled:opacity-50 sm:min-h-0';

/** How many of a shot's takes are neither its selected frame, end frame nor clip, nor already rejected. */
export const unusedTakeCount = (scene) => (Array.isArray(scene?.takes) ? scene.takes : [])
  .filter((take) => take?.takeId && TAKE_SLOT[take.kind] && take.status !== 'rejected' && scene[TAKE_SLOT[take.kind]] !== take.assetId).length;

/**
 * Finalize a shot's takes: one tap, then a confirm, rejects every take that is
 * not in use. The files stay and Use or Restore brings any back.
 */
export default function SceneRejectUnused({ scene, busy = false, onReject }) {
  const [confirming, setConfirming] = useState(false);
  const count = unusedTakeCount(scene);
  if (!count || !onReject) return null;
  const takes = `${count} unused take${count === 1 ? '' : 's'}`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {confirming ? (
        <>
          <span className="text-port-text-muted">Reject {takes}? The files stay.</span>
          <button type="button" disabled={busy} onClick={() => { setConfirming(false); onReject(scene); }}
            className={`${BTN} bg-port-error/20 text-port-error`}>
            <X size={12} aria-hidden="true" /> Reject {count}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={`${BTN} border border-port-border`}>Cancel</button>
        </>
      ) : (
        <button type="button" disabled={busy} onClick={() => setConfirming(true)}
          className={`${BTN} border border-port-border`} title="Keep only the frames and clip in use">
          <X size={12} aria-hidden="true" /> Reject unused ({count})
        </button>
      )}
    </div>
  );
}
