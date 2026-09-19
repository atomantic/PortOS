// A Brain thread is a tracked topic, distinct from a message thread.
// Source closure is a suggestion: only this explicit action completes the loop.
import { useRef } from 'react';
import useAsyncAction from '../../hooks/useAsyncAction';
import { isTerminalThreadStatus } from '../../lib/brainThreads.js';
import * as api from '../../services/api';

export default function ThreadSourceClosedAction({ thread, onCompleted, onPendingChange, disabled = false }) {
  const inFlight = useRef(false);
  const [complete, completing] = useAsyncAction(async () => {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    onPendingChange?.(true);
    const updated = await api.updateThread(thread.id, { status: 'done' }, { silent: true })
      .finally(() => {
        inFlight.current = false;
        onPendingChange?.(false);
      });
    onCompleted(updated);
  }, { errorMessage: 'Failed to complete thread' });

  if (thread.externalState !== 'closed' || isTerminalThreadStatus(thread.status)) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs text-port-warning">
      <span>Source closed — mark done?</span>
      <button
        type="button"
        onClick={complete}
        disabled={disabled || completing}
        aria-label={`Mark "${thread.title}" done`}
        className="min-h-8 px-2 rounded border border-port-border hover:border-port-success hover:text-port-success disabled:opacity-50"
      >
        {completing ? 'Saving…' : 'Mark done'}
      </button>
    </div>
  );
}
