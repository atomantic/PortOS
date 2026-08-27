import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowUp, Brain, Check, CirclePause, CirclePlay, MessageCircle, RefreshCw, Settings2, Square, StickyNote, Upload } from 'lucide-react';
import useMounted from '../../../hooks/useMounted';
import { useSocket } from '../../../hooks/useSocket';
import { uuidv4 } from '../../../lib/uuid.js';
import * as api from '../../../services/api';
import { formatDateTime } from '../../../utils/formatters';
import BrailleSpinner from '../../BrailleSpinner';
import Drawer from '../../Drawer';
import Banner from '../../ui/Banner';
import TabPills from '../../ui/TabPills';
import PersistentMindContextPanel from '../PersistentMindContextPanel';
import PersistentMindProfileControls from '../PersistentMindProfileControls';
import PersistentMindRuntimePanel, { PersistentMindThoughtStatus } from '../PersistentMindRuntimePanel';
import PersistentMindTaskAccessControls from '../PersistentMindTaskAccessControls';

const PAGE_LIMIT = 200;
const MAX_BACKFILL_PAGES = 5;
const MAX_VISIBLE_EVENTS = PAGE_LIMIT * MAX_BACKFILL_PAGES;
const MIND_VIEWS = new Set(['conversation', 'context', 'setup']);
const MIND_TABS = [
  { id: 'conversation', label: 'Chat', icon: MessageCircle },
  { id: 'context', label: 'Memory', icon: Brain },
  { id: 'setup', label: 'Settings', icon: Settings2 },
];

const ACTIVITY_KINDS = new Set([
  'mind.wake', 'mind.model.request', 'mind.model.result', 'mind.turn.completed',
]);

const EVENT_LABELS = {
  'mind.message.accepted': 'User input',
  'mind.annotation.accepted': 'Annotation',
  'mind.summary': 'Mind summary',
  'mind.model.result': 'Mind summary',
  'mind.turn.completed': 'Mind summary',
  'mind.thought': 'Working note',
  'mind.reply': 'Chief of Staff',
  'mind.memory.candidate': 'Memory proposal',
  'mind.capability.request': 'Action request',
  'mind.capability.result': 'Action outcome',
  'mind.memory.promoted': 'Memory promoted',
};

const eventLabel = (kind) => EVENT_LABELS[kind] || 'System state';
const eventText = (event) => {
  const data = event?.data || {};
  if (typeof data.displayText === 'string') return data.displayText;
  if (typeof data.summaryText === 'string') return data.summaryText;
  if (event?.kind === 'mind.failed') return data.status === 'interrupted'
    ? 'The previous wake was interrupted'
    : 'The provider was unavailable or the wake failed';
  if (event?.kind === 'mind.paused') return data.status === 'idle'
    ? 'The persistent mind was stopped'
    : 'The persistent mind was paused';
  if (event?.kind === 'mind.capability.request' && typeof data.capabilityId === 'string') {
    return `Capability request ${data.capabilityId}`;
  }
  if (typeof data.status === 'string') return data.status;
  return null;
};

const mergeEvents = (previous, incoming) => {
  const byId = new Map(previous.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence).slice(-MAX_VISIBLE_EVENTS);
};

const mintId = (prefix) => `${prefix}-${uuidv4()}`;

const buildConversationItems = (events, showActivity) => {
  const included = events.filter((event) => showActivity || !ACTIVITY_KINDS.has(event.kind));
  const thoughtsByTurn = new Map();
  const replyTurns = new Set();

  for (const event of included) {
    if (event.kind === 'mind.thought' && event.turnId) {
      thoughtsByTurn.set(event.turnId, [...(thoughtsByTurn.get(event.turnId) || []), event]);
    }
    if (event.kind === 'mind.reply' && event.turnId) replyTurns.add(event.turnId);
  }

  const emittedThoughtTurns = new Set();
  return included.flatMap((event) => {
    if (event.kind === 'mind.thought' && event.turnId) {
      if (replyTurns.has(event.turnId) || emittedThoughtTurns.has(event.turnId)) return [];
      emittedThoughtTurns.add(event.turnId);
      return [{ event, thoughts: thoughtsByTurn.get(event.turnId) || [], thoughtOnly: true }];
    }
    if (event.kind === 'mind.reply' && event.turnId) {
      return [{ event, thoughts: thoughtsByTurn.get(event.turnId) || [], thoughtOnly: false }];
    }
    return [{ event, thoughts: [], thoughtOnly: false }];
  });
};

