import { useState, useCallback } from 'react';
import { dismissHealthWarning, undismissHealthWarning } from '../services/apiSystem.js';
import toast from '../components/ui/Toast';
import { Undo2 } from 'lucide-react';

// Shared by SystemHealthWidget (dashboard) and SystemHealthPage (the "Live
// health" overview) — both dismiss a system-health warning the same way:
// record it server-side, refetch, then offer an Undo toast. Warnings are
// recomputed fresh on every /health/details read rather than stored, so
// there's nothing to remove client-side; `refetchFn` is what pulls the
// trimmed list back in.
export function useHealthWarningDismiss(refetchFn) {
  const [dismissingType, setDismissingType] = useState(null);

  const handleDismissWarning = useCallback(async (warning) => {
    if (!refetchFn || dismissingType) return;
    setDismissingType(warning.type);
    try {
      await dismissHealthWarning(warning.type, warning.message, { silent: true });
      await refetchFn();
      toast((t) => (
        <span className="flex items-center gap-3 text-xs">
          <span className="text-gray-200">Dismissed: <span className="font-medium text-white">{warning.message}</span></span>
          <button
            type="button"
            onClick={() => {
              undismissHealthWarning(warning.type, { silent: true }).then(() => refetchFn());
              toast.dismiss(t.id);
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-port-border px-2 py-0.5 text-[11px] text-port-accent hover:border-port-accent/40 hover:text-white"
          >
            <Undo2 size={12} /> Undo
          </button>
        </span>
      ), { duration: 8000 });
    } catch (err) {
      toast.error(err?.message || 'Failed to dismiss warning');
    } finally {
      setDismissingType(null);
    }
  }, [refetchFn, dismissingType]);

  return { dismissingType, handleDismissWarning };
}
