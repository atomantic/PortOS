import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Loader2, Circle } from 'lucide-react';
import socket from '../services/socket';

// Maps an analyze-stage `status` to the lucide icon + className that renders
// it in the importer checklist. Co-located with the hook so the socket frame
// shape and its rendering stay in one place; consumers spread the entry as
// JSX props: `<Icon className={className} />`. Falls back to the `pending`
// row for unknown statuses (a future server status won't crash the list).
const STAGE_STATUS_ICON = {
  done: { Icon: CheckCircle2, className: 'w-4 h-4 text-port-success flex-shrink-0' },
  error: { Icon: AlertTriangle, className: 'w-4 h-4 text-port-warning flex-shrink-0' },
  running: { Icon: Loader2, className: 'w-4 h-4 text-port-accent animate-spin flex-shrink-0' },
  pending: { Icon: Circle, className: 'w-4 h-4 text-port-text-muted/40 flex-shrink-0' },
};

export function stageStatusIcon(status) {
  return STAGE_STATUS_ICON[status] || STAGE_STATUS_ICON.pending;
}

// Subscribes to the `importer:progress` socket stream and tracks the live
// analyze-phase stage checklist. The server broadcasts to all clients
// (single-user trust model), so each frame carries a `runId`: we seed the
// stage list on a `start` frame and ignore `stage` frames that don't match
// the run that `start` opened — guards against a straggler from a prior run.
//
// Returns `{ stages, reset }`. `stages` is `null` until the first `start`
// frame, then an array of `{ id, label, status }` where status is
// 'pending' | 'running' | 'done' | 'error'. Call `reset()` before kicking off
// a fresh analyze to clear the prior run's checklist; the next `start` frame
// repopulates it (a generic spinner shows in the gap).
export function useImporterProgress() {
  const [stages, setStages] = useState(null);
  const activeRunIdRef = useRef(null);

  const reset = useCallback(() => {
    activeRunIdRef.current = null;
    setStages(null);
  }, []);

  useEffect(() => {
    const onProgress = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'start') {
        activeRunIdRef.current = ev.runId;
        setStages(
          (Array.isArray(ev.stages) ? ev.stages : []).map((s) => ({ ...s, status: 'pending' })),
        );
        return;
      }
      if (ev.type === 'stage') {
        if (ev.runId !== activeRunIdRef.current) return;
        setStages((prev) =>
          Array.isArray(prev) ? prev.map((s) => (s.id === ev.id ? { ...s, status: ev.status } : s)) : prev,
        );
      }
    };
    socket.on('importer:progress', onProgress);
    return () => socket.off('importer:progress', onProgress);
  }, []);

  return { stages, reset };
}
