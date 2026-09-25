import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAutoRefetch } from '../../../hooks/useAutoRefetch.js';
import useMounted from '../../../hooks/useMounted';
import useProviderModels from '../../../hooks/useProviderModels';
import { useSocket } from '../../../hooks/useSocket';
import { uuidv4 } from '../../../lib/uuid.js';
import * as api from '../../../services/api';
import { readFileAsBase64, validateImageFile } from '../../../utils/fileUpload';
import { findMindThinkingPreset } from '../../../lib/mindThinkingPresets.js';
import { describeMindTurnProgress } from '../../../lib/mindTurnProgress.js';
import MindHeader from './MindHeader.jsx';
import MindConversationPanel from './MindConversationPanel.jsx';
import MindStateSidebar from './MindStateSidebar.jsx';
import MindWorkspaceDrawers from './MindWorkspaceDrawers.jsx';
import { eventText, MAX_MESSAGE_IMAGES } from './MindPanelParts.jsx';

const PAGE_LIMIT = 200;
const MAX_BACKFILL_PAGES = 5;
const MAX_VISIBLE_EVENTS = PAGE_LIMIT * MAX_BACKFILL_PAGES;
const MAX_MESSAGE_IMAGE_BYTES = 10 * 1024 * 1024;
// Stable empties: these feed child props and effect dependencies, so a fresh
// literal on every render would re-fire work that has nothing new to do.
const NO_PRESETS = Object.freeze([]);
const NO_TURN_EXECUTIONS = Object.freeze([]);
const MIND_PANELS = new Set(['context', 'journal', 'memories', 'maintenance', 'tools', 'models', 'settings']);
// Bookkeeping the conversation does not need. `mind.summary` is the rollup that
// compacts older trajectory into context — it recaps the mind's own history, so
// rendering it as a bubble makes every wake open with a wall of recap. It stays
// reachable through the Activity toggle and the event detail panel.
const ACTIVITY_KINDS = new Set([
  'mind.wake', 'mind.model.request', 'mind.model.result', 'mind.turn.completed', 'mind.summary',
]);

