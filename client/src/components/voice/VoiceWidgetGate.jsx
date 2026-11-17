import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import socket from '../../services/socket';
import { getVoiceConfig } from '../../services/apiVoice';
import { ENGAGE_EVENT, DISENGAGE_EVENT, readVoiceHidden, writeVoiceHidden } from '../../services/voiceVisibility';
import { isPushToTalkKey } from '../../lib/a11yKeyboard';
import { importWithRetry } from '../../utils/lazyWithReload';
import { isStaleChunkError, reloadOnceForStaleChunk } from '../../utils/staleChunkReload';
import useMounted from '../../hooks/useMounted';
import toast from '../ui/Toast';

// Voice is off by default, so the voice stack (`VoiceWidget`, `voiceClient`,
// the fast path, the DOM index, the audio helpers) stays out of the cold-load
// bundle: this gate is the only voice code the app shell imports statically,
// and it loads the widget chunk the first time voice is on. `entryClosure.test.js`
// fails if a static import puts that stack back on first paint.
//
// The gate is the single owner of the voice config read and of the
// `voice:config:changed` subscription. `VoiceToggleButton` reads `enabled`
// from its context and the widget takes the whole config as a prop, so neither
// fetches or subscribes for itself.

const DISABLED_CONFIG = {
  enabled: false,
  hotkey: 'Space',
  sttEngine: 'whisper',
  sttLanguage: 'en',
  fastPath: null,
  personality: null,
  tts: {},
};

const VoiceEnabledContext = createContext(false);

/** Whether voice mode is on. False until the gate's config read answers. */
export const useVoiceEnabled = () => useContext(VoiceEnabledContext);

// `updated` names the fields a `voice:config:changed` event already set, which
// the bootstrap read must not overwrite: an event can overtake that read.
// Personality only ever arrives with the read.
const hydrate = (previous, cfg, updated) => {
  const engine = cfg?.tts?.engine;
  return {
    enabled: updated.has('enabled') ? previous.enabled : !!cfg?.enabled,
    hotkey: updated.has('hotkey') ? previous.hotkey : cfg?.hotkey || 'Space',
    sttEngine: !updated.has('sttEngine') && cfg?.stt?.engine ? cfg.stt.engine : previous.sttEngine,
    sttLanguage: !updated.has('sttLanguage') && cfg?.stt?.language ? cfg.stt.language : previous.sttLanguage,
    fastPath: updated.has('fastPath') ? previous.fastPath : cfg?.llm?.fastPath || null,
    personality: cfg?.llm?.personality || null,
    tts: updated.has('tts')
      ? previous.tts
      : { engine, voice: engine ? cfg?.tts?.[engine]?.voice : undefined, rate: cfg?.tts?.rate },
  };
};

// The event carries only the fields Settings > Voice broadcasts; an absent key
// leaves the current value alone.
const changedFields = (cfg) => {
  const patch = {};
  if (typeof cfg?.enabled === 'boolean') patch.enabled = cfg.enabled;
  if (cfg?.hotkey) patch.hotkey = cfg.hotkey;
  if (cfg?.sttEngine) patch.sttEngine = cfg.sttEngine;
  if (cfg?.sttLanguage) patch.sttLanguage = cfg.sttLanguage;
  if ('fastPath' in (cfg || {})) patch.fastPath = cfg.fastPath || null;
  if (cfg?.ttsEngine) patch.tts = { engine: cfg.ttsEngine, voice: cfg.ttsVoice, rate: cfg.ttsRate };
  return patch;
};

const loadVoiceWidget = () => importWithRetry(() => import('./VoiceWidget'));

