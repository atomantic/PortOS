import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Loader2, RotateCcw, Ban, Check, X, ArrowRight } from 'lucide-react';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import { useSseProgress } from '../../hooks/useSseProgress';
import {
  startWritersRoomPolish,
  cancelWritersRoomPolish,
  getWritersRoomPolishStatus,
  getWritersRoomPolishHistory,
  revertWritersRoomPolish,
  getWritersRoomWork,
  writersRoomPolishSseUrl,
} from '../../services/apiWritersRoom';

const MAX_CYCLES = 3;

// A quality score (0..100, higher is better) → a token color. Null = not scored.
function scoreColor(score) {
  if (!Number.isFinite(score)) return 'text-gray-500';
  if (score >= 85) return 'text-port-success';
  if (score >= 65) return 'text-port-warning';
  return 'text-port-error';
}

function ScoreBadge({ score, label }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      {label && <span className="text-[9px] uppercase tracking-wider text-gray-500">{label}</span>}
      <span className={`text-xs font-semibold ${scoreColor(score)}`}>
        {Number.isFinite(score) ? Math.round(score) : '—'}
      </span>
    </span>
  );
}

// One-line human label for a live SSE frame.
function frameLabel(f) {
  switch (f?.type) {
    case 'start': return `Starting polish — ${f.cycles} cycle${f.cycles === 1 ? '' : 's'} (${f.wordCount} words)`;
    case 'baseline': return `Baseline evaluated — score ${Math.round(f.score ?? 0)}`;
    case 'cycle:start': return `Cycle ${f.cycle} — evaluating…`;
    case 'cycle:cuts': return `Cycle ${f.cycle} — applied ${f.applied} safe cut${f.applied === 1 ? '' : 's'} (${f.refused} refused)`;
    case 'cycle:revise': return `Cycle ${f.cycle} — revising…`;
    case 'cycle:complete': return `Cycle ${f.cycle} — ${f.kept ? 'kept' : 'reverted'} (${Math.round(f.beforeScore ?? 0)} → ${Math.round(f.afterScore ?? 0)})`;
    case 'complete': return `Polish complete — ${Math.round(f.baselineScore ?? 0)} → ${Math.round(f.finalScore ?? 0)}`;
    case 'canceled': return 'Polish canceled';
    case 'error': return `Polish failed — ${f.error || 'unknown error'}`;
    default: return f?.type || '';
  }
}

