import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Clapperboard, Loader2, Send } from 'lucide-react';
import toast from '../ui/Toast';
import {
  suggestWritersRoomCdBridge,
  sendWritersRoomCdBridge,
} from '../../services/apiWritersRoom';
import useMounted from '../../hooks/useMounted';
import LiveBudgetBadge from './LiveBudgetBadge';

// Both actions used to explain themselves only through `title`, which a touch
// screen never reveals (#3567). The sentence is the accessible name now — kept
// PREFIXED with the button's visible words so the two agree (WCAG 2.5.3 "Label
// in Name": a voice-control user must still be able to say "Propose treatment").
const PROPOSE_TEXT = 'Propose treatment';
const PROPOSE_HINT = 'Turns the prose at your cursor into a Creative Director treatment';
const PROPOSE_LABEL = `${PROPOSE_TEXT}: ${PROPOSE_HINT}`;
const SEND_TEXT = 'Send to Creative Director';
const SEND_HINT = 'Creates a new Creative Director project seeded with this treatment';
const SEND_LABEL = `${SEND_TEXT}: ${SEND_HINT}`;

// Phase 5 Creative Director bridge panel. While the work has live mode opted
// in, the writer can ask the Creative Director to turn the prose around the
// cursor into a short film treatment — a logline, synopsis, overall visual
// treatment (styleSpec), and 2–6 filmable scenes — then send it into a NEW
// Creative Director project. Unlike LiveContinuationPanel this owns NO debounce
// timer: proposing a treatment is a deliberate, heavier action behind an
// explicit button. It draws on the SAME daily call budget as the continuation
// panel (both are text LLM calls), so the readout reflects the shared counter.
export default function CdBridgePanel({ workId, liveMode, usage, onUsageChange, getCursorContext, onLinked }) {
  const navigate = useNavigate();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState(null);
  // `usage` is the SHARED live text-suggest counter, owned by WorkEditor and
  // passed in so this readout reflects budget the continuation panel spent too.
  // A fresh proposal response carries the new count, pushed up via onUsageChange.
  const mountedRef = useMounted();

  // Staleness guard for overlapping proposal requests — a second click while
  // the first is in flight tags a new generation and discards the older
  // response. Simpler than LiveContinuationPanel's rerun-queue because there's
  // no debounce firing behind the user's back.
  const genRef = useRef(0);
  const ctxGetterRef = useRef(getCursorContext);
  const workIdRef = useRef(workId);
  const onUsageChangeRef = useRef(onUsageChange);
  useEffect(() => { ctxGetterRef.current = getCursorContext; }, [getCursorContext]);
  useEffect(() => { workIdRef.current = workId; }, [workId]);
  useEffect(() => { onUsageChangeRef.current = onUsageChange; }, [onUsageChange]);

  const requestProposal = useCallback(async () => {
    const ctx = ctxGetterRef.current?.();
    if (!ctx || (!ctx.before?.trim() && !ctx.after?.trim() && !ctx.selection?.trim())) {
      setNotice('Place your cursor in some prose, then propose a treatment.');
      return;
    }
    const gen = ++genRef.current;
    setLoading(true);
    setNotice(null);
    setProposal(null);
    const res = await suggestWritersRoomCdBridge(workIdRef.current, ctx, { silent: true }).catch((err) => {
      if (mountedRef.current && gen === genRef.current) {
        if (err?.status === 429) setNotice('Daily suggestion budget reached — resets at UTC midnight.');
        else if (err?.status === 409) setNotice('Live mode is off for this work.');
        else toast.error(`Proposal failed: ${err.message}`);
      }
      return null;
    });
    if (!mountedRef.current || gen !== genRef.current) return;
    setLoading(false);
    if (!res) return;
    if (res.usage) onUsageChangeRef.current?.(res.usage);
    if (!res.proposal) {
      setNotice('No treatment this time — keep writing and try again.');
      return;
    }
    setProposal(res.proposal);
  }, [mountedRef]);

  const sendToCd = useCallback(async () => {
    if (!proposal || sending) return;
    setSending(true);
    const res = await sendWritersRoomCdBridge(workIdRef.current, proposal, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(`Send failed: ${err.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    setSending(false);
    if (!res?.project) return;
    onLinked?.(res.project.id);
    toast.success('Sent to Creative Director');
    navigate(`/creative-director/${encodeURIComponent(res.project.id)}/overview`);
  }, [proposal, sending, onLinked, navigate, mountedRef]);

  // When live mode flips off, clear any stale proposal so the panel doesn't
  // keep advertising a treatment against prose the writer has moved past.
  useEffect(() => {
    if (!liveMode?.enabled) {
      setProposal(null);
      setNotice(null);
    }
  }, [liveMode?.enabled]);

  if (!liveMode?.enabled) return null;

  const budget = liveMode?.dailyCallBudget ?? 0;
  const spent = usage?.count ?? 0;

  return (
    <div className="px-3 py-2 border-b border-port-border">
      <div className="flex items-center justify-between gap-x-2 gap-y-1 flex-wrap">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-port-accent">
          <Clapperboard size={12} /> CD Bridge
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <LiveBudgetBadge label="Suggestions (shared)" budget={budget} spent={spent} />
          {/* 44px tap target; -my-2 bleeds into the panel's own py-2 so the
              header doesn't grow taller than it already was. */}
          <button
            type="button"
            onClick={requestProposal}
            disabled={loading}
            className="flex items-center justify-center gap-1 min-h-[44px] px-2 -my-2 text-[10px] rounded bg-port-bg border border-port-border text-gray-300 hover:text-white disabled:opacity-50"
            title={PROPOSE_LABEL}
            aria-label={PROPOSE_LABEL}
          >
            {loading ? <Loader2 size={10} className="animate-spin" /> : <Clapperboard size={10} />}
            {PROPOSE_TEXT}
          </button>
        </div>
      </div>

      {notice && (
        <div className="mt-1.5 text-[10px] text-gray-400">{notice}</div>
      )}

      {!notice && !proposal && !loading && (
        <div className="mt-1 text-[10px] text-gray-500">
          Turn the prose around your cursor into a short film treatment — scenes + a visual look — and send it into Creative Director.
        </div>
      )}

      {proposal && (
        <div className="mt-2 space-y-2">
          {proposal.logline && (
            <div className="text-[11px] font-medium text-gray-200">{proposal.logline}</div>
          )}
          {proposal.synopsis && (
            <div className="text-[10px] text-gray-400 whitespace-pre-wrap">{proposal.synopsis}</div>
          )}
          {proposal.styleSpec && (
            <div className="rounded border border-port-border bg-port-bg/60 p-2">
              <div className="text-[9px] uppercase tracking-wide text-port-warning mb-0.5">Visual treatment</div>
              <div className="text-[10px] text-gray-400 whitespace-pre-wrap">{proposal.styleSpec}</div>
            </div>
          )}
          <div className="space-y-1.5">
            {(proposal.scenes || []).map((scene, i) => (
              <div key={i} className="rounded border border-port-border bg-port-card/60 p-2">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-[9px] uppercase tracking-wide text-port-accent">Scene {i + 1}</span>
                  <span className="text-[9px] text-gray-600">{scene.durationSeconds}s</span>
                </div>
                <div className="text-[11px] text-gray-300">{scene.intent}</div>
                <div className="text-[10px] text-gray-500 italic mt-0.5 whitespace-pre-wrap">{scene.prompt}</div>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-gray-500">{SEND_HINT}.</div>
          <button
            type="button"
            onClick={sendToCd}
            disabled={sending}
            className="flex items-center justify-center gap-1 min-h-[44px] px-3 text-[10px] rounded bg-port-accent/15 text-port-accent hover:bg-port-accent/25 disabled:opacity-50"
            title={SEND_LABEL}
            aria-label={SEND_LABEL}
          >
            {sending ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />}
            {SEND_TEXT}
          </button>
        </div>
      )}
    </div>
  );
}
