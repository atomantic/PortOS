import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowUp, Brain, Check, CirclePause, CirclePlay, Cpu, Database, Eraser, ImagePlus, MessageCircle, RefreshCw, Settings2, Square, StickyNote, Upload, Wrench, X } from 'lucide-react';
import { Link } from 'react-router';
import useMounted from '../../../hooks/useMounted';
import { useSocket } from '../../../hooks/useSocket';
import { uuidv4 } from '../../../lib/uuid.js';
import * as api from '../../../services/api';
import { formatDateTime, timeUntil } from '../../../utils/formatters';
import BrailleSpinner from '../../BrailleSpinner';
import Drawer from '../../Drawer';
import Banner from '../../ui/Banner';
import FilePickerButton from '../../ui/FilePickerButton';
import TabPills from '../../ui/TabPills';
import PersistentMindContextPanel from '../PersistentMindContextPanel';
import PersistentMindMaintenancePanel from '../PersistentMindMaintenancePanel';
import PersistentMindProfileControls from '../PersistentMindProfileControls';
import PersistentMindRuntimePanel, { PersistentMindThoughtStatus } from '../PersistentMindRuntimePanel';
import PersistentMindVisibilityPanel from '../PersistentMindVisibilityPanel';
import PersistentMindTools from '../../../pages/PersistentMindTools';
import { readFileAsBase64, UPLOAD_IMAGE_ACCEPT, validateImageFile } from '../../../utils/fileUpload';

const PAGE_LIMIT = 200;
const MAX_BACKFILL_PAGES = 5;
const MAX_VISIBLE_EVENTS = PAGE_LIMIT * MAX_BACKFILL_PAGES;
const MAX_MESSAGE_IMAGES = 8;
const MAX_MESSAGE_IMAGE_BYTES = 10 * 1024 * 1024;
const MIND_PANELS = new Set(['context', 'memories', 'maintenance', 'tools', 'settings']);
const MIND_PANEL_TABS = [
  { id: 'context', label: 'Context', icon: Brain },
  { id: 'memories', label: 'Memories', icon: Database },
  { id: 'maintenance', label: 'Cleanup', icon: Eraser },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'settings', label: 'Settings', icon: Settings2 },
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
  'mind.memory.created': 'Memory created',
  'mind.memory.failed': 'Memory save failed',
  'mind.capability.request': 'Action request',
  'mind.capability.result': 'Action outcome',
  'mind.memory.promoted': 'Memory promoted',
  'mind.maintenance.completed': 'Mindspace cleaned',
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

const safeMessageImages = (event) => (Array.isArray(event?.data?.images) ? event.data.images : [])
  .filter((image) => (
    typeof image?.attachmentId === 'string'
    && typeof image?.path === 'string'
    && image.path.startsWith('/api/screenshots/')
    && typeof image?.originalName === 'string'
  ))
  .slice(0, MAX_MESSAGE_IMAGES);

const imageCapability = (mind) => {
  const capability = mind?.imageCapability;
  const status = ['supported', 'unsupported', 'unknown'].includes(capability?.status)
    ? capability.status
    : 'unknown';
  return { status, guidance: typeof capability?.guidance === 'string' ? capability.guidance : null };
};

