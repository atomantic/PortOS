import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Send, Loader2, MessageCircle, Trash2, Pin, Brain, Calendar, Target, BookOpen, FileText, ExternalLink } from 'lucide-react';
import * as api from '../services/api';
import toast from '../components/ui/Toast';

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
              aria-disabled={lockedSwitch || undefined}
              title={lockedSwitch ? 'Wait for the current answer to finish' : undefined}
              className={`group flex items-center justify-between gap-2 px-3 py-2 hover:bg-port-border/30 ${c.id === activeId ? 'bg-port-border/40' : ''} ${lockedSwitch ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              onClick={() => { if (!lockedSwitch) onPick(c.id); }}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{c.title}</div>
                <div className="text-xs text-gray-500 flex items-center gap-1.5">
                  <span>{c.mode}</span>
                  <span>·</span>
                  <span>{c.turnCount} turns</span>
                  {c.promoted && <Pin size={10} className="text-amber-400" />}
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-port-error transition-opacity"
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

// Memoized so previously-rendered turns don't re-render on every streaming
// delta — only the actively-streaming Turn at the bottom flips on each chunk.
const Turn = memo(function Turn({ turn, sources }) {
  const isUser = turn.role === 'user';
  const turnSources = turn.sources || sources || [];
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-lg px-4 py-3 ${isUser ? 'bg-port-accent/15 border border-port-accent/30' : 'bg-port-card border border-port-border'}`}>
        <div className="text-sm whitespace-pre-wrap break-words">{turn.content || (isUser ? '' : <span className="text-gray-500"><Loader2 size={14} className="inline animate-spin mr-1" />thinking…</span>)}</div>
        {!isUser && turnSources.length > 0 && (
          <div className="mt-3 pt-3 border-t border-port-border flex flex-wrap gap-1.5">
            {turnSources.map((s, i) => <SourceChip key={s.id} source={s} index={i} />)}
          </div>
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
  // streamingTurn === null means "not streaming". Storing the partial content
  // and sources in a single object is enough to drive both the UI and the
  // disabled-while-streaming guards.
  const [streamingTurn, setStreamingTurn] = useState(null);
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState('ask');
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const streaming = streamingTurn !== null;

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    const data = await api.listAskConversations().catch(() => null);
    setLoadingList(false);
    if (data?.conversations) setConversations(data.conversations);
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

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
        setMode(data.conversation.mode || 'ask');
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

  // Abort any in-flight stream on unmount so we don't leave a dangling fetch
  // pumping deltas + toasts into a component that's no longer mounted. The
  // handleSend closure is keyed off `activeConv?.id` so a deliberate
  // conversation switch unmounts the old subtree's stream by re-running this
  // effect — anything still streaming dies cleanly.
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
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
    await api.deleteAskConversation(id).catch(() => null);
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

    // Optimistic user turn so the UI doesn't sit blank between submit and
    // the first SSE 'open' event (gather-sources + provider connect = 100s
    // of ms).
    const nowIso = new Date().toISOString();
    const optimisticUserTurn = { id: `optimistic-${Date.now()}`, role: 'user', content: trimmed, createdAt: nowIso };
    setActiveConv((prev) => prev
      ? { ...prev, turns: [...(prev.turns || []), optimisticUserTurn] }
      : { id: 'pending', title: trimmed.slice(0, 80), mode, turns: [optimisticUserTurn], createdAt: nowIso, updatedAt: nowIso },
    );

    let serverConvId = activeConv?.id;
    let collectedSources = [];
    let answer = '';
    let persistedTurn = null;

    await api.streamAskTurn(
      { conversationId: activeConv?.id, question: trimmed, mode },
      {
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          // Drop events that arrive after the user navigated away / aborted —
          // otherwise we'd write into a stale conversation's local state.
          if (controller.signal.aborted) return;
          if (event === 'open') {
            serverConvId = data.conversationId;
            if (!activeConv?.id || activeConv.id === 'pending') {
              navigate(`/ask/${data.conversationId}`, { replace: true });
            }
          } else if (event === 'sources') {
            collectedSources = data.sources || [];
            setStreamingTurn((prev) => ({ content: prev?.content || '', sources: collectedSources }));
          } else if (event === 'delta') {
            answer += data.text || '';
            setStreamingTurn({ content: answer, sources: collectedSources });
          } else if (event === 'done') {
            persistedTurn = data.turn || null;
          } else if (event === 'error') {
            toast.error(data.error || 'Stream error');
          }
        },
      },
    ).catch((err) => {
      if (err.name !== 'AbortError') toast.error(err.message || 'Ask failed');
    });

    const wasAborted = controller.signal.aborted;
    setStreamingTurn(null);
    if (abortRef.current === controller) abortRef.current = null;

    // Skip post-stream state writes if the user navigated/unmounted — those
    // updates would land in a stale conversation.
    if (wasAborted) return;

    // Append the persisted assistant turn locally rather than refetching the
    // whole conversation — server returned the canonical record in 'done'.
    if (persistedTurn && serverConvId) {
      setActiveConv((prev) => {
        if (!prev || (prev.id !== 'pending' && prev.id !== serverConvId)) return prev;
        return { ...prev, id: serverConvId, turns: [...(prev.turns || []), persistedTurn], updatedAt: persistedTurn.createdAt };
      });
    }
    refreshList();
  }, [activeConv, mode, navigate, question, refreshList, streaming]);

  const turns = activeConv?.turns || [];
  const showEmptyState = !conversationId && !streaming;

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-4rem)] -m-4">
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
            {activeConv && (
              <button
                onClick={handlePromote}
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
            <Turn key={t.id} turn={t} />
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
