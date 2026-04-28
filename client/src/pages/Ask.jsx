import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Send, Loader2, MessageCircle, Trash2, Pin, Brain, Calendar, Target, BookOpen, FileText, ExternalLink, ListTodo, CheckCircle2 } from 'lucide-react';
import * as api from '../services/api';
import toast from '../components/ui/Toast';

// Mirrors the server-side ID_RE in askConversations.js (9-char base36 ms +
// 8-char hex suffix) so this regex stays in lockstep with the production
// generator. Used to skip forwarding the optimistic 'pending' placeholder
// (which would 400) while still letting any real persisted id pass through.
const CONV_ID_RE = /^ask_[a-z0-9]{9}_[a-f0-9]{8}$/;

export const ASK_MODES = [
  { id: 'ask', label: 'Ask', help: 'Answer as yourself, grounded in your own notes and goals.' },
  { id: 'advise', label: 'Advise', help: 'Coach you using your goals and constraints — push back where they conflict.' },
  { id: 'draft', label: 'Draft', help: 'Produce text in your voice for the recipient/platform you specify.' },
];

const KIND_META = {
  memory: { icon: Brain, label: 'Memory', tone: 'text-purple-400' },
  'brain-note': { icon: FileText, label: 'Brain note', tone: 'text-blue-400' },
  autobiography: { icon: BookOpen, label: 'Autobiography', tone: 'text-amber-400' },
  goal: { icon: Target, label: 'Goal', tone: 'text-emerald-400' },
  calendar: { icon: Calendar, label: 'Calendar', tone: 'text-cyan-400' },
};

function SourceChip({ source, index }) {
  const meta = KIND_META[source.kind] || { icon: FileText, label: source.kind, tone: 'text-gray-400' };
  const Icon = meta.icon;
  const navigate = useNavigate();
  const onClick = () => {
    if (source.href?.startsWith('/')) navigate(source.href);
    else if (source.href) window.open(source.href, '_blank', 'noopener,noreferrer');
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={source.snippet || source.title}
      className="inline-flex items-center gap-1.5 max-w-[260px] truncate px-2 py-1 rounded-md bg-port-bg border border-port-border hover:border-port-accent/60 transition-colors text-xs"
    >
      <span className="text-gray-500">[{index + 1}]</span>
      <Icon size={12} className={meta.tone} />
      <span className="truncate">{source.title}</span>
      {source.href && <ExternalLink size={10} className="text-gray-500 shrink-0" />}
    </button>
  );
}

