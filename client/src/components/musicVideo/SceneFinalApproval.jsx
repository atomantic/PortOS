import { useId, useState } from 'react';
import { Check } from 'lucide-react';
import { sceneClipIsFinal, sceneFinalApproved, selectedVideoTake } from '../../../../server/lib/musicVideo/musicVideoFinalApproval.js';
import { takeClipUrl } from '../../lib/musicVideoTakes.js';

const BUTTON = 'flex items-center gap-1 rounded border border-port-accent px-2 py-1.5 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50 min-h-[44px] pointer-fine:sm:min-h-0 whitespace-nowrap';

/**
 * The newest final-tier clip take that is not the selection, while the selection is still a draft:
 * a re-render landed beside the draft (#16136) and waits for the director to compare and pick it.
 */
function pendingFinalTake(scene) {
  const selected = selectedVideoTake(scene);
  if (!selected || selected.tier === 'final') return null;
  const finals = (scene.takes || []).filter((take) => take?.kind === 'video' && take.tier === 'final'
    && take.status !== 'rejected' && take.assetId !== scene.videoHistoryId);
  return finals.reduce((newest, take) => (!newest || String(take.createdAt || '') > String(newest.createdAt || '') ? take : newest), null);
}

/**
 * A shot card's "Approve for final" tick (#16136), under its clip takes. The approval
 * belongs to the selected draft take and the shot's prompt and frames, so changing any
 * of them clears it; the card says so rather than silently unticking. A re-rendered
 * final take is a new take, so it is shown beside the draft to compare before it is used.
 */
export default function SceneFinalApproval({ scene, locked = false, busy = false, onApprove = null, onSelectTake = null }) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const selected = selectedVideoTake(scene);
  if (!selected || !onApprove) return null;
  const final = sceneClipIsFinal(scene);
  const approved = sceneFinalApproved(scene);
  const cleared = !final && !approved && Boolean(scene.finalApproval);
  const candidate = pendingFinalTake(scene);
  const toggle = (next) => {
    if (saving) return;
    setSaving(true);
    Promise.resolve(onApprove([scene.sceneId], next)).finally(() => setSaving(false));
  };
  return (
    <div className="min-w-0 space-y-2 text-xs" data-testid="scene-final-approval">
      {final ? (
        <p className="flex items-center gap-1 text-port-success"><Check size={12} aria-hidden="true" /> The selected clip is the final render.</p>
      ) : (
        <label htmlFor={`${id}-approve`} className="flex min-h-[44px] items-center gap-2 pointer-fine:sm:min-h-0">
          <input id={`${id}-approve`} type="checkbox" checked={approved} disabled={locked || saving}
            onChange={(event) => toggle(event.target.checked)} />
          {saving ? 'Saving…' : 'Approve for final'}
          <span className="text-port-text-muted">(upgrade this draft from the board&apos;s Upgrade approved)</span>
        </label>
      )}
      {cleared && (
        <p className="text-port-warning" data-testid="final-approval-cleared">
          Approval cleared: the shot prompt, a frame or the selected take changed after you approved it. Tick it again to approve this version.
        </p>
      )}
      {candidate && (
        <div className="min-w-0 space-y-1 rounded border border-port-border p-2" data-testid="final-take-compare">
          <p className="text-port-text-muted">
            A final re-render landed beside the draft. It is a new take, not the same take at a higher resolution, so compare them before using it.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <figure className="min-w-0 space-y-1">
              <video src={takeClipUrl(selected)} controls muted playsInline preload="metadata" className="aspect-video w-full rounded border border-port-border bg-black object-contain" aria-label="Selected draft take" />
              <figcaption className="text-port-text-muted">Draft (in use)</figcaption>
            </figure>
            <figure className="min-w-0 space-y-1">
              <video src={takeClipUrl(candidate)} controls muted playsInline preload="metadata" className="aspect-video w-full rounded border border-port-border bg-black object-contain" aria-label="Final re-render take" />
              <figcaption className="text-port-text-muted">Final re-render</figcaption>
            </figure>
          </div>
          {onSelectTake && (
            <button type="button" className={BUTTON} disabled={locked || busy} onClick={() => onSelectTake(scene, candidate)}>
              <Check size={14} aria-hidden="true" /> Use the final take
            </button>
          )}
        </div>
      )}
    </div>
  );
}
