/**
 * Per-stage version history modal — lists prior `runHistory` snapshots for a
 * text stage and shows an inline word-diff between the selected snapshot and
 * the live stage output. "Restore" sets the snapshot back as the active state;
 * the just-replaced version is itself snapshotted server-side, so restore is
 * reversible.
 */

import { useEffect, useState } from 'react';
import { History, Loader2, RotateCcw, X } from 'lucide-react';
import Modal from '../../ui/Modal';
import InlineDiff from '../../ui/InlineDiff';
import { restorePipelineStageVersion, PIPELINE_STAGE_LABELS } from '../../../services/api';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { timeAgo } from '../../../utils/formatters';
import toast from '../../ui/Toast';

export default function StageHistoryModal({
  open,
  onClose,
  issueId,
  stageId,
  currentOutput,
  currentRunId,
  runHistory = [],
  restoreBlockedReason = null,
  onRestored,
}) {
  const [selectedRunId, setSelectedRunId] = useState(null);

  // Default-select the newest snapshot on open so the user sees a diff
  // immediately. Successful restore closes the modal, so we don't need to
  // re-pick when runHistory changes mid-session.
  useEffect(() => {
    if (open && runHistory.length > 0) setSelectedRunId(runHistory[0].runId);
    else if (!open) setSelectedRunId(null);
  }, [open]);

  const selected = runHistory.find((e) => e.runId === selectedRunId) || null;

  const [runRestore, restoring] = useAsyncAction(
    async () => {
      if (!selected) return null;
      return restorePipelineStageVersion(issueId, stageId, selected.runId, { silent: true });
    },
    { errorMessage: 'Restore failed' },
  );

  const handleRestore = async () => {
    if (!selected) return;
    const result = await runRestore();
    if (!result) return;
    onRestored?.(result.stage, result.issue);
    toast.success(`Restored ${PIPELINE_STAGE_LABELS[stageId] || stageId} to run ${selected.runId.slice(0, 8)}`);
    onClose?.();
  };

  return (
    <Modal open={open} onClose={onClose} size="3xl" ariaLabel="Stage version history">
      <div className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-port-border">
          <div className="flex items-center gap-2">
            <History size={16} className="text-port-accent" />
            <h2 className="text-base font-semibold text-white">
              {PIPELINE_STAGE_LABELS[stageId] || stageId} — Version History
            </h2>
            <span className="text-xs text-gray-500">
              {runHistory.length} prior version{runHistory.length === 1 ? '' : 's'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        {runHistory.length === 0 ? (
          <div className="p-6 text-sm text-gray-400 text-center">
            No prior versions yet — every regenerate of this stage will be snapshotted here.
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row min-h-0 flex-1">
            {/* Version list — left rail on desktop, top stack on mobile */}
            <div className="sm:w-56 sm:border-r border-b sm:border-b-0 border-port-border overflow-y-auto bg-port-bg/40">
              <ul className="divide-y divide-port-border">
                {runHistory.map((entry) => {
                  const isActive = entry.runId === selectedRunId;
                  return (
                    <li key={entry.runId}>
                      <button
                        type="button"
                        onClick={() => setSelectedRunId(entry.runId)}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-port-card transition-colors ${
                          isActive ? 'bg-port-card border-l-2 border-port-accent' : 'border-l-2 border-transparent'
                        }`}
                      >
                        <div className="font-mono text-gray-300">run {entry.runId.slice(0, 8)}</div>
                        <div className="text-gray-500 mt-0.5">
                          {entry.createdAt ? timeAgo(entry.createdAt) : 'unknown time'}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Diff pane */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex items-center justify-between px-4 py-2 border-b border-port-border bg-port-bg/40 gap-3">
                <div className="text-xs text-gray-500 min-w-0">
                  {selected ? (
                    <>
                      <span className="text-port-error">prior</span>
                      {' → '}
                      <span className="text-port-success">current{currentRunId ? ` (run ${currentRunId.slice(0, 8)})` : ''}</span>
                    </>
                  ) : 'Pick a version on the left to view the diff'}
                  {restoreBlockedReason ? (
                    <div className="mt-1 text-port-warning">{restoreBlockedReason}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={handleRestore}
                  disabled={!selected || restoring || !!restoreBlockedReason}
                  title={restoreBlockedReason || undefined}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80 disabled:opacity-40"
                >
                  {restoring ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  Restore this version
                </button>
              </div>
              <div className="flex-1 overflow-auto">
                {selected ? (
                  <InlineDiff oldText={selected.output} newText={currentOutput || ''} />
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
