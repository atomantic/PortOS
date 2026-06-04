import { useState } from 'react';
import { Check, X, Inbox, AlertTriangle } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';

// Flow 4 — approve / reject a CoS result. Surfaces the same
// awaiting-approval queue the desktop Tasks tab shows (internal tasks with
// approvalRequired). Approve clears the flag; reject deletes the internal task.
export default function MobileApproveFlow() {
  const { data, loading, refetch } = useAutoRefetch(() => api.getCosTasks({ silent: true }), 20_000);
  const [busyId, setBusyId] = useState(null);

  const approve = async (task) => {
    setBusyId(task.id);
    // silent: this flow owns the error toast in the catch below.
    const result = await api.approveCosTask(task.id, { silent: true }).catch((err) => {
      toast.error(`Approve failed: ${err.message}`);
      return null;
    });
    setBusyId(null);
    if (!result) return; // approve rejects on failure → handled by the catch above
    toast.success('Approved');
    refetch();
  };

  const reject = async (task) => {
    setBusyId(task.id);
    // silent: this flow owns the error toast in the catch below.
    const result = await api.deleteCosTask(task.id, 'internal', { silent: true }).catch((err) => {
      toast.error(`Reject failed: ${err.message}`);
      return null;
    });
    setBusyId(null);
    if (!result) return;
    toast.success('Rejected');
    refetch();
  };

  if (loading && !data) {
    return <div className="flex justify-center py-12"><BrailleSpinner text="Loading approvals" /></div>;
  }

  // useAutoRefetch preserves the last good snapshot on error, so a null `data`
  // after the initial load means the fetch never succeeded — distinguish that
  // from a genuinely-empty queue so a failed fetch doesn't read as "all clear".
  if (!data) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-gray-500">
        <AlertTriangle size={40} aria-hidden="true" />
        <p className="text-base">Approvals are unavailable right now.</p>
      </div>
    );
  }

  // GET /api/cos/tasks returns { user, cos } — awaiting-approval lives on cos.
  const awaiting = data.cos?.awaitingApproval || [];

  if (awaiting.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-gray-500">
        <Inbox size={40} aria-hidden="true" />
        <p className="text-base">Nothing awaiting approval.</p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {awaiting.map((task) => (
        <li key={task.id} className="rounded-xl border border-port-warning/40 bg-port-card p-4">
          <div className="mb-3 text-base font-medium text-white">{task.title || task.description || task.id}</div>
          {task.description && task.title && (
            <p className="mb-3 text-sm text-gray-400">{task.description}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => approve(task)}
              disabled={busyId === task.id}
              className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-lg bg-port-success/15 text-base font-semibold text-port-success disabled:opacity-50"
            >
              <Check size={18} aria-hidden="true" /> Approve
            </button>
            <button
              onClick={() => reject(task)}
              disabled={busyId === task.id}
              className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-lg bg-port-error/15 text-base font-semibold text-port-error disabled:opacity-50"
            >
              <X size={18} aria-hidden="true" /> Reject
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
