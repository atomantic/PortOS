import { useState } from 'react';
import { Square } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';

/**
 * Stop the in-flight final render. A stop discards the partial file, so the
 * first tap only asks; earlier renders stay attached either way.
 */
export default function CancelRenderButton({ onCancel, cancelling = false, className = '' }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming || cancelling) {
    return (
      <ConfirmButtonPair
        prompt={cancelling ? null : 'Stop render?'}
        confirmText="Stop"
        cancelText="Keep"
        busy={cancelling}
        busyText="Stopping…"
        ariaLabel="Confirm stopping the render"
        confirmAriaLabel="Stop the render"
        cancelAriaLabel="Keep rendering"
        onConfirm={() => { onCancel(); setConfirming(false); }}
        onCancel={() => setConfirming(false)}
        largeTouchTargets
        className={className}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-port-error/40 px-3 text-sm text-port-error ${className}`.trim()}
    >
      <Square size={13} aria-hidden="true" /> Cancel render
    </button>
  );
}
