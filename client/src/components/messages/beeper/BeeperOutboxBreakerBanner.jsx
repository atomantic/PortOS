import { useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import Banner from '../../ui/Banner';
import toast from '../../ui/Toast';
import { clearOutboxBreaker } from '../../../services/api';

/**
 * The runaway breaker, on the settings card and nowhere else (#36, decided on
 * #8 decision 4 and #12's two-surfaces rule).
 *
 * The breaker trips when sends arrive faster than a human produces them — a
 * software loop, not a busy conversation. It blocks every further send until a
 * person clears it here: there is no timed recovery anywhere in the send path,
 * because a breaker that resets itself is a delay rather than a breaker.
 *
 * It renders where actionable Beeper faults already render, never as a global
 * banner: a user who is not sending anything has nothing to act on.
 *
 * @param {object} props
 * @param {object|null} props.breaker `status.outbox.breaker` from GET /api/beeper/status.
 * @param {() => void} [props.onCleared] refetch hook for the parent's status.
 */
export default function BeeperOutboxBreakerBanner({ breaker, onCleared }) {
  const [clearing, setClearing] = useState(false);
  if (!breaker?.tripped) return null;

  const handleClear = async () => {
    setClearing(true);
    const result = await clearOutboxBreaker({ silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not clear the send breaker');
      return null;
    });
    setClearing(false);
    if (!result) return;
    toast.success('Beeper sending re-enabled');
    onCleared?.();
  };

  return (
    <Banner
      tone="error"
      icon={ShieldAlert}
      size="md"
      title="Beeper sending is blocked"
      actions={(
        <button
          type="button"
          onClick={handleClear}
          disabled={clearing}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-port-error hover:bg-port-error/20 disabled:opacity-40"
        >
          {clearing ? <Loader2 size={12} className="animate-spin" /> : null}
          {clearing ? 'Clearing…' : 'Clear breaker'}
        </button>
      )}
    >
      The runaway breaker tripped ({breaker.reason || 'unexpected send rate'}). No message has been sent since,
      and nothing is retried automatically. Check what was sending before clearing this.
    </Banner>
  );
}