export default function MindTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedEventId = searchParams.get('event');
  const activeView = MIND_VIEWS.has(searchParams.get('view')) ? searchParams.get('view') : 'conversation';
  const socket = useSocket();
  const [events, setEvents] = useState(null);
  const [mind, setMind] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [gap, setGap] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messageText, setMessageText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [annotationText, setAnnotationText] = useState('');
  const [annotationSubmitting, setAnnotationSubmitting] = useState(false);
  const [annotationError, setAnnotationError] = useState(null);
  const [lifecyclePending, setLifecyclePending] = useState(null);
  const [eventActionPending, setEventActionPending] = useState(null);
  const [lifecycleError, setLifecycleError] = useState(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [taskAccessSaving, setTaskAccessSaving] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [runtime, setRuntime] = useState(null);
  const [runtimeError, setRuntimeError] = useState(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const cursorRef = useRef(null);
  const loadPendingRef = useRef(false);
  const deferredLoadRef = useRef(false);
  const runtimePendingRef = useRef(false);
  const deferredRuntimeRef = useRef(false);
  const runtimeLoadedRef = useRef(false);
  const runtimeMountedRef = useMounted();
  const messageDraftIdRef = useRef(null);
  const annotationDraftIdRef = useRef(null);
  const messageListRef = useRef(null);
  const stickToBottomRef = useRef(true);

  const loadHistory = useCallback(async ({ reset = false } = {}) => {
    if (loadPendingRef.current) {
      deferredLoadRef.current = true;
      return;
    }
    loadPendingRef.current = true;
    const messageList = messageListRef.current;
    stickToBottomRef.current = reset || !messageList
      || messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
    if (reset) setLoading(true);
    let cursor = reset ? null : cursorRef.current;
    let page = 0;
    let accumulated = [];
    let sawGap = false;
    let sawTruncation = false;
    let needsMore = false;
    try {
      do {
        const response = await api.getPersistentMind({ cursor, limit: PAGE_LIMIT }, { silent: true });
        accumulated = mergeEvents(accumulated, response.events || []);
        sawGap ||= response.gap === true;
        sawTruncation ||= response.truncated === true;
        cursor = response.gap === true ? response.cursor : response.cursor || cursor;
        setMind({
          state: response.state,
          profile: response.profile,
          capabilities: response.capabilities,
          autonomyMode: response.autonomyMode,
        });
        page += 1;
        needsMore = response.hasMore === true && !sawGap;
        if (!needsMore) break;
      } while (page < MAX_BACKFILL_PAGES);
      cursorRef.current = cursor;
      setEvents((previous) => reset || sawGap || previous === null ? accumulated : mergeEvents(previous, accumulated));
      setGap(sawGap);
      setTruncated((current) => reset ? sawTruncation : current || sawTruncation);
      setLoadError(null);
      if (needsMore) deferredLoadRef.current = true;
    } catch (error) {
      setLoadError(error?.message || 'Could not load the persistent mind');
    } finally {
      setLoading(false);
      loadPendingRef.current = false;
      if (deferredLoadRef.current) {
        deferredLoadRef.current = false;
        void loadHistory();
      }
    }
  }, []);

  const loadRuntime = useCallback(async () => {
    if (runtimePendingRef.current) {
      deferredRuntimeRef.current = true;
      return;
    }
    runtimePendingRef.current = true;
    if (!runtimeLoadedRef.current) setRuntimeLoading(true);
    try {
      const response = await api.getPersistentMindRuntime({ silent: true });
      if (!runtimeMountedRef.current) return;
      setRuntime(response);
      runtimeLoadedRef.current = true;
      setRuntimeError(null);
    } catch (error) {
      if (runtimeMountedRef.current) {
        setRuntimeError(error?.message || 'Could not refresh runtime telemetry');
      }
    } finally {
      if (runtimeMountedRef.current) setRuntimeLoading(false);
      runtimePendingRef.current = false;
      if (runtimeMountedRef.current && deferredRuntimeRef.current) {
        deferredRuntimeRef.current = false;
        void loadRuntime();
      }
    }
  }, []);

  useEffect(() => { void loadHistory({ reset: true }); }, [loadHistory]);
  useEffect(() => {
    void loadRuntime();
    const interval = setInterval(() => { void loadRuntime(); }, 10_000);
    return () => clearInterval(interval);
  }, [loadRuntime]);

  useEffect(() => {
    const refresh = () => {
      void loadHistory();
      void loadRuntime();
    };
    socket.on('connect', refresh);
    socket.on('cos:mind:event', refresh);
    socket.on('cos:mind:status', refresh);
    return () => {
      socket.off('connect', refresh);
      socket.off('cos:mind:event', refresh);
      socket.off('cos:mind:status', refresh);
    };
  }, [loadHistory, loadRuntime, socket]);

  useEffect(() => {
    if (!stickToBottomRef.current || !messageListRef.current) return;
    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [events]);

  useEffect(() => {
    annotationDraftIdRef.current = null;
    setAnnotationText('');
    setAnnotationError(null);
  }, [selectedEventId]);

  const appendLocalInput = ({ id, content, inputKind, targetEventId = null }) => {
    setEvents((previous) => {
      const sequence = Math.max(-1, ...(previous || []).map((item) => item.sequence || -1)) + 1;
      return mergeEvents(previous || [], [{
        eventId: `mind-${inputKind}:${id}`,
        kind: inputKind === 'message' ? 'mind.message.accepted' : 'mind.annotation.accepted',
        mindId: 'cos-persistent-mind',
        turnId: null,
        sequence,
        at: new Date().toISOString(),
        data: {
          displayText: content,
          ...(inputKind === 'message' ? { messageId: id } : { annotationId: id, targetEventId }),
        },
      }]);
    });
  };

  const submitMessage = async (event) => {
    event.preventDefault();
    const trimmed = messageText.trim();
    if (!trimmed || submitting) return;
    const id = messageDraftIdRef.current || mintId('message');
    messageDraftIdRef.current = id;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.sendPersistentMindMessage({ id, text: trimmed }, { silent: true });
      stickToBottomRef.current = true;
      appendLocalInput({ id, content: trimmed, inputKind: 'message' });
      setMessageText('');
      messageDraftIdRef.current = null;
      await loadHistory();
      stickToBottomRef.current = true;
      void loadRuntime();
    } catch (error) {
      setSubmitError(error?.message || 'The input was not accepted');
    } finally {
      setSubmitting(false);
    }
  };

  const submitAnnotation = async (event) => {
    event.preventDefault();
    const trimmed = annotationText.trim();
    if (!selectedEventId || !trimmed || annotationSubmitting) return;
    const id = annotationDraftIdRef.current || mintId('annotation');
    annotationDraftIdRef.current = id;
    setAnnotationSubmitting(true);
    setAnnotationError(null);
    try {
      await api.addPersistentMindAnnotation({ id, text: trimmed, targetEventId: selectedEventId }, { silent: true });
      appendLocalInput({ id, content: trimmed, inputKind: 'annotation', targetEventId: selectedEventId });
      setAnnotationText('');
      annotationDraftIdRef.current = null;
      await loadHistory();
    } catch (error) {
      setAnnotationError(error?.message || 'The annotation was not accepted');
    } finally {
      setAnnotationSubmitting(false);
    }
  };

  const changeMessageText = (next) => {
    if (submitError) {
      messageDraftIdRef.current = null;
      setSubmitError(null);
    }
    setMessageText(next);
  };

  const changeAnnotationText = (next) => {
    if (annotationError) {
      annotationDraftIdRef.current = null;
      setAnnotationError(null);
    }
    setAnnotationText(next);
  };

  const runLifecycle = async (action) => {
    setLifecyclePending(action);
    setLifecycleError(null);
    try {
      if (action === 'start') await api.startPersistentMind({ silent: true });
      if (action === 'pause') await api.pausePersistentMind('Paused from Mind page', { silent: true });
      if (action === 'resume') await api.resumePersistentMind({ silent: true });
      if (action === 'stop') await api.stopPersistentMind({ silent: true });
      await loadHistory();
      void loadRuntime();
    } catch (error) {
      setLifecycleError(error?.message || `Could not ${action} the persistent mind`);
    } finally {
      setLifecyclePending(null);
    }
  };

  const acknowledge = async (event) => {
    if (eventActionPending) return;
    setEventActionPending(event.eventId);
    setLifecycleError(null);
    try {
      await api.acknowledgePersistentMindEvent(event.eventId, `ack-${event.eventId}`, { silent: true });
      await loadHistory();
    } catch (error) {
      setLifecycleError(error?.message || 'Could not acknowledge the action');
    } finally {
      setEventActionPending(null);
    }
  };

  const promote = async (event) => {
    const content = eventText(event);
    if (!content || eventActionPending) return;
    setEventActionPending(event.eventId);
    setLifecycleError(null);
    try {
      await api.promotePersistentMindEvent(event.eventId, {
        id: `promotion-${event.eventId}`, approved: true, content, summary: content.slice(0, 500), type: 'insight', category: 'other',
      }, { silent: true });
      await loadHistory();
    } catch (error) {
      setLifecycleError(error?.message || 'Could not promote the action');
    } finally {
      setEventActionPending(null);
    }
  };

  const state = mind?.state;
  const selectedEvent = events?.find((event) => event.eventId === selectedEventId) || null;
  const isPaused = state?.status === 'paused';
  const profileReady = Boolean(mind?.profile?.enabled && mind.profile.providerId && mind.profile.model);
  const setupSaving = profileSaving || taskAccessSaving;
  const conversationItems = buildConversationItems(events || [], showActivity);
  const changeView = (view) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    if (view === 'conversation') next.delete('view');
    else {
      next.set('view', view);
      next.delete('event');
    }
    return next;
  });
  const selectEvent = (eventId) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.set('event', eventId);
    return next;
  });
  const closeSelectedEvent = () => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.delete('event');
    return next;
  });

  return (
    <section aria-labelledby="mind-heading" className="mx-auto max-w-6xl space-y-4 pb-4">
      {activeView === 'conversation' ? (
        <h2 id="mind-heading" className="sr-only">Persistent Mind</h2>
      ) : (
        <header className="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-port-accent/15 text-port-accent ring-1 ring-port-accent/30">
              <Brain size={23} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="mind-heading" className="truncate text-lg font-semibold text-port-text">Persistent Mind</h2>
              <p className="truncate text-xs text-port-text-muted">
                {mind ? `${mind.profile?.model || 'No model'} · ${mind.profile?.providerId || 'No provider'} · machine-local` : 'Loading profile…'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Persistent mind lifecycle">
            <PersistentMindThoughtStatus
              state={state}
              model={state?.activeTurnId && state.activeTurnId === runtime?.inference?.turnId
                ? runtime.inference.model
                : mind?.profile?.model}
            />
            {state?.started && !isPaused && <ActionButton label="Pause" icon={CirclePause} pending={lifecyclePending === 'pause'} onClick={() => runLifecycle('pause')} />}
            {state?.started && isPaused && <ActionButton label="Resume" icon={CirclePlay} pending={lifecyclePending === 'resume'} onClick={() => runLifecycle('resume')} />}
            {state?.started && <ActionButton label="Stop" icon={Square} pending={lifecyclePending === 'stop'} onClick={() => runLifecycle('stop')} />}
            <ActionButton label="Reload" icon={RefreshCw} pending={loading || runtimeLoading} onClick={() => {
              void loadHistory({ reset: true });
              void loadRuntime();
            }} />
          </div>
        </header>
      )}

      <TabPills tabs={MIND_TABS} activeTab={activeView} onChange={changeView} variant="pills" size="sm" ariaLabel="Persistent mind view" />

      {gap && <Banner tone="warning" title="History gap detected">The saved cursor is no longer retained. The visible trace was reloaded from the newest bounded snapshot.</Banner>}
      {truncated && <Banner tone="info" title="Showing recent history">The initial trace shows the newest {PAGE_LIMIT} events; older retained events are not shown.</Banner>}
      {loadError && <Banner tone="error" title="Conversation unavailable">{loadError}. Existing messages are preserved; retry when the connection recovers.</Banner>}
      {lifecycleError && <Banner tone="error" title="Action failed">{lifecycleError}</Banner>}

      {activeView !== 'conversation' && (
        <PersistentMindRuntimePanel runtime={runtime} error={runtimeError} loading={runtimeLoading} onOpenContext={() => changeView('context')} />
      )}

      {activeView === 'setup' && (
        <section aria-labelledby="mind-profile-heading" className="rounded border border-port-border bg-port-card p-4">
          <div className="mb-3">
            <h3 id="mind-profile-heading" className="text-sm font-semibold text-port-text">AI profile</h3>
            <p className="mt-1 text-xs text-port-text-muted">Pin the provider, model, and effort used on every wake. Changes apply to the next wake and never silently fall back to another model.</p>
          </div>
          <PersistentMindProfileControls
            profile={mind?.profile}
            disabled={!mind}
            onSaved={(profile) => setMind((current) => current ? { ...current, profile } : current)}
            onSavingChange={setProfileSaving}
          />
          <div className="mt-4 border-t border-port-border pt-4">
            <h3 className="text-sm font-semibold text-port-text">Agent task access</h3>
            <p className="mb-3 mt-1 text-xs text-port-text-muted">Choose whether this mind may turn a concrete recommendation into a typed task with its own run profile and landing gate.</p>
            <PersistentMindTaskAccessControls
              capabilities={mind?.capabilities}
              disabled={!mind}
              onSaved={(capabilities) => setMind((current) => current ? { ...current, capabilities } : current)}
              onSavingChange={setTaskAccessSaving}
            />
          </div>
          {!state?.started && (
            <div className="mt-4 flex flex-col gap-2 border-t border-port-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-port-text-muted">{setupSaving ? 'Saving persistent mind settings…' : profileReady ? 'The saved AI profile is ready.' : 'Enable the profile and select both an AI provider and model to start.'}</p>
              <ActionButton label="Start persistent mind" icon={CirclePlay} pending={lifecyclePending === 'start'} disabled={loading || setupSaving || !profileReady} onClick={() => runLifecycle('start')} />
            </div>
          )}
        </section>
      )}

      {activeView === 'context' && <PersistentMindContextPanel />}

      {activeView === 'conversation' && (
        <section data-testid="mind-chat" aria-label="Persistent mind chat" className="flex h-[60dvh] min-h-[27rem] max-h-[48rem] flex-col overflow-hidden rounded-[1.5rem] border border-port-border bg-port-card shadow-lg shadow-black/10 sm:h-[72dvh] sm:min-h-[30rem]">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-port-border bg-port-card/95 px-3 py-2.5 sm:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-port-accent/15 text-port-accent">
                <Brain size={19} aria-hidden="true" />
                <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-port-card ${state?.started && !isPaused ? 'bg-port-success' : 'bg-port-text-muted'}`} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-port-text">Chief of Staff</h3>
                <p className="truncate text-[11px] text-port-text-muted">
                  {state?.pauseReason || (state?.status === 'thinking' ? 'Thinking…' : state?.started ? 'Available' : 'Not started')}
                  {state?.queuedMessageCount > 0 ? ` · ${state.queuedMessageCount} queued` : ''}
                  {mind?.profile?.model ? ` · ${mind.profile.model}` : ''}
                </p>
              </div>
            </div>
            <label htmlFor="mind-show-activity" className="flex shrink-0 items-center gap-2 rounded-full border border-port-border px-2.5 py-1.5 text-[11px] text-port-text-muted">
              <input id="mind-show-activity" type="checkbox" checked={showActivity} onChange={(event) => setShowActivity(event.target.checked)} className="accent-port-accent" /> Activity
            </label>
          </header>

          <div ref={messageListRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-5 sm:px-5" aria-label="Persistent mind conversation">
            {loading && events === null ? (
              <div className="flex h-full items-center justify-center"><BrailleSpinner text="Loading mind history" /></div>
            ) : conversationItems.length === 0 && !loadError ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-port-accent/10 text-port-accent"><MessageCircle size={26} aria-hidden="true" /></span>
                <p className="text-sm font-medium text-port-text">Start the conversation</p>
                <p className="mt-1 max-w-sm text-xs text-port-text-muted">Send a message below. This thread stays on this machine and carries forward across wakes.</p>
              </div>
            ) : (
              <ol className="space-y-3">
                {conversationItems.map((item) => (
                  <ConversationItem
                    key={item.event.eventId}
                    {...item}
                    selectedEventId={selectedEventId}
                    onSelect={selectEvent}
                  />
                ))}
              </ol>
            )}
          </div>

          <form onSubmit={submitMessage} className="shrink-0 border-t border-port-border bg-port-card/95 px-2.5 pb-[max(0.65rem,env(safe-area-inset-bottom))] pt-2.5 sm:px-4">
            {submitError && <p role="alert" className="mt-2 text-sm text-port-error">{submitError} — Retry uses the same id, so it will not duplicate the input.</p>}
            <div className="flex items-end gap-2 rounded-[1.35rem] border border-port-border bg-port-bg p-1.5 pl-3 focus-within:border-port-accent/70 focus-within:ring-1 focus-within:ring-port-accent/30">
              <label htmlFor="mind-input-text" className="sr-only">Message</label>
              <textarea id="mind-input-text" value={messageText} onChange={(event) => changeMessageText(event.target.value)} maxLength={8000} rows={1} className="min-h-[36px] max-h-32 flex-1 resize-y bg-transparent py-2 text-sm leading-5 text-port-text outline-none placeholder:text-port-text-muted" placeholder="Message Persistent Mind" />
              <button type="submit" disabled={!messageText.trim() || submitting} aria-label={submitting ? 'Sending message' : submitError ? 'Retry' : 'Send message'} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-port-accent text-white transition-colors hover:bg-port-accent/85 disabled:cursor-not-allowed disabled:bg-port-border disabled:text-port-text-muted">
                {submitting ? <RefreshCw size={17} className="animate-spin" aria-hidden="true" /> : <ArrowUp size={19} strokeWidth={2.5} aria-hidden="true" />}
              </button>
            </div>
          </form>
        </section>
      )}

      <Drawer
        open={activeView === 'conversation' && Boolean(selectedEventId)}
        onClose={closeSelectedEvent}
        title={selectedEvent ? eventLabel(selectedEvent.kind) : 'Event details'}
        subtitle={selectedEvent?.at ? formatDateTime(selectedEvent.at) : undefined}
        size="sm"
        closeLabel="Close event details"
      >
        {selectedEvent ? (
          <div className="space-y-5">
            <section aria-labelledby="mind-event-content-heading">
              <h3 id="mind-event-content-heading" className="text-xs font-semibold uppercase tracking-wide text-port-accent">Message</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-port-text">{eventText(selectedEvent) || selectedEvent.kind}</p>
            </section>

            <section aria-labelledby="mind-event-metadata-heading" className="space-y-2 border-t border-port-border pt-4">
              <h3 id="mind-event-metadata-heading" className="text-xs font-semibold uppercase tracking-wide text-port-accent">Event metadata</h3>
              <p className="break-all font-mono text-xs text-port-text-muted">{selectedEvent.eventId}</p>
              <p className="text-xs text-port-text-muted">Sequence {selectedEvent.sequence}{selectedEvent.turnId ? ` · turn ${selectedEvent.turnId}` : ''}</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-port-border bg-port-bg p-3 text-[11px] text-port-text-muted">{JSON.stringify(selectedEvent.data || {}, null, 2)}</pre>
            </section>

            <div className="flex flex-wrap gap-2 border-t border-port-border pt-4">
              {selectedEvent.kind === 'mind.capability.request' && <ActionButton label="Acknowledge" icon={Check} pending={eventActionPending === selectedEvent.eventId} onClick={() => acknowledge(selectedEvent)} />}
              {['mind.summary', 'mind.reply', 'mind.thought', 'mind.memory.candidate'].includes(selectedEvent.kind) && (
                <ActionButton label="Promote to memory" icon={Upload} pending={eventActionPending === selectedEvent.eventId} disabled={!eventText(selectedEvent)} onClick={() => promote(selectedEvent)} />
              )}
            </div>

            <form onSubmit={submitAnnotation} className="space-y-3 border-t border-port-border pt-4">
              <div>
                <label htmlFor="mind-annotation-text" className="flex items-center gap-2 text-sm font-medium text-port-text"><StickyNote size={15} aria-hidden="true" /> Add a note</label>
                <p className="mt-1 text-xs text-port-text-muted">Attach context to this event without starting a new turn.</p>
              </div>
              <textarea id="mind-annotation-text" value={annotationText} onChange={(event) => changeAnnotationText(event.target.value)} maxLength={8000} rows={4} className="w-full resize-y rounded-xl border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text focus:border-port-accent focus:outline-none" placeholder="Add context or an idea…" />
              {annotationError && <p role="alert" className="text-sm text-port-error">{annotationError} — Retry uses the same id.</p>}
              <button type="submit" disabled={!annotationText.trim() || annotationSubmitting} className="rounded-full bg-port-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{annotationSubmitting ? 'Adding note…' : annotationError ? 'Retry note' : 'Add note'}</button>
            </form>
          </div>
        ) : (
          <p className="text-sm text-port-text-muted">This event is no longer available in the retained conversation history.</p>
        )}
      </Drawer>
    </section>
  );
}

function ConversationItem({ event, thoughts, thoughtOnly, selectedEventId, onSelect }) {
  const outgoing = event.kind === 'mind.message.accepted';
  const incoming = thoughtOnly || ['mind.reply', 'mind.summary'].includes(event.kind);
  const selected = event.eventId === selectedEventId;
  const content = thoughtOnly ? 'Thoughts from this turn' : eventText(event) || event.kind;

  if (!outgoing && !incoming) {
    return (
      <li className="flex justify-center px-2">
        <button
          type="button"
          onClick={() => onSelect(event.eventId)}
          aria-current={selected ? 'true' : undefined}
          aria-label={`${eventLabel(event.kind)} · ${formatDateTime(event.at)}`}
          className={`max-w-[92%] rounded-full border border-port-border bg-port-bg/70 px-3 py-1.5 text-center text-xs text-port-text-muted transition-colors hover:bg-port-border/30 ${selected ? 'ring-2 ring-port-accent/70' : ''}`}
        >
          <span className="font-medium text-port-text">{eventLabel(event.kind)}</span>
          {eventText(event) && <><span aria-hidden="true"> · </span><span>{eventText(event)}</span></>}
        </button>
      </li>
    );
  }

  return (
    <li className={`flex flex-col ${outgoing ? 'items-end' : 'items-start'}`}>
      {!outgoing && <span className="mb-1 ml-2 text-[11px] font-medium text-port-text-muted">Chief of Staff</span>}
      <div className={`max-w-[86%] overflow-hidden ${outgoing ? 'rounded-[1.25rem] rounded-br-md bg-port-accent text-white' : 'rounded-[1.25rem] rounded-bl-md bg-port-border/55 text-port-text'} ${selected ? 'ring-2 ring-port-accent/80 ring-offset-2 ring-offset-port-card' : ''}`}>
        <button
          type="button"
          onClick={() => onSelect(event.eventId)}
          aria-current={selected ? 'true' : undefined}
          aria-label={`${eventLabel(event.kind)} · ${formatDateTime(event.at)}`}
          className="block w-full whitespace-pre-wrap break-words px-3.5 py-2.5 text-left text-[15px] leading-5"
        >
          {content}
        </button>
        {thoughts.length > 0 && (
          <details className={`border-t ${outgoing ? 'border-white/20' : 'border-port-text/10'}`}>
            <summary className="cursor-pointer px-3.5 py-2 text-xs font-medium opacity-75 hover:opacity-100">
              {thoughts.length} {thoughts.length === 1 ? 'thought' : 'thoughts'}
            </summary>
            <div className={`space-y-1.5 border-t px-2 py-2 ${outgoing ? 'border-white/20' : 'border-port-text/10'}`}>
              {thoughts.map((thought) => (
                <button
                  key={thought.eventId}
                  type="button"
                  onClick={() => onSelect(thought.eventId)}
                  aria-current={thought.eventId === selectedEventId ? 'true' : undefined}
                  aria-label={`${eventLabel(thought.kind)} · ${formatDateTime(thought.at)}`}
                  className={`block w-full rounded-xl px-2 py-1.5 text-left text-xs leading-5 opacity-75 hover:bg-black/10 hover:opacity-100 ${thought.eventId === selectedEventId ? 'ring-1 ring-current' : ''}`}
                >
                  {eventText(thought) || thought.kind}
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
      <time className={`mt-1 px-2 text-[10px] text-port-text-muted ${outgoing ? 'text-right' : 'text-left'}`} dateTime={event.at}>{formatDateTime(event.at)}</time>
    </li>
  );
}

function ActionButton({ label, icon: Icon, pending = false, disabled = false, onClick }) {
  return (
    <button type="button" disabled={pending || disabled} onClick={onClick} className="flex min-h-[36px] items-center gap-2 rounded border border-port-border px-3 py-1.5 text-sm text-port-text hover:bg-port-border/30 disabled:cursor-not-allowed disabled:opacity-50">
      <Icon size={16} className={pending ? 'animate-spin' : ''} aria-hidden="true" /> {pending ? `${label}…` : label}
    </button>
  );
}
