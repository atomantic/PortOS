import { useState } from 'react';
import toast from '../components/ui/Toast';

// Shared optimistic-PATCH lock-toggle action. Four near-identical implementations
// (arc lock, per-arc-field lock, per-season lock, per-stage lock) collapsed to
// one hook: `setBusy(true) → PATCH-with-catch → setBusy(false) → onSuccess + toast`.
//
// Usage:
//   const { busy, toggle } = useLockToggle({
//     patchFn: (next) => updatePipelineSeries(id, { locked: { ...locked, arc: next } }, { silent: true }),
//     onSuccess: (updated, next) => { onSeriesUpdate(updated); if (next) closeConfirm(); },
//     lockedMessage: 'Arc locked — regeneration is now blocked',
//     unlockedMessage: 'Arc unlocked',
//     errorMessage: 'Failed to update lock',
//   });
//   <button disabled={busy} onClick={() => toggle(currentlyLocked)} />
export function useLockToggle({ patchFn, onSuccess, lockedMessage, unlockedMessage, errorMessage = 'Lock toggle failed' }) {
  const [busy, setBusy] = useState(false);
  const toggle = async (currentlyLocked) => {
    if (busy) return;
    const next = !currentlyLocked;
    setBusy(true);
    const updated = await patchFn(next).catch((err) => {
      toast.error(err?.message || errorMessage);
      return null;
    });
    setBusy(false);
    if (!updated) return;
    onSuccess?.(updated, next);
    toast.success(next ? lockedMessage : unlockedMessage);
  };
  return { busy, toggle };
}