export default function PolishPanel({ work, dirty, onApplied }) {
  const mountedRef = useMounted();
  const [cycles, setCycles] = useState(1);
  const [polishing, setPolishing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [reverting, setReverting] = useState(null); // snapshotId currently reverting
  const [history, setHistory] = useState({ snapshots: [], runs: [] });

  const sseUrl = polishing ? writersRoomPolishSseUrl(work.id) : null;
  const { frames, latest, closed } = useSseProgress(sseUrl, { enabled: polishing });

  const loadHistory = useCallback(async () => {
    const h = await getWritersRoomPolishHistory(work.id, { silent: true }).catch(() => null);
    if (h && mountedRef.current) setHistory({ snapshots: h.snapshots || [], runs: h.runs || [] });
  }, [work.id, mountedRef]);

  // On mount: re-attach to an in-flight run (survives a drawer close/reopen or
  // reload) and load past-run history.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await getWritersRoomPolishStatus(work.id, { silent: true }).catch(() => null);
      if (!cancelled && status?.active && mountedRef.current) setPolishing(true);
    })();
    loadHistory();
    return () => { cancelled = true; };
  }, [work.id, loadHistory, mountedRef]);

  // Finalize when the stream closes (terminal frame OR connection drop). Refresh
  // the editor body (the server persisted any kept revision to the active draft)
  // and reload history.
  useEffect(() => {
    if (!closed || !polishing) return;
    setPolishing(false);
    const terminal = latest?.type;
    (async () => {
      if (terminal === 'complete' && latest?.changed) {
        const updated = await getWritersRoomWork(work.id).catch(() => null);
        if (updated && mountedRef.current) {
          onApplied?.(updated);
          toast.success(`Polish applied — score ${Math.round(latest.baselineScore ?? 0)} → ${Math.round(latest.finalScore ?? 0)}`);
        }
      } else if (terminal === 'complete') {
        toast('Polish finished — no improvement kept', { icon: '✨' });
      } else if (terminal === 'error') {
        toast.error(`Polish failed: ${latest?.error || 'unknown error'}`);
      }
      loadHistory();
    })();
  }, [closed, polishing, latest, work.id, onApplied, loadHistory, mountedRef]);

  const start = useCallback(async () => {
    if (dirty) {
      toast('Save or snapshot the draft before polishing', { icon: '⚠️' });
      return;
    }
    setStarting(true);
    const res = await startWritersRoomPolish(work.id, { cycles }, { silent: true })
      .catch((err) => { toast.error(`Could not start polish: ${err.message}`); return null; });
    if (!mountedRef.current) return;
    setStarting(false);
    if (res) setPolishing(true);
  }, [dirty, work.id, cycles, mountedRef]);

  const cancel = useCallback(async () => {
    await cancelWritersRoomPolish(work.id, { silent: true }).catch(() => {});
  }, [work.id]);

  const revert = useCallback(async (snapshotId) => {
    setReverting(snapshotId);
    const updated = await revertWritersRoomPolish(work.id, snapshotId, { silent: true })
      .catch((err) => { toast.error(`Revert failed: ${err.message}`); return null; });
    if (!mountedRef.current) return;
    setReverting(null);
    if (updated) {
      onApplied?.(updated);
      toast.success('Reverted to snapshot');
    }
  }, [work.id, onApplied, mountedRef]);

  // Live per-cycle rows assembled from the accumulated frames.
  const liveCycles = useMemo(
    () => frames.filter((f) => f.type === 'cycle:complete'),
    [frames],
  );
  const baselineFrame = useMemo(() => frames.find((f) => f.type === 'baseline'), [frames]);

  return (
    <div className="space-y-4 text-sm">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Polish runs an autonomous loop over the saved draft: evaluate → cut fat →
        revise → re-evaluate, keeping a pass only if it measurably improves the
        prose. Every state is snapshotted so you can revert. This uses your
        configured AI provider.
      </p>

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <label htmlFor="polish-cycles" className="text-[11px] text-gray-400">Cycles</label>
        <select
          id="polish-cycles"
          value={cycles}
          onChange={(e) => setCycles(Number(e.target.value))}
          disabled={polishing || starting}
          className="px-2 py-1 text-xs rounded bg-port-bg border border-port-border text-gray-200 disabled:opacity-50"
        >
          {Array.from({ length: MAX_CYCLES }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>

        {polishing ? (
          <button
            type="button"
            onClick={cancel}
            className="flex items-center gap-1 px-3 py-1 text-xs rounded bg-port-bg border border-port-error/40 text-port-error hover:bg-port-error/10"
          >
            <Ban size={12} /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={starting || dirty}
            title={dirty ? 'Save the draft first' : 'Start the polish loop'}
            className="flex items-center gap-1 px-3 py-1 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {starting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {starting ? 'Starting…' : 'Polish'}
          </button>
        )}
      </div>

      {dirty && !polishing && (
        <div className="px-2 py-1.5 text-[11px] border border-port-warning/40 bg-port-warning/5 text-port-warning rounded">
          Unsaved edits — save or snapshot before polishing (Polish works on the saved draft).
        </div>
      )}

      {/* Live progress */}
      {polishing && (
        <div className="border border-port-accent/40 bg-port-accent/5 rounded p-3 space-y-2">
          <div role="status" aria-live="polite" className="flex items-center gap-2 text-[12px] text-gray-200">
            <Loader2 size={14} className="animate-spin shrink-0" />
            <span>{latest ? frameLabel(latest) : 'Connecting…'}</span>
          </div>
          {baselineFrame && (
            <div className="text-[11px] text-gray-400">
              <ScoreBadge label="baseline" score={baselineFrame.score} />
            </div>
          )}
          {liveCycles.length > 0 && (
            <ul className="space-y-1">
              {liveCycles.map((c) => (
                <CycleRow key={c.cycle} cycle={c} />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Past runs */}
      {history.runs.length > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] uppercase tracking-wider text-gray-500">Recent runs</div>
          <ul className="space-y-2">
            {history.runs.slice(0, 5).map((run) => (
              <li key={run.id} className="border border-port-border rounded p-2 space-y-1">
                <div className="flex items-center justify-between text-[11px] text-gray-300">
                  <span className="flex items-center gap-1">
                    <ScoreBadge score={run.baselineScore} />
                    <ArrowRight size={11} className="text-gray-600" />
                    <ScoreBadge score={run.finalScore} />
                  </span>
                  <span className="text-[10px] text-gray-500">
                    {run.status === 'canceled' ? 'canceled' : `${run.keptCycles}/${run.requestedCycles} kept`}
                  </span>
                </div>
                {Array.isArray(run.cycles) && run.cycles.length > 0 && (
                  <ul className="space-y-0.5">
                    {run.cycles.map((c) => <CycleRow key={c.cycle} cycle={c} compact />)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Snapshots — revert control */}
      {history.snapshots.length > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] uppercase tracking-wider text-gray-500">Snapshots (revert)</div>
          <ul className="space-y-1">
            {history.snapshots.slice(0, 12).map((snap) => (
              <li key={snap.id} className="flex items-center justify-between gap-2 border border-port-border rounded px-2 py-1">
                <span className="flex items-center gap-2 min-w-0">
                  <ScoreBadge score={snap.score} />
                  <span className="text-[11px] text-gray-300 truncate">{snap.label || 'Snapshot'}</span>
                  <span className="text-[10px] text-gray-600 shrink-0">{snap.wordCount} words</span>
                </span>
                <button
                  type="button"
                  onClick={() => revert(snap.id)}
                  disabled={reverting != null || polishing}
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-port-bg border border-port-border text-gray-300 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  title="Restore this body into the active draft"
                >
                  {reverting === snap.id ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                  Revert
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CycleRow({ cycle, compact = false }) {
  return (
    <li className={`flex items-center gap-2 ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
      {cycle.kept
        ? <Check size={compact ? 10 : 12} className="text-port-success shrink-0" />
        : <X size={compact ? 10 : 12} className="text-gray-500 shrink-0" />}
      <span className="text-gray-400">Cycle {cycle.cycle}</span>
      <span className="flex items-center gap-1">
        <ScoreBadge score={cycle.beforeScore} />
        <ArrowRight size={compact ? 9 : 11} className="text-gray-600" />
        <ScoreBadge score={cycle.afterScore} />
      </span>
      <span className={cycle.kept ? 'text-port-success text-[10px]' : 'text-gray-500 text-[10px]'}>
        {cycle.kept ? 'kept' : 'reverted'}
      </span>
    </li>
  );
}
