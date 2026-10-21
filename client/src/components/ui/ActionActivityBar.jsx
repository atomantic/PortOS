import { useEffect, useState, useSyncExternalStore } from 'react';
import { getPendingActionCount, subscribePendingActions } from '../../services/actionFeedback';

// How long a tap-started request runs before the bar appears; quicker actions
// finish on the button's own busy state without a second indicator.
const SHOW_AFTER_MS = 300;

// Thin indeterminate bar along the top of the app while any tap-started
// request is in flight, so an action whose button has scrolled away or
// unmounted (a closed drawer, a submitted modal) still visibly works.
export default function ActionActivityBar() {
  const pending = useSyncExternalStore(subscribePendingActions, getPendingActionCount) > 0;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!pending) {
      setVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  if (!visible) return null;
  return (
    <div role="progressbar" aria-label="Working" className="action-activity-bar fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden pointer-events-none">
      <div className="action-activity-bar__fill h-full w-1/3 bg-port-accent" />
    </div>
  );
}