const imageCapability = (mind) => {
  const capability = mind?.imageCapability;
  const status = ['supported', 'unsupported', 'unknown'].includes(capability?.status)
    ? capability.status
    : 'unknown';
  return { status, guidance: typeof capability?.guidance === 'string' ? capability.guidance : null };
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
  const legacyView = searchParams.get('view');
  const requestedPanel = searchParams.get('panel') || (legacyView === 'setup' ? 'settings' : legacyView);
  const activePanel = MIND_PANELS.has(requestedPanel) ? requestedPanel : null;
  // Composer selection, preset editor, and inspected session all live in the
  // URL: an armed alternate model is shareable and survives a reload, and
  // clearing it after a send is one navigation rather than hidden state that
  // could drift from what the next message will actually use.
  const selectedPresetId = searchParams.get('preset') || null;
  const editingPresetId = searchParams.get('presetEdit');
  const selectedTurnId = searchParams.get('turn') || null;
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
  const [presetsSaving, setPresetsSaving] = useState(false);
  const [contextRefreshKey, setContextRefreshKey] = useState(0);
  const [visitedPanels, setVisitedPanels] = useState(() => new Set(activePanel ? [activePanel] : []));
  const [showActivity, setShowActivity] = useState(false);
  const [runtime, setRuntime] = useState(null);
  const [runtimeError, setRuntimeError] = useState(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [visibility, setVisibility] = useState(null);
  const [visibilityError, setVisibilityError] = useState(null);
  const [visibilityLoading, setVisibilityLoading] = useState(true);
  // FaceTime Audio call state — broadcast from callSession.js regardless of
  // which tab (if any) is the call host, so this chip shows/hides even when
  // the audio itself is carried by /voice/call-host in another tab.
  const [callState, setCallState] = useState(null);
  const [hangingUp, setHangingUp] = useState(false);
  // Read-only catalog: it classifies a route as machine-local or
  // account-backed before the user commits. Never a provider probe.
  const { providers } = useProviderModels({ allowDefault: true, silent: true });
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
  // `undefined` = the in-flight draft has not frozen a route yet; `null` = it
  // deliberately froze "no preset". A plain null would conflate the two and let
  // a retry silently re-resolve a selection the user had since changed.
  const messageDraftPresetRef = useRef(undefined);
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
          identity: response.identity,
          state: response.state,
          profile: response.profile,
          capabilities: response.capabilities,
          imageCapability: response.imageCapability,
          autonomyMode: response.autonomyMode,
          thinkingRequests: response.thinkingRequests,
          thinkingPresets: response.thinkingPresets?.presets || NO_PRESETS,
          turnExecutions: response.turnExecutions || NO_TURN_EXECUTIONS,
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
    if (refresh || !visibilityLoadedRef.current) setVisibilityLoading(true);
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
  useAutoRefetch(loadRuntime, 10_000, { pollOnly: true });
  useAutoRefetch(loadVisibility, 30_000, { pollOnly: true });

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
    const onCallState = (snapshot) => setCallState(snapshot?.error ? null : snapshot);
    socket.on('voice:call:state', onCallState);
    return () => socket.off('voice:call:state', onCallState);
  }, [socket]);

  // No ack — the chip's own next `voice:call:state` broadcast (active: false)
  // is the actual confirmation, same as the call-host page's own hangup.
  const hangUpCall = useCallback(() => {
    setHangingUp(true);
    socket.emit('voice:call:hangup');
  }, [socket]);

  useEffect(() => {
    if (!callState?.active) setHangingUp(false);
  }, [callState?.active]);

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
    // A selection whose preset has since disappeared is refused here rather
    // than sent without it: falling through to the home profile would answer on
    // exactly the model the user was deliberately stepping away from.
    if (selectedPresetId && !selectedPreset) {
      setSubmitError('That thinking preset is no longer saved. Choose another or return to the default profile.');
      return;
    }
    const id = messageDraftIdRef.current || mintId('message');
    messageDraftIdRef.current = id;
    const images = messageDraftImagesRef.current || messageImages;
    messageDraftImagesRef.current = images;
    // The route is frozen with the draft, so a duplicate click or a transport
    // retry re-submits the id AND the route the user approved — the server's
    // fingerprint covers both, so a changed selection would otherwise read as a
    // different, separately-billable request under a reused id.
    if (messageDraftPresetRef.current === undefined) {
      messageDraftPresetRef.current = selectedPreset
        ? {
          id: selectedPreset.id,
          label: selectedPreset.label,
          providerId: selectedPreset.providerId,
          model: selectedPreset.model,
          effort: selectedPreset.effort || '',
        }
        : null;
    }
    const thinkingPreset = messageDraftPresetRef.current;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.sendPersistentMindMessage({
        id,
        text: trimmed,
        ...(images.length > 0 ? { images: images.map((image) => image.attachmentId) } : {}),
        ...(thinkingPreset ? { thinkingPresetId: thinkingPreset.id, thinkingPreset } : {}),
      }, { silent: true });
      stickToBottomRef.current = true;
      appendLocalInput({ id, content: trimmed, inputKind: 'message', images });
      setMessageText('');
      setMessageImages([]);
      messageDraftIdRef.current = null;
      messageDraftImagesRef.current = null;
      messageDraftPresetRef.current = undefined;
      // One message, one authorization: the composer returns to the default
      // route so the next message and every scheduled wake use the home profile.
      if (thinkingPreset) clearPresetSelection();
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

  const resetMessageDraft = () => {
    messageDraftIdRef.current = null;
    messageDraftImagesRef.current = null;
    messageDraftPresetRef.current = undefined;
  };

  const changeMessageText = (next) => {
    if (submitError) {
      resetMessageDraft();
      setSubmitError(null);
    }
    setMessageText(next);
  };

  const changeMessageImages = (next) => {
    if (submitError) {
      resetMessageDraft();
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
    if (event.key !== 'Enter' || event.altKey || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
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
    if (lifecyclePending) return;
    setLifecyclePending(action);
    setLifecycleError(null);
    try {
      if (action === 'wake') await api.wakePersistentMind({ silent: true });
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
  // Derived from the runtime snapshot, whose freshness numbers are measured
  // against the SERVER clock — so elapsed/heartbeat never subtract a browser
  // clock from a server timestamp, and both refresh on the existing 10s
  // runtime poll plus every socket-driven reload.
  const turnProgress = describeMindTurnProgress({ state, runtime, events });
  const selectedEvent = events?.find((event) => event.eventId === selectedEventId) || null;
  const isPaused = state?.status === 'paused';
  const profileReady = Boolean(mind?.profile?.enabled && mind.profile.providerId && mind.profile.model);
  const grantedCapabilityCount = Object.entries(mind?.capabilities || {})
    .filter(([key, value]) => key !== 'schemaVersion' && value === true).length;
  const { status: imageCapabilityStatus, guidance: imageCapabilityGuidance } = imageCapability(mind);
  const imageAttachmentsUnavailable = imageCapabilityStatus === 'unsupported';
  const setupSaving = profileSaving || capabilitiesSaving || presetsSaving;
  const conversationItems = buildConversationItems(events || [], showActivity);
  const thinkingPresets = mind?.thinkingPresets || NO_PRESETS;
  const turnExecutions = mind?.turnExecutions || NO_TURN_EXECUTIONS;
  const selectedPreset = findMindThinkingPreset(thinkingPresets, selectedPresetId);
  // Panel-scoped selections (the open preset editor, the inspected session) are
  // dropped whenever the panel they render in goes away; the composer's armed
  // preset is NOT — it belongs to the message being written, not to a panel.
  const clearPanelSelections = (params) => {
    params.delete('presetEdit');
    params.delete('turn');
  };
  const openPanel = (panel) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.set('panel', panel);
    next.delete('view');
    next.delete('event');
    clearPanelSelections(next);
    return next;
  });
  const closePanel = () => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.delete('panel');
    next.delete('view');
    clearPanelSelections(next);
    return next;
  });
  const selectEvent = (eventId) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.set('event', eventId);
    next.delete('panel');
    next.delete('view');
    clearPanelSelections(next);
    return next;
  });
  const setMindParam = (key, value) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    if (value === null) next.delete(key);
    else next.set(key, value);
    return next;
  });
  const clearPresetSelection = () => setMindParam('preset', null);
  // Changing the armed route retires the in-flight draft id: the server's retry
  // fingerprint covers the selection, so reusing one id across two routes is a
  // different request wearing the same idempotency key.
  const selectPreset = (presetId) => {
    if (submitting) return;
    resetMessageDraft();
    setSubmitError(null);
    setMindParam('preset', presetId || null);
  };
  const inspectSession = (turnId) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.set('panel', 'models');
    next.delete('view');
    next.delete('event');
    next.delete('presetEdit');
    if (turnId === null) next.delete('turn');
    else next.set('turn', turnId);
    return next;
  });
  const closeSelectedEvent = () => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    next.delete('event');
    return next;
  });

  const prepareRepair = (workspace) => {
    changeMessageText(`${messageText ? `${messageText}\n\n` : ''}Investigate workspace diagnostics for ${workspace.appName} (app ID: ${workspace.appId}). Use a CoS agent task to diagnose and resolve the reported setup issues: ${(workspace.preflight?.warnings || []).map((warning) => warning.message).join(' ')} Do not require the failing checks before queueing the repair itself. Preserve local changes and verify the required checks after repair.`);
    closePanel();
    document.getElementById('mind-input-text')?.focus();
  };
  const refreshContext = () => setContextRefreshKey((current) => current + 1);
  const updateCapabilities = (capabilities) => setMind((current) => current ? { ...current, capabilities } : current);
  const saveThinkingRequests = (capabilities) => setMind((current) => ({ ...current, capabilities }));
  const cancelThinkingRequest = () => setMind((current) => ({ ...current, thinkingRequests: { ...current.thinkingRequests, pending: null } }));
  const saveThinkingPresets = (presets) => setMind((current) => current ? { ...current, thinkingPresets: presets } : current);
  const saveProfile = (profile) => setMind((current) => current ? { ...current, profile } : current);

  return (
    <section aria-labelledby="mind-heading" className="mx-auto flex h-full min-h-0 w-full max-w-[100rem] flex-col gap-4 pb-4 xl:pb-0">
      <MindHeader
        state={state}
        isPaused={isPaused}
        mind={mind}
        turnProgress={turnProgress}
        runtime={runtime}
        profileReady={profileReady}
        lifecyclePending={lifecyclePending}
        loading={loading}
        setupSaving={setupSaving}
        runLifecycle={runLifecycle}
        openPanel={openPanel}
        runtimeLoading={runtimeLoading}
        visibilityLoading={visibilityLoading}
        loadHistory={loadHistory}
        loadRuntime={loadRuntime}
        loadVisibility={loadVisibility}
        callState={callState}
        hangUpCall={hangUpCall}
        hangingUp={hangingUp}
        gap={gap}
        loadError={loadError}
        lifecycleError={lifecycleError}
      />
      <div className="grid min-h-0 flex-1 items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <MindConversationPanel
          turnProgress={turnProgress}
          showActivity={showActivity}
          setShowActivity={setShowActivity}
          messageListRef={messageListRef}
          loading={loading}
          events={events}
          conversationItems={conversationItems}
          loadError={loadError}
          selectedEventId={selectedEventId}
          selectEvent={selectEvent}
          submitMessage={submitMessage}
          submitError={submitError}
          messageImageError={messageImageError}
          imageAttachmentsUnavailable={imageAttachmentsUnavailable}
          imageCapabilityGuidance={imageCapabilityGuidance}
          messageImages={messageImages}
          removeMessageImage={removeMessageImage}
          submitting={submitting}
          messageImagesUploading={messageImagesUploading}
          thinkingPresets={thinkingPresets}
          providers={providers}
          selectedPresetId={selectedPresetId}
          selectPreset={selectPreset}
          openPanel={openPanel}
          isPaused={isPaused}
          uploadMessageImages={uploadMessageImages}
          messageText={messageText}
          changeMessageText={changeMessageText}
          handleMessageKeyDown={handleMessageKeyDown}
          selectedPreset={selectedPreset}
        />
        <MindStateSidebar
          turnProgress={turnProgress}
          state={state}
          isPaused={isPaused}
          openPanel={openPanel}
          mind={mind}
          providers={providers}
          thinkingPresets={thinkingPresets}
          turnExecutions={turnExecutions}
          selectedPresetId={selectedPresetId}
          selectPreset={selectPreset}
          runLifecycle={runLifecycle}
          lifecyclePending={lifecyclePending}
          inspectSession={inspectSession}
          runtime={runtime}
          grantedCapabilityCount={grantedCapabilityCount}
          visibility={visibility}
          runtimeError={runtimeError}
          visibilityError={visibilityError}
        />
      </div>
      <MindWorkspaceDrawers
        activePanel={activePanel}
        closePanel={closePanel}
        visitedPanels={visitedPanels}
        openPanel={openPanel}
        runtime={runtime}
        runtimeError={runtimeError}
        runtimeLoading={runtimeLoading}
        visibility={visibility}
        visibilityError={visibilityError}
        visibilityLoading={visibilityLoading}
        loadVisibility={loadVisibility}
        prepareRepair={prepareRepair}
        contextRefreshKey={contextRefreshKey}
        refreshContext={refreshContext}
        mind={mind}
        handleMindspaceCleaned={handleMindspaceCleaned}
        updateCapabilities={updateCapabilities}
        setCapabilitiesSaving={setCapabilitiesSaving}
        thinkingPresets={thinkingPresets}
        editingPresetId={editingPresetId}
        setMindParam={setMindParam}
        setPresetsSaving={setPresetsSaving}
        saveThinkingRequests={saveThinkingRequests}
        cancelThinkingRequest={cancelThinkingRequest}
        saveThinkingPresets={saveThinkingPresets}
        turnExecutions={turnExecutions}
        providers={providers}
        selectedTurnId={selectedTurnId}
        setProfileSaving={setProfileSaving}
        saveProfile={saveProfile}
        state={state}
        setupSaving={setupSaving}
        profileReady={profileReady}
        lifecyclePending={lifecyclePending}
        loading={loading}
        runLifecycle={runLifecycle}
        selectedEventId={selectedEventId}
        closeSelectedEvent={closeSelectedEvent}
        selectedEvent={selectedEvent}
        eventActionPending={eventActionPending}
        acknowledge={acknowledge}
        promote={promote}
        submitAnnotation={submitAnnotation}
        annotationText={annotationText}
        changeAnnotationText={changeAnnotationText}
        annotationError={annotationError}
        annotationSubmitting={annotationSubmitting}
      />
    </section>
  );
}