function Sidebar({ conversations, activeId, onPick, onNew, onDelete, loading, streaming }) {
  return (
    <aside className="w-full md:w-64 md:shrink-0 border-r border-port-border bg-port-card md:h-full md:overflow-y-auto">
      <div className="p-3 border-b border-port-border flex items-center gap-2">
        <button
          onClick={onNew}
          disabled={streaming}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-port-accent/15 text-port-accent hover:bg-port-accent/25 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <MessageCircle size={14} /> New conversation
        </button>
      </div>
      <div className="py-1">
        {loading && <div className="p-3 text-xs text-gray-500">Loading…</div>}
        {!loading && conversations.length === 0 && (
          <div className="p-3 text-xs text-gray-500">No conversations yet. Ask yourself something.</div>
        )}
        {conversations.map((c) => {
          // Lock conversation switching while a stream is in flight on a
          // different conversation — switching mid-stream would race the
          // assistant turn into the wrong local state and URL.
          const lockedSwitch = streaming && c.id !== activeId;
          return (
            <div
              key={c.id}
              className={`group relative flex items-center justify-between gap-2 ${c.id === activeId ? 'bg-port-border/40' : ''}`}
            >
              <button
                type="button"
                disabled={lockedSwitch}
                aria-current={c.id === activeId ? 'page' : undefined}
                onClick={() => onPick(c.id)}
                title={lockedSwitch ? 'Wait for the current answer to finish' : c.title}
                className={`flex-1 min-w-0 text-left px-3 py-2 hover:bg-port-border/30 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent focus:outline-none focus-visible:ring-1 focus-visible:ring-port-accent`}
              >
                <div className="text-sm truncate">{c.title}</div>
                <div className="text-xs text-gray-500 flex items-center gap-1.5">
                  <span>{c.mode}</span>
                  <span>·</span>
                  <span>{c.turnCount} turns</span>
                  {c.promoted && <Pin size={10} className="text-amber-400" />}
                </div>
              </button>
              <button
                type="button"
                onClick={() => onDelete(c.id)}
                className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-gray-500 hover:text-port-error transition-opacity"
                aria-label={`Delete conversation: ${c.title}`}
                title="Delete conversation"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// Promotion bar for assistant turns: 1-click save to Brain inbox, create a
// CoS task, or attach a progress note to a Goal. Local state tracks which
// targets have already been promoted so the UI doesn't let the user fire the
// same promotion twice (and so the success label persists across re-renders).
function PromoteBar({ conversationId, turn, goals, onPromoted }) {
  const [pending, setPending] = useState(null);
  const [saved, setSaved] = useState({ brain: null, task: null, goal: null });
  const [pickingGoal, setPickingGoal] = useState(false);

  const promote = useCallback(async (payload) => {
    setPending(payload.target);
    const data = await api.promoteAskTurn(conversationId, turn.id, payload).catch((err) => {
      toast.error(err?.message || 'Promote failed');
      return null;
    });
    setPending(null);
    if (!data?.ok) return;
    setSaved((prev) => ({ ...prev, [payload.target]: data.ref }));
    setPickingGoal(false);
    onPromoted?.(data);
    if (payload.target === 'brain') toast.success('Saved to Brain inbox');
    else if (payload.target === 'task') toast.success('Created CoS task');
    else if (payload.target === 'goal') toast.success('Attached to goal');
  }, [conversationId, turn.id, onPromoted]);

  // Pin saved state once goals are loaded so a goal-target chip can label
  // "Attached to <goal title>" instead of just "Attached".
  const savedGoal = saved.goal && goals?.find((g) => g.id === saved.goal.id);

  return (
    <div className="mt-3 pt-3 border-t border-port-border flex flex-wrap items-center gap-1.5">
      <PromoteButton
        label="Save to Brain"
        savedLabel="Saved to Brain"
        icon={Brain}
        savedRef={saved.brain}
        pending={pending === 'brain'}
        disabled={!!pending}
        onClick={() => promote({ target: 'brain' })}
        href={saved.brain ? '/brain/inbox' : null}
      />
      <PromoteButton
        label="Create task"
        savedLabel="Task created"
        icon={ListTodo}
        savedRef={saved.task}
        pending={pending === 'task'}
        disabled={!!pending}
        onClick={() => promote({ target: 'task' })}
        href={saved.task ? '/cos' : null}
      />
      {saved.goal ? (
        <PromoteButton
          label="Attach to goal"
          savedLabel={savedGoal ? `Attached: ${savedGoal.title}` : 'Attached to goal'}
          icon={Target}
          savedRef={saved.goal}
          pending={false}
          disabled
          onClick={() => {}}
          href={`/digital-twin/goals?id=${encodeURIComponent(saved.goal.id)}`}
        />
      ) : (
        <GoalPicker
          goals={goals}
          pending={pending === 'goal'}
          disabled={!!pending}
          open={pickingGoal}
          onToggle={() => setPickingGoal((v) => !v)}
          onPick={(goalId) => promote({ target: 'goal', goalId })}
        />
      )}
    </div>
  );
}

function PromoteButton({ label, savedLabel, icon: Icon, savedRef, pending, disabled, onClick, href }) {
  const navigate = useNavigate();
  const isSaved = !!savedRef;
  const text = isSaved ? savedLabel : label;
  const cls = `inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors border ${
    isSaved
      ? 'bg-port-success/15 border-port-success/40 text-port-success hover:bg-port-success/20'
      : 'bg-port-bg border-port-border text-gray-300 hover:border-port-accent/60 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed'
  }`;
  const handleClick = () => {
    if (isSaved && href) navigate(href);
    else if (!disabled && !isSaved) onClick();
  };
  return (
    <button type="button" onClick={handleClick} disabled={disabled && !isSaved} className={cls} title={text}>
      {pending ? <Loader2 size={12} className="animate-spin" /> : isSaved ? <CheckCircle2 size={12} /> : <Icon size={12} />}
      <span className="truncate max-w-[200px]">{text}</span>
    </button>
  );
}

function GoalPicker({ goals, pending, disabled, open, onToggle, onPick }) {
  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-port-bg border border-port-border text-gray-300 hover:border-port-accent/60 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? <Loader2 size={12} className="animate-spin" /> : <Target size={12} />}
        <span>Attach to goal…</span>
      </button>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5">
      <select
        defaultValue=""
        onChange={(e) => {
          const id = e.target.value;
          if (id) onPick(id);
        }}
        disabled={pending}
        className="px-2 py-1 rounded-md text-xs bg-port-bg border border-port-border text-gray-300 focus:outline-none focus:border-port-accent/60"
      >
        <option value="" disabled>Pick a goal…</option>
        {(goals || []).map((g) => (
          <option key={g.id} value={g.id}>{g.title}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={onToggle}
        className="text-xs text-gray-500 hover:text-white"
        aria-label="Cancel goal picker"
      >
        Cancel
      </button>
    </div>
  );
}

// Memoized so previously-rendered turns don't re-render on every streaming
// delta — only the actively-streaming Turn at the bottom flips on each chunk.
const Turn = memo(function Turn({ turn, sources, conversationId, goals, canPromote, onPromoted }) {
  const isUser = turn.role === 'user';
  const turnSources = turn.sources || sources || [];
  // Local-only partial turns (set when a stream errors mid-flight) carry no
  // server-side id, so promotion would 404 — gate the bar on a real persisted
  // id rather than hide it for every assistant turn.
  const showPromote = !isUser && canPromote && turn.content && turn.id && !String(turn.id).startsWith('partial-') && !String(turn.id).startsWith('streaming') && !String(turn.id).startsWith('optimistic-');
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-lg px-4 py-3 ${isUser ? 'bg-port-accent/15 border border-port-accent/30' : 'bg-port-card border border-port-border'}`}>
        <div className="text-sm whitespace-pre-wrap break-words">{turn.content || (isUser ? '' : <span className="text-gray-500"><Loader2 size={14} className="inline animate-spin mr-1" />thinking…</span>)}</div>
        {!isUser && turnSources.length > 0 && (
          <div className="mt-3 pt-3 border-t border-port-border flex flex-wrap gap-1.5">
            {turnSources.map((s, i) => <SourceChip key={s.id} source={s} index={i} />)}
          </div>
        )}
        {showPromote && (
          <PromoteBar conversationId={conversationId} turn={turn} goals={goals} onPromoted={onPromoted} />
        )}
      </div>
    </div>
  );
});

export default function Ask() {
  const { conversationId } = useParams();
  const navigate = useNavigate();

  const [conversations, setConversations] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [activeConv, setActiveConv] = useState(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [goals, setGoals] = useState([]);
  // streamingTurn === null means "not streaming". Storing the partial content
  // and sources in a single object is enough to drive both the UI and the
  // disabled-while-streaming guards.
  const [streamingTurn, setStreamingTurn] = useState(null);
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState('ask');
  const abortRef = useRef(null);
  // The conversationId the in-flight stream belongs to — null when nothing
  // is streaming. Used by the conversationId-change effect to decide whether
  // a route change is "switching away from a stream" (abort) vs. "the stream
  // just told us its id and we're navigating to it" (keep).
  const streamingConvIdRef = useRef(null);
  const scrollRef = useRef(null);
  const streaming = streamingTurn !== null;

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    const data = await api.listAskConversations().catch(() => null);
    setLoadingList(false);
    if (data?.conversations) setConversations(data.conversations);
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

  // Goals load lazily and only need a flat list for the picker dropdown — no
  // need to refetch on every conversation change. A failure leaves the
  // picker empty (the user just won't see options) so we don't toast here.
  useEffect(() => {
    let cancelled = false;
    api.getGoals().then((data) => {
      if (cancelled) return;
      const list = Array.isArray(data?.goals) ? data.goals : [];
      // Pre-sort so the dropdown is alphabetical without forcing PromoteBar
      // to sort on every render.
      const sorted = [...list].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      setGoals(sorted);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Fired by PromoteBar after a successful promotion: the server already pins
  // the conversation, so reflect that locally without a refetch.
  const handlePromoted = useCallback((data) => {
    if (data?.conversation) {
      setActiveConv((prev) => prev ? { ...prev, promoted: !!data.conversation.promoted } : prev);
      setConversations((prev) => prev.map((c) => c.id === data.conversation.id
        ? { ...c, promoted: !!data.conversation.promoted }
        : c));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!conversationId) {
      setActiveConv(null);
      return undefined;
    }
    setLoadingConv(true);
    api.getAskConversation(conversationId).then((data) => {
      if (cancelled) return;
      if (data?.conversation) {
        setActiveConv(data.conversation);
        // Mode is per-turn (each turn carries the mode it was sent with);
        // initialise the UI to whatever the last turn used so a refresh
        // restores the user's most-recent mode rather than the
        // conversation's original creation mode.
        const turns = data.conversation.turns || [];
        const lastModeTurn = [...turns].reverse().find((t) => t.mode);
        setMode(lastModeTurn?.mode || data.conversation.mode || 'ask');
      } else {
        setActiveConv(null);
      }
    }).catch(() => {
      if (!cancelled) setActiveConv(null);
    }).finally(() => {
      if (!cancelled) setLoadingConv(false);
    });
    return () => { cancelled = true; };
  }, [conversationId]);

  // Auto-scroll the transcript to the bottom on new turns / streaming deltas.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeConv?.turns?.length, streamingTurn?.content]);

  // Abort the in-flight stream only when the user navigates *away* from the
  // conversation it belongs to. Brand-new conversations transition through
  // `/ask` → `/ask/<id>` once the server's `open` event arrives — that
  // self-navigation must NOT cancel the stream, so we compare against the
  // ref the stream populates. Covers the `/ask/<id>` → `/ask` case too:
  // `conversationId` becomes undefined and `streamingConvIdRef` is still
  // set, so the inequality fires and we abort.
  useEffect(() => {
    const streamConvId = streamingConvIdRef.current;
    if (streamConvId && streamConvId !== conversationId) {
      abortRef.current?.abort();
      abortRef.current = null;
      streamingConvIdRef.current = null;
    }
  }, [conversationId]);

  // Separately, kill any in-flight stream on real unmount so we don't leak
  // a fetch + state-update closure into a torn-down tree. `mountedRef` is
  // checked from `handleSend`'s post-stream cleanup so it can skip state
  // writes if we get there after unmount.
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingConvIdRef.current = null;
  }, []);

  const startNew = useCallback(() => {
    if (streaming) return;
    navigate('/ask');
    setActiveConv(null);
    setQuestion('');
  }, [navigate, streaming]);

  // Two-step delete: first click arms the row (toast confirms), second click
  // (within 4s) actually deletes. Per CLAUDE.md "no window.confirm".
  const pendingDeleteRef = useRef({ id: null, expiresAt: 0 });
  const handleDelete = useCallback(async (id) => {
    if (streaming && id === activeConv?.id) return;
    const pending = pendingDeleteRef.current;
    if (pending.id !== id || Date.now() > pending.expiresAt) {
      pendingDeleteRef.current = { id, expiresAt: Date.now() + 4000 };
      toast('Click delete again to confirm', { icon: '⚠️' });
      return;
    }
    pendingDeleteRef.current = { id: null, expiresAt: 0 };
    // Only mutate local state if the server confirms the delete — otherwise
    // a transient failure would hide a row that's still on disk and would
    // pop back on the next list refresh.
    const ok = await api.deleteAskConversation(id).then(() => true, (err) => {
      toast.error(err?.message || 'Failed to delete conversation');
      return false;
    });
    if (!ok) return;
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === conversationId) navigate('/ask');
  }, [activeConv?.id, conversationId, navigate, streaming]);

  const handlePromote = useCallback(async () => {
    if (!activeConv) return;
    const next = !activeConv.promoted;
    const data = await api.promoteAskConversation(activeConv.id, next).catch(() => null);
    if (data?.conversation) {
      setActiveConv(data.conversation);
      setConversations((prev) => prev.map((c) => c.id === activeConv.id ? { ...c, promoted: next } : c));
    }
  }, [activeConv]);

  const handleSend = useCallback(async (e) => {
    e?.preventDefault?.();
    const trimmed = question.trim();
    if (!trimmed || streaming) return;
    setQuestion('');
    setStreamingTurn({ content: '', sources: [] });
    const controller = new AbortController();
    abortRef.current = controller;
    // Seed streamingConvIdRef with whatever conversation we're sending into;
    // for brand-new conversations this is null until the `open` event lands.
    streamingConvIdRef.current = activeConv?.id && activeConv.id !== 'pending' ? activeConv.id : null;

    // Optimistic user turn so the UI doesn't sit blank between submit and
    // the first SSE 'open' event (gather-sources + provider connect = 100s
    // of ms).
    const nowIso = new Date().toISOString();
    const optimisticUserTurn = { id: `optimistic-${Date.now()}`, role: 'user', content: trimmed, createdAt: nowIso };
    setActiveConv((prev) => prev
      ? { ...prev, turns: [...(prev.turns || []), optimisticUserTurn] }
      : { id: 'pending', title: trimmed.slice(0, 80), mode, turns: [optimisticUserTurn], createdAt: nowIso, updatedAt: nowIso },
    );

    // Only forward conversationId when it's a real persisted id. The
    // optimistic 'pending' placeholder (set when sending in a fresh
    // conversation) would fail server-side regex validation as a 400; in that
    // case we omit the field so the server creates a new conversation.
    const persistedConvId = activeConv?.id && CONV_ID_RE.test(activeConv.id) ? activeConv.id : undefined;
    let serverConvId = persistedConvId;
    let collectedSources = [];
    // Accumulate deltas into an array; concat-on-state would be O(n²) since
    // each render also pays the React diff for an ever-growing string. We
    // join() only when flushing to state, and we batch state flushes with
    // requestAnimationFrame so the render rate is bounded by the display
    // refresh, not by the SSE delta rate.
    const chunks = [];
    let pendingFrame = 0;
    const flushStreamingTurn = () => {
      pendingFrame = 0;
      setStreamingTurn({ content: chunks.join(''), sources: collectedSources });
    };
    let persistedTurn = null;
    // Tracks whether the SSE stream actually opened — until the first 'open'
    // event lands, the optimistic state isn't backed by a server record. A
    // network/4xx failure before then must roll back local state so a refresh
    // doesn't ghost a turn that was never persisted.
    let streamOpened = false;
    let streamFailure = null;
    // Captures the message from any in-stream `event: error` frame so we can
    // preserve partial assistant text + flag the failure on the local turn
    // when the server bails after streaming some deltas (provider 5xx, etc.).
    let sseErrorMessage = null;

    await api.streamAskTurn(
      { conversationId: persistedConvId, question: trimmed, mode },
      {
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          // Drop events that arrive after the user navigated away / aborted —
          // otherwise we'd write into a stale conversation's local state.
          if (controller.signal.aborted) return;
          if (event === 'open') {
            streamOpened = true;
            serverConvId = data.conversationId;
            // Pin the stream to its conversation id so the navigate() below
            // (which fires on first send) doesn't get treated as a
            // switch-away by the conversationId-change effect.
            streamingConvIdRef.current = data.conversationId;
            if (!activeConv?.id || activeConv.id === 'pending') {
              navigate(`/ask/${data.conversationId}`, { replace: true });
            }
          } else if (event === 'sources') {
            collectedSources = data.sources || [];
            if (!pendingFrame) pendingFrame = requestAnimationFrame(flushStreamingTurn);
          } else if (event === 'delta') {
            if (data.text) chunks.push(data.text);
            if (!pendingFrame) pendingFrame = requestAnimationFrame(flushStreamingTurn);
          } else if (event === 'done') {
            persistedTurn = data.turn || null;
          } else if (event === 'error') {
            sseErrorMessage = data.error || 'Stream error';
            toast.error(sseErrorMessage);
          }
        },
      },
    ).catch((err) => {
      if (err.name !== 'AbortError') {
        streamFailure = err;
        toast.error(err.message || 'Ask failed');
      }
    });

    // Cancel any rAF queued after the last delta so a flush can't race with
    // the cleanup `setStreamingTurn(null)` below.
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }

    const wasAborted = controller.signal.aborted;
    // Bail early if the component unmounted — calling setState on an
    // unmounted tree is what we're trying to avoid here. Aborts that come
    // from in-component navigation (still mounted) keep cleaning up so the
    // streaming UI clears when the user returns to this conversation.
    if (!mountedRef.current) return;

    setStreamingTurn(null);
    if (abortRef.current === controller) abortRef.current = null;
    streamingConvIdRef.current = null;

    // Skip the post-stream business logic (rollback / append) if the abort
    // was caused by navigation — those updates would land in a stale
    // conversation that the user is no longer looking at.
    if (wasAborted) return;

    // If the stream failed before the server even acknowledged it (network
    // error, 4xx, transport hiccup), roll back the optimistic state — the
    // user turn was never persisted, so leaving it in local state would
    // ghost it on refresh / cause a duplicate when the user retries.
    if (streamFailure && !streamOpened) {
      setActiveConv((prev) => {
        if (!prev) return prev;
        // Brand-new 'pending' conversation: drop the whole conversation so
        // the empty state returns; the user can retry without artifacts.
        if (prev.id === 'pending') return null;
        // Existing conversation: pop just the optimistic user turn.
        const turns = (prev.turns || []).filter((t) => t.id !== optimisticUserTurn.id);
        return { ...prev, turns };
      });
      // Restore the question so the user can retry without re-typing.
      setQuestion(trimmed);
      return;
    }

    // Append the persisted assistant turn locally rather than refetching the
    // whole conversation — server returned the canonical record in 'done'.
    // Guard against double-append: the URL-change effect may have already
    // GET'd the conversation after the server persisted the turn, so the
    // turn id can already be present in `prev.turns`.
    if (persistedTurn && serverConvId) {
      setActiveConv((prev) => {
        if (!prev || (prev.id !== 'pending' && prev.id !== serverConvId)) return prev;
        const existingTurns = prev.turns || [];
        if (existingTurns.some((t) => t.id === persistedTurn.id)) {
          return prev.id === serverConvId ? prev : { ...prev, id: serverConvId };
        }
        return { ...prev, id: serverConvId, turns: [...existingTurns, persistedTurn], updatedAt: persistedTurn.createdAt };
      });
    } else if (sseErrorMessage && chunks.length && serverConvId) {
      // Provider/server bailed mid-stream after we already received content.
      // Preserve the partial answer as a local-only assistant turn (no
      // `persistedTurn` from the server) so the user can still read/copy
      // what arrived. Tag with `error` so a future render can style it.
      const partialContent = chunks.join('');
      const partialTurn = {
        id: `partial-${Date.now()}`,
        role: 'assistant',
        content: partialContent,
        sources: collectedSources,
        error: sseErrorMessage,
        createdAt: new Date().toISOString(),
      };
      setActiveConv((prev) => {
        if (!prev || (prev.id !== 'pending' && prev.id !== serverConvId)) return prev;
        return { ...prev, id: serverConvId, turns: [...(prev.turns || []), partialTurn], updatedAt: partialTurn.createdAt };
      });
    }
    refreshList();
  }, [activeConv, mode, navigate, question, refreshList, streaming]);

  const turns = activeConv?.turns || [];
  const showEmptyState = !conversationId && !streaming;

  return (
    <div className="flex flex-col md:flex-row h-full">
      <Sidebar
        conversations={conversations}
        activeId={conversationId}
        onPick={(id) => navigate(`/ask/${id}`)}
        onNew={startNew}
        onDelete={handleDelete}
        loading={loadingList}
        streaming={streaming}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <div className="px-4 md:px-6 py-3 border-b border-port-border flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold flex items-center gap-2"><MessageCircle size={18} /> Ask Yourself</h1>
          <div className="flex items-center gap-1 ml-auto">
            {ASK_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                title={m.help}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  mode === m.id ? 'bg-port-accent/20 text-port-accent border border-port-accent/40' : 'text-gray-400 hover:text-white border border-transparent'
                }`}
              >
                {m.label}
              </button>
            ))}
            {activeConv && activeConv.id !== 'pending' && (
              <button
                onClick={handlePromote}
                aria-label={activeConv.promoted ? 'Unpin conversation' : 'Pin conversation'}
                title={activeConv.promoted ? 'Unpin (allow auto-expiry after 30d)' : 'Pin (exempt from auto-expiry)'}
                className={`p-1.5 rounded-md transition-colors ${activeConv.promoted ? 'text-amber-400 hover:text-amber-300' : 'text-gray-500 hover:text-white'}`}
              >
                <Pin size={14} />
              </button>
            )}
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-3">
          {loadingConv && <div className="text-sm text-gray-500"><Loader2 size={14} className="inline animate-spin mr-1" /> Loading…</div>}
          {showEmptyState && (
            <div className="max-w-2xl mx-auto mt-8 text-center text-gray-400 space-y-3">
              <h2 className="text-xl text-white">Talk to your digital twin.</h2>
              <p className="text-sm">
                Every question pulls from your memory, brain notes, autobiography, goals, and calendar in parallel — answers come back in your voice with the sources cited.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-left mt-6">
                {ASK_MODES.map((m) => (
                  <div key={m.id} className="p-3 bg-port-card border border-port-border rounded-lg">
                    <div className="text-sm text-white font-medium">{m.label}</div>
                    <div className="text-xs text-gray-500 mt-1">{m.help}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <Turn
              key={t.id}
              turn={t}
              conversationId={activeConv?.id}
              goals={goals}
              canPromote={!streaming && activeConv?.id && activeConv.id !== 'pending'}
              onPromoted={handlePromoted}
            />
          ))}
          {streaming && streamingTurn && (
            <Turn turn={{ id: 'streaming', role: 'assistant', content: streamingTurn.content }} sources={streamingTurn.sources} />
          )}
        </div>

        <form onSubmit={handleSend} className="border-t border-port-border bg-port-card p-3 md:p-4">
          <div className="flex items-end gap-2">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend(e);
              }}
              placeholder={mode === 'draft' ? 'Describe what you want drafted (recipient, tone, key points)…' : 'Ask yourself anything…'}
              rows={2}
              className="flex-1 resize-none rounded-md bg-port-bg border border-port-border px-3 py-2 text-sm focus:outline-none focus:border-port-accent/60"
            />
            <button
              type="submit"
              disabled={streaming || !question.trim()}
              className="px-3 py-2 rounded-md bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-sm font-medium"
            >
              {streaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {streaming ? 'Streaming…' : 'Send'}
            </button>
          </div>
          <div className="mt-1.5 text-xs text-gray-500">⌘/Ctrl + Enter to send</div>
        </form>
      </main>
    </div>
  );
}