export default function VoiceWidgetGate({ children }) {
  const [config, setConfig] = useState(DISABLED_CONFIG);
  const [Widget, setWidget] = useState(null);
  const mountedRef = useMounted();
  const loadRequestedRef = useRef(false);
  // A start asked for while the widget chunk is still loading. The widget
  // claims it once, after it mounts; nothing else may start capture from it.
  const pendingStartRef = useRef(false);

  useEffect(() => {
    const updated = new Set();
    let active = true;
    let reading = false;
    let hydrated = false;
    const read = () => {
      if (reading || hydrated) return;
      reading = true;
      getVoiceConfig()
        .then((cfg) => {
          if (!active) return;
          hydrated = true;
          setConfig((previous) => hydrate(previous, cfg, updated));
        })
        .catch(() => {})
        .finally(() => { reading = false; });
    };
    const onChanged = (cfg) => {
      const patch = changedFields(cfg);
      const fields = Object.keys(patch);
      if (fields.length === 0) return;
      for (const field of fields) updated.add(field);
      setConfig((previous) => ({ ...previous, ...patch }));
    };
    read();
    socket.on('voice:config:changed', onChanged);
    // A failed read leaves voice looking disabled and nothing voice-related
    // loaded, so the server coming back is the point to ask again. No-op once
    // a read has answered.
    socket.on('connect', read);
    return () => {
      active = false;
      socket.off('voice:config:changed', onChanged);
      socket.off('connect', read);
    };
  }, []);

  const requestWidget = useCallback(() => {
    if (loadRequestedRef.current) return;
    loadRequestedRef.current = true;
    loadVoiceWidget().then(
      (mod) => {
        if (mountedRef.current) setWidget(() => mod.default);
      },
      async (err) => {
        // Not latched: the next start request or enable event tries again.
        loadRequestedRef.current = false;
        if (isStaleChunkError(err, { duringImport: true }) && await reloadOnceForStaleChunk()) return;
        console.warn(`⚠️ voice widget failed to load: ${err?.message || err}`);
        if (!mountedRef.current || !pendingStartRef.current) return;
        pendingStartRef.current = false;
        toast.error('Voice controls could not load. Try again.');
      },
    );
  }, [mountedRef]);

  const { enabled, hotkey } = config;

  useEffect(() => {
    if (enabled) requestWidget();
    // Turning voice off withdraws a start nobody has claimed yet, so it cannot
    // open the mic whenever voice is next turned on.
    else pendingStartRef.current = false;
  }, [enabled, requestWidget]);

  // Until the widget mounts and listens for itself, hold a start request here
  // so it survives the chunk load. These listeners detach in the same commit
  // that attaches the widget's own, so a request is heard exactly once.
  useEffect(() => {
    if (Widget) return undefined;
    const onEngage = () => {
      pendingStartRef.current = true;
      requestWidget();
    };
    const onDisengage = () => { pendingStartRef.current = false; };
    window.addEventListener(ENGAGE_EVENT, onEngage);
    window.addEventListener(DISENGAGE_EVENT, onDisengage);
    return () => {
      window.removeEventListener(ENGAGE_EVENT, onEngage);
      window.removeEventListener(DISENGAGE_EVENT, onDisengage);
    };
  }, [Widget, requestWidget]);

  // The push-to-talk hotkey is a toggle, so over the same window a second
  // press withdraws the request, as it would stop a live capture.
  useEffect(() => {
    if (Widget || !enabled) return undefined;
    const onKey = (event) => {
      if (!isPushToTalkKey(event, hotkey)) return;
      event.preventDefault();
      if (readVoiceHidden()) writeVoiceHidden(false);
      pendingStartRef.current = !pendingStartRef.current;
      requestWidget();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [Widget, enabled, hotkey, requestWidget]);

  const claimPendingStart = useCallback(() => {
    const pending = pendingStartRef.current;
    pendingStartRef.current = false;
    return pending;
  }, []);

  return (
    <VoiceEnabledContext.Provider value={enabled}>
      {children}
      {Widget && <Widget config={config} claimPendingStart={claimPendingStart} />}
    </VoiceEnabledContext.Provider>
  );
}
