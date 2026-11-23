import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import socket from '../../services/socket';
import { readShellBootstrap } from '../../services/shellBootstrap.js';
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
const hydrate = (previous, cfg, updated) => {
  const engine = cfg?.tts?.engine;
  return {
    enabled: updated.has('enabled') ? previous.enabled : !!cfg?.enabled,
    hotkey: updated.has('hotkey') ? previous.hotkey : cfg?.hotkey || 'Space',
    sttEngine: !updated.has('sttEngine') && cfg?.stt?.engine ? cfg.stt.engine : previous.sttEngine,
    sttLanguage: !updated.has('sttLanguage') && cfg?.stt?.language ? cfg.stt.language : previous.sttLanguage,
    fastPath: updated.has('fastPath') ? previous.fastPath : cfg?.llm?.fastPath || null,
    personality: updated.has('personality') ? previous.personality : cfg?.llm?.usePersonality === false ? null : cfg?.llm?.personality || null,
    vad: updated.has('vad') ? previous.vad : cfg?.vad || null,
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
  if ('personality' in (cfg || {})) patch.personality = cfg.personality || null;
  if (cfg?.vad) patch.vad = cfg.vad;
  if (cfg?.ttsEngine) patch.tts = { engine: cfg.ttsEngine, voice: cfg.ttsVoice, rate: cfg.ttsRate };
  return patch;
};

const loadVoiceWidget = () => importWithRetry(() => import('./VoiceWidget'));

export default function VoiceWidgetGate({ children }) {
  const [config, setConfig] = useState(DISABLED_CONFIG);
  const [Widget, setWidget] = useState(null);
  const mountedRef = useMounted();
  const loadRequestedRef = useRef(false);
  // What the widget missed while its chunk was loading, kept as two separate
  // facts. `pendingStartRef`: the mic should open, asked for by the sidebar
  // mic, the hotkey or a dictation starting, and withdrawn by whatever would
  // stop a live capture. `heldDictationRef`: Daily Log dictation is on, which
  // the server says only once and which hiding the controls does not end.
  // The widget claims both once, after it mounts; nothing else may start
  // capture from them.
  const pendingStartRef = useRef(false);
  const heldDictationRef = useRef(false);

  useEffect(() => {
    const updated = new Set();
    let active = true;
    let reading = false;
    let hydrated = false;
    const read = () => {
      if (reading || hydrated) return;
      reading = true;
      readShellBootstrap('voiceConfig', () => getVoiceConfig())
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
        // The stale-build probe takes a moment. The latch stays set across
        // it, so a start requested meanwhile joins this attempt (and gets its
        // answer below) instead of starting a second import whose pending
        // start this handler would then throw away.
        if (isStaleChunkError(err, { duringImport: true }) && await reloadOnceForStaleChunk()) return;
        // Not latched from here: a reconnect or the next start request tries again.
        loadRequestedRef.current = false;
        console.warn(`⚠️ voice widget failed to load: ${err?.message || err}`);
        if (!mountedRef.current || !pendingStartRef.current) return;
        // A press is answered by this message. A start that dictation asked
        // for stays: dictation is still on at the server, so a later load
        // must still open the mic.
        pendingStartRef.current = heldDictationRef.current;
        toast.error('Voice controls could not load. Try again.');
      },
    );
  }, [mountedRef]);

  const { enabled, hotkey } = config;

  // Voice is on and the widget is not mounted yet: load it, and stand in for
  // its start controls until it listens for itself. These listeners detach in
  // the same commit that attaches the widget's own, so a request is heard
  // exactly once. While voice is off nothing here loads or listens.
  useEffect(() => {
    if (!enabled) {
      // Turning voice off withdraws whatever nobody has claimed yet, so it
      // cannot open the mic whenever voice is next turned on.
      pendingStartRef.current = false;
      heldDictationRef.current = false;
      return undefined;
    }
    if (Widget) return undefined;
    const onEngage = () => {
      pendingStartRef.current = true;
      requestWidget();
    };
    const onDisengage = () => { pendingStartRef.current = false; };
    // The push-to-talk hotkey is a toggle, so a second press withdraws the
    // request, as it would stop a live capture.
    const onKey = (event) => {
      if (!isPushToTalkKey(event, hotkey)) return;
      event.preventDefault();
      if (readVoiceHidden()) writeVoiceHidden(false);
      pendingStartRef.current = !pendingStartRef.current;
      requestWidget();
    };
    // Daily Log's Dictate button reaches the server without the widget, and
    // the widget is what opens the mic for it. In the widget, dictation
    // starting opens the mic and dictation ending stops it; the same here.
    const onDictation = (payload) => {
      const active = !!payload?.enabled;
      heldDictationRef.current = active;
      pendingStartRef.current = active;
      // A load that already failed is not in flight: this press retries it.
      if (active) requestWidget();
    };
    requestWidget();
    window.addEventListener(ENGAGE_EVENT, onEngage);
    window.addEventListener(DISENGAGE_EVENT, onDisengage);
    window.addEventListener('keydown', onKey);
    socket.on('voice:dictation', onDictation);
    // A chunk that failed to load is asked for again once the network is back.
    socket.on('connect', requestWidget);
    return () => {
      window.removeEventListener(ENGAGE_EVENT, onEngage);
      window.removeEventListener(DISENGAGE_EVENT, onDisengage);
      window.removeEventListener('keydown', onKey);
      socket.off('voice:dictation', onDictation);
      socket.off('connect', requestWidget);
    };
  }, [enabled, Widget, hotkey, requestWidget]);

  const claimHeld = useCallback(() => {
    const held = { start: pendingStartRef.current, dictation: heldDictationRef.current };
    pendingStartRef.current = false;
    heldDictationRef.current = false;
    return held;
  }, []);

  return (
    <VoiceEnabledContext.Provider value={enabled}>
      {children}
      {Widget && <Widget config={config} claimHeld={claimHeld} />}
    </VoiceEnabledContext.Provider>
  );
}
