import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2, Plus } from 'lucide-react';
import toast from '../ui/Toast';
import { suggestWritersRoomContinuation } from '../../services/apiWritersRoom';
import useMounted from '../../hooks/useMounted';

const KIND_LABEL = { beat: 'Beat', prose: 'Prose', dialogue: 'Dialogue' };
const KIND_TONE = {
  beat: 'text-port-accent border-port-accent/40',
  prose: 'text-port-success border-port-success/40',
  dialogue: 'text-port-warning border-port-warning/40',
};

// Phase 5 live Creative Director panel. While the work has live mode opted in,
// the editor calls `requestSuggest` on a debounce after the writer pauses; this
// panel renders the returned options and lets the writer insert one at the
// cursor. It owns NO timers itself — the debounce + cursor-context capture live
// in WorkEditor (which holds the textarea ref). It's a pure presentation +
// fetch shell driven by an imperative trigger passed up via `registerTrigger`.
export default function LiveContinuationPanel({
  workId,
  liveMode,
  getCursorContext,
  onInsert,
  registerTrigger,
}) {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  // Local usage so a fresh suggest updates the "N left today" readout
  // immediately (the response carries the new count, which we don't push up to
  // the parent's work manifest). Re-synced from the prop below so a
  // parent-driven liveMode change (budget edit, work swap) isn't shadowed.
  const [usage, setUsage] = useState(liveMode?.usage || null);
  useEffect(() => { setUsage(liveMode?.usage || null); }, [liveMode?.usage]);
  const [notice, setNotice] = useState(null);
  const mountedRef = useMounted();
  // Overlapping-call control. A fast typist can re-trigger the debounce before
  // the first response lands; rather than dropping the newer request and then
  // applying the OLDER (now-stale) response against a moved cursor, we:
  //   - tag every request with a monotonic generation and ignore a response
  //     whose generation is no longer current (staleness guard), and
  //   - remember that a re-run was requested mid-flight and fire it once the
  //     current call settles, so the latest cursor context always wins.
  const inFlightRef = useRef(false);
  const genRef = useRef(0);
  const rerunPendingRef = useRef(false);
  // Always read the LATEST cursor-context getter (and workId) through refs. A
  // queued rerun is invoked from inside the settled call's closure, so reading
  // `getCursorContext` directly would re-run against the prose that call
  // captured — stale by exactly the mid-flight edit we're trying to catch up
  // to. Refs keep `requestSuggest` identity-stable AND current.
  const ctxGetterRef = useRef(getCursorContext);
  const workIdRef = useRef(workId);
  useEffect(() => { ctxGetterRef.current = getCursorContext; }, [getCursorContext]);
  useEffect(() => { workIdRef.current = workId; }, [workId]);

  const requestSuggest = useCallback(async () => {
    if (inFlightRef.current) { rerunPendingRef.current = true; return; }
    const ctx = ctxGetterRef.current?.();
    if (!ctx || (!ctx.before?.trim() && !ctx.after?.trim() && !ctx.selection?.trim())) {
      // Nothing to ask about — make sure a spinner left over from a queued
      // rerun doesn't get stuck on.
      setLoading(false);
      return;
    }
    const gen = ++genRef.current;
    inFlightRef.current = true;
    setLoading(true);
    setNotice(null);
    // Drop stale options up front — a new request against a moved cursor must
    // not leave the previous suggestions visible/insertable while it runs.
    setOptions([]);
    const res = await suggestWritersRoomContinuation(workIdRef.current, ctx, { silent: true }).catch((err) => {
      // 429 budget / 409 off are expected control-flow, not crashes — show them
      // inline rather than as a red toast.
      if (mountedRef.current && gen === genRef.current) {
        if (err?.status === 429) setNotice('Daily suggestion budget reached — resets at UTC midnight.');
        else if (err?.status === 409) setNotice('Live mode is off for this work.');
        else toast.error(`Suggestion failed: ${err.message}`);
      }
      return null;
    });
    inFlightRef.current = false;
    // A newer request arrived while this one was in flight — discard this
    // (stale) result and re-run with the latest cursor context (read fresh
    // from the ref, not this closure's captured getter).
    const superseded = gen !== genRef.current || rerunPendingRef.current;
    if (rerunPendingRef.current) {
      rerunPendingRef.current = false;
      if (mountedRef.current) requestSuggest();
    }
    if (!mountedRef.current || superseded) return;
    setLoading(false);
    if (!res) return;
    setOptions(res.options || []);
    if (res.usage) setUsage(res.usage);
    if ((res.options || []).length === 0) setNotice('No suggestions this time — keep writing and pause again.');
  }, [mountedRef]);

  // Expose the imperative trigger to the parent so its debounce timer can fire
  // a suggest without this component owning the cursor/textarea.
  useEffect(() => {
    registerTrigger?.(requestSuggest);
    return () => registerTrigger?.(null);
  }, [registerTrigger, requestSuggest]);

  // When live mode flips off, clear any stale suggestions so the panel doesn't
  // keep advertising stale options against prose the writer has moved past.
  useEffect(() => {
    if (!liveMode?.enabled) {
      setOptions([]);
      setNotice(null);
    }
  }, [liveMode?.enabled]);

  const budget = liveMode?.dailyCallBudget ?? 0;
  const spent = usage?.count ?? 0;
  const remainingLabel = budget > 0 ? `${Math.max(0, budget - spent)} / ${budget} left today` : 'unlimited';

  if (!liveMode?.enabled) {
    return (
      <div className="p-3 text-[11px] text-gray-500 italic">
        Live mode is off. Enable it from the work menu to get continuation suggestions as you pause.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-port-border">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-port-accent">
          <Sparkles size={12} /> Live Director
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500" title="Daily suggestion budget">{remainingLabel}</span>
          <button
            type="button"
            onClick={requestSuggest}
            disabled={loading}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-port-bg border border-port-border text-gray-300 hover:text-white disabled:opacity-50"
            title="Suggest a continuation from the cursor"
          >
            {loading ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
            Suggest
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {notice && (
          <div className="px-2 py-1.5 text-[11px] text-gray-400 bg-port-bg/60 border border-port-border rounded">
            {notice}
          </div>
        )}
        {!notice && options.length === 0 && !loading && (
          <div className="px-2 py-3 text-[11px] text-gray-500 italic">
            Pause while writing (or click Suggest) and the Creative Director will offer a few ways to continue from the cursor.
          </div>
        )}
        {options.map((opt, i) => (
          <div
            key={i}
            className="rounded border border-port-border bg-port-card/60 p-2 hover:border-port-accent/40 transition-colors"
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className={`px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wide ${KIND_TONE[opt.kind] || KIND_TONE.beat}`}>
                {KIND_LABEL[opt.kind] || 'Beat'}
              </span>
              {(opt.kind === 'prose' || opt.kind === 'dialogue') && (
                <button
                  type="button"
                  onClick={() => onInsert?.(opt)}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-port-accent/15 text-port-accent hover:bg-port-accent/25"
                  title="Insert at cursor"
                >
                  <Plus size={10} /> Insert
                </button>
              )}
            </div>
            {opt.label && <div className="text-[11px] font-medium text-gray-200">{opt.label}</div>}
            <div className="text-[11px] text-gray-400 whitespace-pre-wrap mt-0.5">{opt.text}</div>
            {opt.rationale && (
              <div className="text-[10px] text-gray-600 italic mt-1">{opt.rationale}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
