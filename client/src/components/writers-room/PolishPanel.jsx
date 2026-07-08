import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, StopCircle, RotateCcw, Check, X, ArrowRight, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import { useSseProgress, isTerminalSseFrame } from '../../hooks/useSseProgress';
import { timeAgo } from '../../utils/formatters';
import {
  startWritersRoomPolish,
  cancelWritersRoomPolish,
  getWritersRoomPolishStatus,
  listWritersRoomPolishSnapshots,
  revertWritersRoomPolishSnapshot,
} from '../../services/apiWritersRoom';

// Human-readable phase labels for the live progress line.
const PHASE_LABEL = {
  evaluate: 'Evaluating…',
  cuts: 'Cutting fat…',
  revise: 'Revising…',
  reevaluate: 'Re-evaluating…',
};

/**
 * Writers Room — autonomous Polish loop control (#2173). Runs the
 * cuts → revise → keep/revert cycle over the saved draft, streaming live
 * per-cycle progress, and surfaces the immutable body snapshots as revert
 * points. Explicit user trigger only (AI provider policy).
 *
 * Props:
 *   work        — the work manifest (needs .id)
 *   dirty       — true when the editor buffer has unsaved edits (polish runs on
 *                 the SAVED draft, so we gate Start on a clean buffer)
 *   onBodyChanged — async () => void; called after a completed run or a revert
 *                 so the editor reloads the server-mutated body
 */
