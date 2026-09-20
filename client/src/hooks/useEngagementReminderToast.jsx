import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import { useActionQueue } from './useActionQueue';
import { actionSelectionLink } from '../components/ActionQueuePreview';
import { INSTANCE_FEATURES_CHANGED } from '../constants/events.js';

function ReminderToast({ t, action }) {
  const [disabling, setDisabling] = useState(false);
  const canDisable = typeof action.featureId === 'string' && action.featureId.length > 0;

  const handleDisable = async () => {
    if (!canDisable || disabling) return;
    setDisabling(true);
    const result = await api.updateInstanceFeature(action.featureId, false, { silent: true }).catch((error) => {
      toast.error(error.message || 'Could not disable this feature on the instance');
      return null;
    });
    if (!result) {
      setDisabling(false);
      return;
    }
    toast.dismiss(t.id);
    window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, {
      detail: { featureId: action.featureId, enabled: false },
    }));
    toast.success(`${action.featureLabel || action.featureId} disabled on this instance`);
  };

  return (
    <div className="flex flex-col gap-2 max-w-[min(480px,calc(100vw-4rem))]">
      <div className="flex items-start gap-2">
        <span className="text-port-warning" aria-hidden="true">⚠️</span>
        <span className="font-medium text-port-text text-sm flex-1">{action.title}</span>
      </div>
      <p className="text-xs text-port-text-muted">{action.reason || action.summary}</p>
      <div className="flex items-center gap-2 pt-1 border-t border-port-border/30">
        <Link
          to={actionSelectionLink(action.id)}
          onClick={() => toast.dismiss(t.id)}
          className="inline-flex items-center justify-center min-h-[44px] px-3 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-xs font-medium"
        >
          Open action
        </Link>
        {canDisable && (
          <button
            type="button"
            onClick={handleDisable}
            disabled={disabling}
            className="inline-flex items-center justify-center min-h-[44px] px-3 text-xs text-port-warning hover:text-port-warning/80 disabled:opacity-50"
          >
            {disabling ? 'Disabling…' : 'Disable on this instance'}
          </button>
        )}
        <button
          type="button"
          onClick={() => toast.dismiss(t.id)}
          className="inline-flex items-center justify-center min-h-[44px] px-3 text-xs text-port-text-muted hover:text-port-text"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Delivery requires an explicit scheduled reminder and a durable server claim. */
export function useEngagementReminderToast() {
  const { data, error } = useActionQueue();
  useEffect(() => {
    let active = true;
    if (!error && document.visibilityState !== 'hidden') {
      for (const action of data?.items || []) {
        if (action.id !== 'product:daily-post') continue;
        api.claimReviewQueueDelivery(action.id, { silent: true }).then((result) => {
          if (!active || !result.claimed) return;
          toast((t) => <ReminderToast t={t} action={action} />, {
            id: `engagement-reminder-${action.id}:${action.occurrence}:${result.generation}`,
            duration: 12000, icon: null, label: action.title,
          });
        }).catch(() => {});
      }
    }
    return () => { active = false; };
  }, [data, error]);
}