const MindTypingIndicator = () => (
  <span
    data-testid="mind-typing-indicator"
    role="status"
    aria-label="Chief of Staff is typing"
    className="inline-flex items-center gap-0.5"
  >
    <span className="sr-only">Chief of Staff is typing</span>
    {[0, 1, 2].map((index) => (
      <span
        key={index}
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none"
        style={{ animationDelay: `${index * 120}ms` }}
      />
    ))}
  </span>
);

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
  const legacyView = searchParams.get('view');
  const requestedPanel = searchParams.get('panel') || (legacyView === 'setup' ? 'settings' : legacyView);
  const activePanel = MIND_PANELS.has(requestedPanel) ? requestedPanel : null;
  const socket = useSocket();
  const [events, setEvents] = useState(null);
  const [mind, setMind] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [gap, setGap] = useState(false);
  const [loading, setLoading] = useState(true);
  const [messageText, setMessageText] = useState('');
  const [messageImages, setMessageImages] = useState([]);
  const [messageImagesUploading, setMessageImagesUploading] = useState(false);
  const [messageImageError, setMessageImageError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [annotationText, setAnnotationText] = useState('');
  const [annotationSubmitting, setAnnotationSubmitting] = useState(false);
  const [annotationError, setAnnotationError] = useState(null);
  const [lifecyclePending, setLifecyclePending] = useState(null);
  const [eventActionPending, setEventActionPending] = useState(null);
  const [lifecycleError, setLifecycleError] = useState(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [capabilitiesSaving, setCapabilitiesSaving] = useState(false);
  const [contextRefreshKey, setContextRefreshKey] = useState(0);
  const [visitedPanels, setVisitedPanels] = useState(() => new Set(activePanel ? [activePanel] : []));
  const [showActivity, setShowActivity] = useState(false);
  const [runtime, setRuntime] = useState(null);
  const [runtimeError, setRuntimeError] = useState(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [visibility, setVisibility] = useState(null);
  const [visibilityError, setVisibilityError] = useState(null);
  const [visibilityLoading, setVisibilityLoading] = useState(true);
  const cursorRef = useRef(null);
  const loadPendingRef = useRef(false);
  const deferredLoadRef = useRef(false);
  const runtimePendingRef = useRef(false);
  const deferredRuntimeRef = useRef(false);
  const runtimeLoadedRef = useRef(false);
  const visibilityPendingRef = useRef(false);
  const deferredVisibilityRefreshRef = useRef(false);
  const visibilityLoadedRef = useRef(false);
  const runtimeMountedRef = useMounted();
  const messageDraftIdRef = useRef(null);
  const messageDraftImagesRef = useRef(null);
  const annotationDraftIdRef = useRef(null);
  const messageListRef = useRef(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (!activePanel) return;
    setVisitedPanels((current) => {
      if (current.has(activePanel)) return current;
      const next = new Set(current);
      next.add(activePanel);
      return next;
    });
  }, [activePanel]);

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
    let needsMore = false;
    try {
      do {
        const response = await api.getPersistentMind({ cursor, limit: PAGE_LIMIT }, { silent: true });
        accumulated = mergeEvents(accumulated, response.events || []);
        sawGap ||= response.gap === true;
        cursor = response.gap === true ? response.cursor : response.cursor || cursor;
        setMind({
          state: response.state,
          profile: response.profile,
          capabilities: response.capabilities,
          imageCapability: response.imageCapability,
          autonomyMode: response.autonomyMode,
        });
        page += 1;
        needsMore = response.hasMore === true && !sawGap;
        if (!needsMore) break;
      } while (page < MAX_BACKFILL_PAGES);
      cursorRef.current = cursor;
      setEvents((previous) => reset || sawGap || previous === null ? accumulated : mergeEvents(previous, accumulated));
      setGap(sawGap);
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

  const loadVisibility = useCallback(async ({ refresh = false } = {}) => {
    if (visibilityPendingRef.current) {
      deferredVisibilityRefreshRef.current ||= refresh;
      return;
    }
    visibilityPendingRef.current = true;
    if (!visibilityLoadedRef.current) setVisibilityLoading(true);
    try {
      const response = await api.getPersistentMindVisibility({ refresh, silent: true });
      if (!runtimeMountedRef.current) return;
      setVisibility(response);
      visibilityLoadedRef.current = true;
      setVisibilityError(null);
    } catch (error) {
      if (runtimeMountedRef.current) {
        setVisibilityError(error?.message || 'Could not refresh environment visibility');
      }
    } finally {
      if (runtimeMountedRef.current) setVisibilityLoading(false);
      visibilityPendingRef.current = false;
      if (runtimeMountedRef.current && deferredVisibilityRefreshRef.current) {
        const deferredRefresh = deferredVisibilityRefreshRef.current;
        deferredVisibilityRefreshRef.current = false;
        void loadVisibility({ refresh: deferredRefresh });
      }
    }
  }, [runtimeMountedRef]);

  useEffect(() => { void loadHistory({ reset: true }); }, [loadHistory]);
  useEffect(() => {
    void loadRuntime();
    const interval = setInterval(() => { void loadRuntime(); }, 10_000);
    return () => clearInterval(interval);
  }, [loadRuntime]);
  useEffect(() => {
    void loadVisibility();
    const interval = setInterval(() => { void loadVisibility(); }, 30_000);
    return () => clearInterval(interval);
  }, [loadVisibility]);

  useEffect(() => {
    const refresh = () => {
      void loadHistory();
      void loadRuntime();
      void loadVisibility();
    };
    socket.on('connect', refresh);
    socket.on('cos:mind:event', refresh);
    socket.on('cos:mind:status', refresh);
    return () => {
      socket.off('connect', refresh);
      socket.off('cos:mind:event', refresh);
      socket.off('cos:mind:status', refresh);
    };
  }, [loadHistory, loadRuntime, loadVisibility, socket]);

  useEffect(() => {
    if (!stickToBottomRef.current || !messageListRef.current) return;
    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [events]);

  useEffect(() => {
    annotationDraftIdRef.current = null;
    setAnnotationText('');
    setAnnotationError(null);
  }, [selectedEventId]);

  const appendLocalInput = ({ id, content, inputKind, targetEventId = null, images = [] }) => {
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
          ...(inputKind === 'message' ? { messageId: id, ...(images.length > 0 ? { images } : {}) } : { annotationId: id, targetEventId }),
        },
      }]);
    });
  };

  const submitMessage = async (event) => {
    event.preventDefault();
    const trimmed = messageText.trim();
    if ((!trimmed && messageImages.length === 0) || submitting || messageImagesUploading) return;
    const id = messageDraftIdRef.current || mintId('message');
    messageDraftIdRef.current = id;
    const images = messageDraftImagesRef.current || messageImages;
    messageDraftImagesRef.current = images;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.sendPersistentMindMessage({ id, text: trimmed, ...(images.length > 0 ? { images: images.map((image) => image.attachmentId) } : {}) }, { silent: true });
      stickToBottomRef.current = true;
      appendLocalInput({ id, content: trimmed, inputKind: 'message', images });
      setMessageText('');
      setMessageImages([]);
      messageDraftIdRef.current = null;
      messageDraftImagesRef.current = null;
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
      messageDraftImagesRef.current = null;
      setSubmitError(null);
    }
    setMessageText(next);
  };

  const changeMessageImages = (next) => {
    if (submitError) {
      messageDraftIdRef.current = null;
      messageDraftImagesRef.current = null;
      setSubmitError(null);
    }
    setMessageImages(next);
  };

  const uploadMessageImages = async (files) => {
    const selected = Array.from(files || []);
    const room = MAX_MESSAGE_IMAGES - messageImages.length;
    if (room <= 0 || selected.length === 0) return;
    const uploads = selected.slice(0, room);
    setMessageImagesUploading(true);
    setMessageImageError(selected.length > room ? `Only ${room} more image${room === 1 ? '' : 's'} can be attached.` : null);
    const accepted = [];
    for (const file of uploads) {
      const validationError = validateImageFile(file, MAX_MESSAGE_IMAGE_BYTES);
      if (validationError) {
        setMessageImageError(validationError);
        continue;
      }
      try {
        const data = await readFileAsBase64(file);
        const attachment = await api.uploadPersistentMindAttachment({ filename: file.name, data }, { silent: true });
        if (attachment?.attachmentId) accepted.push(attachment);
      } catch (error) {
        setMessageImageError(error?.message || `Could not upload ${file.name}`);
      }
    }
    if (accepted.length > 0) changeMessageImages([...messageImages, ...accepted].slice(0, MAX_MESSAGE_IMAGES));
    setMessageImagesUploading(false);
  };

  const removeMessageImage = async (image) => {
    try {
      await api.deletePersistentMindAttachment(image.attachmentId, { silent: true });
      changeMessageImages(messageImages.filter((candidate) => candidate.attachmentId !== image.attachmentId));
      setMessageImageError(null);
    } catch (error) {
      setMessageImageError(error?.message || `Could not remove ${image.originalName}`);
    }
  };

  const handleMessageKeyDown = (event) => {
    if (event.key !== 'Enter' || event.altKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    void submitMessage(event);
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

  const handleMindspaceCleaned = async (result) => {
    cursorRef.current = null;
    setEvents([]);
    setMind((current) => current ? { ...current, state: result.state || current.state } : current);
    setContextRefreshKey((current) => current + 1);
    await loadHistory({ reset: true });
    void loadRuntime();
  };

  const state = mind?.state;
  const selectedEvent = events?.find((event) => event.eventId === selectedEventId) || null;
  const isPaused = state?.status === 'paused';
  const profileReady = Boolean(mind?.profile?.enabled && mind.profile.providerId && mind.profile.model);
  const grantedCapabilityCount = Object.entries(mind?.capabilities || {})
    .filter(([key, value]) => key !== 'schemaVersion' && value === true).length;
  const { status: imageCapabilityStatus, guidance: imageCapabilityGuidance } = imageCapability(mind);
  const imageAttachmentsUnavailable = imageCapabilityStatus === 'unsupported';
  const setupSaving = profileSaving || capabilitiesSaving;
  const conversationItems = buildConversationItems(events || [], showActivity);
  const openPanel = (panel) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.set('panel', panel);
    next.delete('view');
    next.delete('event');
    return next;
  });
  const closePanel = () => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.delete('panel');
    next.delete('view');
    return next;
  });
  const selectEvent = (eventId) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.set('event', eventId);
    next.delete('panel');
    next.delete('view');
    return next;
  });
  const closeSelectedEvent = () => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.delete('event');
    return next;
  });

  return (
    <section aria-labelledby="mind-heading" className="mx-auto max-w-[100rem] space-y-4 pb-4">
      <header className="flex flex-col gap-3 rounded-2xl border border-port-border bg-port-card/70 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-port-accent/15 text-port-accent ring-1 ring-port-accent/30">
            <Brain size={23} aria-hidden="true" />
            <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-port-card ${state?.started && !isPaused ? 'bg-port-success' : 'bg-port-text-muted'}`} aria-hidden="true" />
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
          {!state?.started && <ActionButton label={profileReady ? 'Start' : 'Configure'} icon={profileReady ? CirclePlay : Settings2} pending={profileReady && lifecyclePending === 'start'} disabled={loading || setupSaving} onClick={() => (profileReady ? runLifecycle('start') : openPanel('settings'))} />}
          {state?.started && !isPaused && <ActionButton label="Pause" icon={CirclePause} pending={lifecyclePending === 'pause'} onClick={() => runLifecycle('pause')} />}
          {state?.started && isPaused && <ActionButton label="Resume" icon={CirclePlay} pending={lifecyclePending === 'resume'} onClick={() => runLifecycle('resume')} />}
          {state?.started && <ActionButton label="Stop" icon={Square} pending={lifecyclePending === 'stop'} onClick={() => runLifecycle('stop')} />}
          <ActionButton label="Reload" icon={RefreshCw} pending={loading || runtimeLoading} onClick={() => {
            void loadHistory({ reset: true });
            void loadRuntime();
            void loadVisibility({ refresh: true });
          }} />
        </div>
      </header>

      {gap && <Banner tone="warning" title="History gap detected">The saved cursor is no longer retained. The visible trace was reloaded from the newest bounded snapshot.</Banner>}
      {loadError && <Banner tone="error" title="Conversation unavailable">{loadError}. Existing messages are preserved; retry when the connection recovers.</Banner>}
      {lifecycleError && <Banner tone="error" title="Action failed">{lifecycleError}</Banner>}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section data-testid="mind-chat" aria-label="Persistent mind chat" className="flex h-[68dvh] min-h-[30rem] max-h-[54rem] flex-col overflow-hidden rounded-[1.5rem] border border-port-border bg-port-card shadow-lg shadow-black/10 sm:min-h-[34rem]">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-port-border bg-port-card/95 px-3 py-2.5 sm:px-4">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-port-accent/15 text-port-accent">
                <Brain size={19} aria-hidden="true" />
                <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-port-card ${state?.started && !isPaused ? 'bg-port-success' : 'bg-port-text-muted'}`} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-port-text">Chief of Staff</h3>
                <p className="truncate text-[11px] text-port-text-muted">
                  {state?.pauseReason || (state?.status === 'thinking' ? <MindTypingIndicator /> : state?.started ? 'Available' : 'Not started')}
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
            {messageImageError && <p role="alert" className="mt-2 text-sm text-port-error">{messageImageError}</p>}
            {imageAttachmentsUnavailable && (
              <p className="mt-2 text-xs text-port-text-muted">
                Image attachments are unavailable for this Mind profile. {imageCapabilityGuidance || 'Choose a vision-capable provider or model in'}{' '}
                <Link to="/settings?tab=providers" className="text-port-accent underline">Settings</Link>.
              </p>
            )}
            {messageImages.length > 0 && (
              <ul aria-label="Attached images" className="mt-2 flex flex-wrap gap-2">
                {messageImages.map((image) => (
                  <li key={image.attachmentId} className="relative h-16 w-16 overflow-hidden rounded-lg border border-port-border bg-port-bg">
                    <MindImage image={image} className="h-full w-full object-cover" />
                    <button type="button" onClick={() => void removeMessageImage(image)} disabled={submitting || messageImagesUploading} aria-label={`Remove ${image.originalName}`} className="absolute right-1 top-1 rounded-full bg-port-bg/90 p-1 text-port-text shadow disabled:opacity-50">
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-end gap-2 rounded-[1.35rem] border border-port-border bg-port-bg p-1.5 pl-3 focus-within:border-port-accent/70 focus-within:ring-1 focus-within:ring-port-accent/30">
              <FilePickerButton
                accept={UPLOAD_IMAGE_ACCEPT}
                multiple
                onChange={(event) => uploadMessageImages(event.target.files)}
                disabled={submitting || messageImagesUploading || imageAttachmentsUnavailable || messageImages.length >= MAX_MESSAGE_IMAGES}
                ariaLabel="Attach images"
                title={imageAttachmentsUnavailable ? 'Image attachments are unavailable for this profile' : 'Attach images'}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-port-text-muted hover:bg-port-border/50 hover:text-port-text"
              >
                {messageImagesUploading ? <RefreshCw size={17} className="animate-spin" aria-hidden="true" /> : <ImagePlus size={18} aria-hidden="true" />}
              </FilePickerButton>
              <label htmlFor="mind-input-text" className="sr-only">Message</label>
              <textarea id="mind-input-text" value={messageText} onChange={(event) => changeMessageText(event.target.value)} onKeyDown={handleMessageKeyDown} maxLength={8000} rows={1} className="min-h-[36px] max-h-32 flex-1 resize-y bg-transparent py-2 text-sm leading-5 text-port-text outline-none placeholder:text-port-text-muted" placeholder="Message Persistent Mind" />
              <button type="submit" disabled={(!messageText.trim() && messageImages.length === 0) || submitting || messageImagesUploading} aria-label={submitting ? 'Sending message' : submitError ? 'Retry' : 'Send message'} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-port-accent text-white transition-colors hover:bg-port-accent/85 disabled:cursor-not-allowed disabled:bg-port-border disabled:text-port-text-muted">
                {submitting ? <RefreshCw size={17} className="animate-spin" aria-hidden="true" /> : <ArrowUp size={19} strokeWidth={2.5} aria-hidden="true" />}
              </button>
            </div>
          </form>
        </section>

        <aside aria-labelledby="mind-state-heading" className="space-y-3 xl:sticky xl:top-0">
          <section className="rounded-2xl border border-port-border bg-port-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-port-text-muted">Live workspace</p>
                <h3 id="mind-state-heading" className="mt-1 text-base font-semibold text-port-text">Mind state</h3>
              </div>
              <span className={`h-2.5 w-2.5 rounded-full ${state?.status === 'thinking' ? 'animate-pulse bg-port-accent' : state?.started && !isPaused ? 'bg-port-success' : 'bg-port-text-muted'}`} aria-hidden="true" />
            </div>
            <p className="mt-3 text-sm text-port-text-muted">
              {state?.status === 'thinking' ? 'Working through the current turn.' : state?.pauseReason || (state?.started ? 'Listening for messages and scheduled wakes.' : 'Configure the AI profile to begin.')}
            </p>
            {state?.queuedMessageCount > 0 && <p className="mt-2 text-xs font-medium text-port-accent">{state.queuedMessageCount} queued message{state.queuedMessageCount === 1 ? '' : 's'}</p>}
            {state?.started && state?.nextWakeAt && (
              <button
                type="button"
                onClick={() => openPanel('settings')}
                aria-label="Configure wake cadence"
                className="mt-2 block rounded text-left text-xs text-port-text-muted hover:text-port-accent focus:outline-none focus:ring-2 focus:ring-port-accent/50"
              >
                Next wake <time dateTime={state.nextWakeAt} className="font-medium text-port-text">{formatDateTime(state.nextWakeAt)}</time> · {timeUntil(state.nextWakeAt)}
              </button>
            )}
          </section>

          <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
            <MindStateButton icon={Brain} label="Context" value={runtime?.context?.approximateTokens == null ? 'Unavailable' : `~${runtime.context.approximateTokens.toLocaleString()} tokens`} detail={`${runtime?.context?.chars?.toLocaleString() || '—'} characters`} onClick={() => openPanel('context')} />
            <MindStateButton icon={Database} label="Memories" value={runtime?.context?.memoryCount == null ? 'Unavailable' : `${runtime.context.memoryCount} accessible`} detail="Created and curated" onClick={() => openPanel('memories')} />
            <MindStateButton icon={Eraser} label="Cleanup" value={mind?.capabilities?.manageMind ? 'Self-maintenance on' : 'User controlled'} detail="Memories, history, and context" onClick={() => openPanel('maintenance')} />
            <MindStateButton icon={Wrench} label="Tools" value={grantedCapabilityCount > 0 ? `${grantedCapabilityCount} grant${grantedCapabilityCount === 1 ? '' : 's'} enabled` : 'No grants'} detail="Narrow, typed authority" onClick={() => openPanel('tools')} />
            <MindStateButton icon={Cpu} label="Settings" value={runtime?.inference?.active ? 'Running now' : runtime?.inference?.residency?.status === 'loaded' ? 'Loaded in memory' : 'Not running'} detail={runtime?.inference?.model || mind?.profile?.model || 'Not configured'} onClick={() => openPanel('settings')} />
          </div>

          {(runtimeError || visibilityError) && <p className="rounded-xl border border-port-warning/40 bg-port-warning/10 p-3 text-xs text-port-warning">Some live status is delayed. The last successful snapshot remains visible.</p>}
        </aside>
      </div>

      <Drawer
        open={Boolean(activePanel)}
        onClose={closePanel}
        title="Mind workspace"
        subtitle="Inspect and configure the state available to Persistent Mind"
        size="xl"
        closeLabel="Close mind workspace"
        closeOnEsc={false}
        closeOnBackdrop={false}
      >
        <div className="mb-4">
          <TabPills tabs={MIND_PANEL_TABS} activeTab={activePanel || 'context'} onChange={openPanel} variant="pills" size="sm" mobileDropdown ariaLabel="Mind workspace sections" />
        </div>
        {(visitedPanels.has('context') || activePanel === 'context') && <div hidden={activePanel !== 'context'} className="space-y-4">
          <PersistentMindRuntimePanel runtime={runtime} error={runtimeError} loading={runtimeLoading} />
          <PersistentMindVisibilityPanel visibility={visibility} error={visibilityError} loading={visibilityLoading} onRefresh={() => loadVisibility({ refresh: true })} />
          <PersistentMindContextPanel view="context" refreshKey={contextRefreshKey} />
        </div>}
        {(visitedPanels.has('memories') || activePanel === 'memories') && <div hidden={activePanel !== 'memories'}>
          <PersistentMindContextPanel view="memories" refreshKey={contextRefreshKey} onMemoriesChanged={() => setContextRefreshKey((current) => current + 1)} />
        </div>}
        {(visitedPanels.has('maintenance') || activePanel === 'maintenance') && <div hidden={activePanel !== 'maintenance'}>
          <PersistentMindMaintenancePanel
            selfCleanupEnabled={mind?.capabilities?.manageMind === true}
            onOpenTools={() => openPanel('tools')}
            onCleaned={handleMindspaceCleaned}
          />
        </div>}
        {(visitedPanels.has('tools') || activePanel === 'tools') && <div hidden={activePanel !== 'tools'}>
          <PersistentMindTools onCapabilitiesChange={(capabilities) => setMind((current) => current ? { ...current, capabilities } : current)} onSavingChange={setCapabilitiesSaving} />
        </div>}
        {(visitedPanels.has('settings') || activePanel === 'settings') && <section hidden={activePanel !== 'settings'} aria-labelledby="mind-profile-heading" className="rounded border border-port-border bg-port-card p-4">
          <div className="mb-3">
            <h3 id="mind-profile-heading" className="text-sm font-semibold text-port-text">AI profile</h3>
            <p className="mt-1 text-xs text-port-text-muted">Pin the provider, model, effort, and wake cadence. Changes apply to the next wake and never silently fall back to another model.</p>
          </div>
          <PersistentMindProfileControls
            profile={mind?.profile}
            disabled={!mind}
            onSaved={(profile) => setMind((current) => current ? { ...current, profile } : current)}
            onSavingChange={setProfileSaving}
          />
          {!state?.started && (
            <div className="mt-4 flex flex-col gap-2 border-t border-port-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-port-text-muted">{setupSaving ? 'Saving persistent mind settings…' : profileReady ? 'The saved AI profile is ready.' : 'Enable the profile and select both an AI provider and model to start.'}</p>
              <ActionButton label="Start persistent mind" icon={CirclePlay} pending={lifecyclePending === 'start'} disabled={loading || setupSaving || !profileReady} onClick={() => runLifecycle('start')} />
            </div>
          )}
        </section>}
      </Drawer>

      <Drawer
        open={Boolean(selectedEventId)}
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
              {eventText(selectedEvent) && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-port-text">{eventText(selectedEvent)}</p>}
              <MessageImages images={safeMessageImages(selectedEvent)} />
              {!eventText(selectedEvent) && safeMessageImages(selectedEvent).length === 0 && <p className="mt-2 text-sm text-port-text">{selectedEvent.kind}</p>}
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

function MindStateButton({ icon: Icon, label, value, detail, onClick }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="group rounded-2xl border border-port-border bg-port-card p-3 text-left transition-colors hover:border-port-accent/60 hover:bg-port-accent/5">
      <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-port-text-muted group-hover:text-port-accent">
        <Icon size={14} aria-hidden="true" /> {label}
      </span>
      <span className="mt-2 block text-sm font-semibold text-port-text">{value}</span>
      <span className="mt-0.5 block truncate text-xs text-port-text-muted">{detail}</span>
    </button>
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
        <MessageImages images={safeMessageImages(event)} compact />
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

function MindImage({ image, className = '' }) {
  const [missing, setMissing] = useState(false);
  if (missing || !image?.path) {
    return <span role="img" aria-label={`${image?.originalName || 'Image'} is unavailable`} className={`flex items-center justify-center bg-port-bg p-1 text-center text-[10px] text-port-text-muted ${className}`}>Image unavailable</span>;
  }
  return <img src={image.path} alt={image.originalName || 'Attached image'} onError={() => setMissing(true)} className={className} />;
}

function MessageImages({ images, compact = false }) {
  if (images.length === 0) return null;
  return (
    <ul aria-label={`${images.length} attached image${images.length === 1 ? '' : 's'}`} className={`flex flex-wrap gap-2 ${compact ? 'border-t border-white/20 px-3.5 py-2.5' : 'mt-3'}`}>
      {images.map((image) => (
        <li key={image.attachmentId} className={compact ? 'h-20 w-20 overflow-hidden rounded-lg bg-port-bg/20' : 'overflow-hidden rounded-lg border border-port-border bg-port-bg'}>
          <MindImage image={image} className={compact ? 'h-full w-full object-cover' : 'max-h-64 max-w-full object-contain'} />
          {!compact && <p className="border-t border-port-border px-2 py-1 text-xs text-port-text-muted">{image.originalName}</p>}
        </li>
      ))}
    </ul>
  );
}

function ActionButton({ label, icon: Icon, pending = false, disabled = false, onClick }) {
  return (
    <button type="button" disabled={pending || disabled} onClick={onClick} className="flex min-h-[36px] items-center gap-2 rounded border border-port-border px-3 py-1.5 text-sm text-port-text hover:bg-port-border/30 disabled:cursor-not-allowed disabled:opacity-50">
      <Icon size={16} className={pending ? 'animate-spin' : ''} aria-hidden="true" /> {pending ? `${label}…` : label}
    </button>
  );
}