export default function PolishPanel({ work, dirty, onBodyChanged }) {
  const mountedRef = useMounted();
  const [cycles, setCycles] = useState(1);
  const [sseUrl, setSseUrl] = useState(null);
  const [starting, setStarting] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [reverting, setReverting] = useState(null);

  const { frames, latest, closed } = useSseProgress(sseUrl, { enabled: !!sseUrl });
  const running = !!sseUrl && !closed;

  const refreshSnapshots = useCallback(async () => {
    const list = await listWritersRoomPolishSnapshots(work.id).catch(() => []);
    if (mountedRef.current) setSnapshots(list);
  }, [work.id, mountedRef]);

  // On mount / work switch: reset stream state and load existing snapshots. If a
  // run is already active on the server (e.g. this panel was reopened), re-attach.
  useEffect(() => {
    setSseUrl(null);
    setSnapshots([]);
    refreshSnapshots();
    getWritersRoomPolishStatus(work.id)
      .then((s) => { if (s?.active && mountedRef.current) setSseUrl(`/api/writers-room/works/${encodeURIComponent(work.id)}/polish/progress`); })
      .catch(() => {});
  }, [work.id, refreshSnapshots, mountedRef]);

  // When the stream closes on a terminal frame, refresh snapshots and pull the
  // server-mutated body back into the editor.
  useEffect(() => {
    if (!closed || !latest) return;
    refreshSnapshots();
    if (latest.type === 'complete') {
      const kept = (latest.reports || []).filter((r) => r.decision === 'keep').length;
      toast.success(`Polish complete — ${latest.cyclesRun} cycle${latest.cyclesRun === 1 ? '' : 's'}, ${kept} kept (score ${fmtScore(latest.finalScore)})`);
      onBodyChanged?.();
    } else if (latest.type === 'error') {
      toast.error(`Polish failed: ${latest.error || 'unknown error'}`);
    } else if (latest.type === 'canceled') {
      toast('Polish canceled', { icon: '🛑' });
      onBodyChanged?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed]);

  const start = async () => {
    if (running || starting) return;
    if (dirty) { toast.error('Save your draft first — polish runs on the saved version'); return; }
    setStarting(true);
    const res = await startWritersRoomPolish(work.id, { cycles }).catch((err) => {
      if (mountedRef.current) toast.error(`Could not start polish: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    setStarting(false);
    if (!res) return;
    if (res.alreadyRunning) toast('A polish run is already in progress', { icon: 'ℹ️' });
    setSseUrl(res.sseUrl || `/api/writers-room/works/${encodeURIComponent(work.id)}/polish/progress`);
  };

  const cancel = async () => {
    await cancelWritersRoomPolish(work.id).catch(() => {});
  };

  const revert = async (snapshotId) => {
    if (running) { toast.error('Wait for the current run to finish before reverting'); return; }
    setReverting(snapshotId);
    const ok = await revertWritersRoomPolishSnapshot(work.id, snapshotId).catch((err) => {
      if (mountedRef.current) toast.error(`Revert failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    setReverting(null);
    if (!ok) return;
    toast.success('Reverted to snapshot');
    onBodyChanged?.();
    refreshSnapshots();
  };

  // Derive display state from the frame stream.
  const baseline = useMemo(() => frames.find((f) => f.type === 'baseline'), [frames]);
  const cycleFrames = useMemo(() => frames.filter((f) => f.type === 'cycle'), [frames]);
  const activePhase = useMemo(() => {
    if (!running) return null;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      if (frames[i].type === 'phase') return frames[i];
      if (isTerminalSseFrame(frames[i])) return null;
    }
    return null;
  }, [frames, running]);

  return (
    <div className="space-y-4 text-sm">
      <p className="text-[12px] text-gray-400 leading-relaxed">
        The Polish loop runs an adversarial cut pass, applies the safe cuts, then
        rewrites against an editorial brief — keeping each revision only if it
        scores at least as well as before. Every cycle snapshots the body first,
        so you can always revert.
      </p>

      {/* Controls */}
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label htmlFor="polish-cycles" className="block text-[11px] text-gray-500 mb-1">Cycles</label>
          <select
            id="polish-cycles"
            value={cycles}
            disabled={running}
            onChange={(e) => setCycles(parseInt(e.target.value, 10))}
            className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm disabled:opacity-50"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </div>
        {running ? (
          <button
            onClick={cancel}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-error/90 text-white hover:bg-port-error text-sm"
          >
            <StopCircle size={14} /> Stop
          </button>
        ) : (
          <button
            onClick={start}
            disabled={starting || dirty}
            title={dirty ? 'Save your draft first — polish runs on the saved version' : 'Run the polish loop'}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm ${
              starting || dirty ? 'bg-port-bg text-gray-500' : 'bg-port-accent text-white hover:bg-port-accent/80'
            }`}
          >
            <Sparkles size={14} /> {starting ? 'Starting…' : 'Polish'}
          </button>
        )}
      </div>
      {dirty && !running && (
        <div className="text-[11px] text-port-warning">You have unsaved edits — polish runs on the saved draft.</div>
      )}

      {/* Live progress */}
      {(running || baseline) && (
        <div className="border border-port-border rounded p-3 space-y-2 bg-port-bg/40">
          <div className="flex items-center justify-between text-[11px]">
            <span className="uppercase tracking-wide text-gray-500">Progress</span>
            {activePhase && (
              <span className="flex items-center gap-1.5 text-port-accent">
                <Loader2 size={11} className="animate-spin" />
                {PHASE_LABEL[activePhase.phase] || activePhase.label || activePhase.phase}
                {activePhase.cycle > 0 && <span className="text-gray-500">· cycle {activePhase.cycle}</span>}
              </span>
            )}
          </div>
          {baseline && (
            <div className="text-[12px] text-gray-400">
              Baseline score <ScoreBadge value={baseline.score} /> · {baseline.wordCount?.toLocaleString()} words
            </div>
          )}
          <ul className="space-y-1.5">
            {cycleFrames.map((f) => (
              <li key={f.cycle} className="flex items-center gap-2 text-[12px]">
                <span className="text-gray-500 w-14 shrink-0">Cycle {f.cycle}</span>
                <ScoreBadge value={f.preScore} />
                <ArrowRight size={11} className="text-gray-600 shrink-0" />
                <ScoreBadge value={f.postScore} />
                {f.decision === 'keep' ? (
                  <span className="flex items-center gap-1 text-port-success text-[11px]"><Check size={11} /> kept</span>
                ) : (
                  <span className="flex items-center gap-1 text-gray-500 text-[11px]"><X size={11} /> reverted</span>
                )}
                <span className="text-gray-600 text-[10px] tabular-nums ml-auto">
                  {f.wordCountBefore?.toLocaleString()}→{f.wordCountAfter?.toLocaleString()}w · {f.cutsApplied} cut{f.cutsApplied === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
          {latest?.type === 'plateau' && (
            <div className="text-[11px] text-gray-500 italic">Converged (plateau) after cycle {latest.cycle}.</div>
          )}
        </div>
      )}

      {/* Snapshots / revert */}
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">
          Snapshots {snapshots.length > 0 && <span className="text-gray-600">({snapshots.length})</span>}
        </div>
        {snapshots.length === 0 && (
          <div className="text-[11px] text-gray-500 italic">No snapshots yet — run a polish cycle to create revert points.</div>
        )}
        <ul className="space-y-1">
          {snapshots.map((s) => (
            <li key={s.id} className="flex items-center gap-2 border border-port-border rounded px-2 py-1.5 text-[12px]">
              <span className="flex-1 truncate">
                {s.label || `Cycle ${s.cycle}`}
                {typeof s.qualityScore === 'number' && <span className="text-gray-500"> · <ScoreBadge value={s.qualityScore} inline /></span>}
              </span>
              <span className="text-gray-600 text-[10px] shrink-0">{s.wordCount?.toLocaleString()}w · {timeAgo(s.createdAt, '')}</span>
              <button
                onClick={() => revert(s.id)}
                disabled={running || reverting === s.id}
                title="Revert the draft to this snapshot"
                className="flex items-center gap-1 text-gray-400 hover:text-white disabled:opacity-40 text-[11px]"
              >
                <RotateCcw size={11} className={reverting === s.id ? 'animate-spin' : ''} /> Revert
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function fmtScore(v) {
  return typeof v === 'number' ? (Math.round(v * 10) / 10).toString() : '—';
}

function ScoreBadge({ value, inline }) {
  const label = fmtScore(value);
  if (inline) return <span className="tabular-nums">{label}</span>;
  return (
    <span className="px-1.5 py-0.5 rounded border border-port-border bg-port-card text-[11px] tabular-nums shrink-0">
      {label}
    </span>
  );
}
