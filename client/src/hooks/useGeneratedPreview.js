import { useCallback, useEffect, useRef, useState } from 'react';
import { uuidv4 } from '../lib/uuid.js';
import socket from '../services/socket';
import useMounted from './useMounted.js';

const EMPTY = {
  status: 'idle',
  sessionId: null,
  reason: '',
  durationSec: 0,
  fps: 24,
  width: 0,
  height: 0,
  frameUrl: '',
  ready: false,
  audioStatus: 'none',
  lastEvent: null,
  recording: null,
  playback: false,
  playbackReason: '',
  playbackResync: 0,
  playbackResyncReason: '',
};

const newRequestId = () => uuidv4();

const decode = (chunk) => {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/**
 * One isolated generated-preview session. The server renders the page and
 * pushes JPEG frames; this hook never mounts the generated document.
 * `request` is the reopen key. `controls` (film look, title card) ride the
 * open and later commands, so a slider move does not relaunch the worker.
 */
export default function useGeneratedPreview({ active, request, controls = null }) {
  const mounted = useMounted();
  const pending = useRef(null);
  const openRef = useRef(null);
  const lastSeek = useRef(null);
  const frameUrl = useRef('');
  const recordingUrl = useRef('');
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const [state, setState] = useState(EMPTY);
  const requestKey = active && request ? JSON.stringify(request) : '';
  const resume = useCallback(() => openRef.current?.(true), []);

  const cancelPlayback = useCallback((current = pending.current) => {
    if (!current) return;
    current.epoch += 1;
    current.mode = 'exact';
    current.frameSequence = -1;
    for (const finish of current.responses.values()) finish(null);
    current.responses.clear();
  }, []);

  const seek = useCallback((t, { playing = false } = {}) => {
    const current = pending.current;
    const continuing = playing && current?.mode === 'legacy-playing';
    if (!continuing) cancelPlayback(current);
    lastSeek.current = { t, playing };
    if (!socket.connected || !current?.sessionId) return;
    current.generation += 1;
    if (playing) {
      if (!continuing) {
        current.generationFloor = current.generation;
        current.completedGeneration = current.generation - 1;
      }
      current.mode = 'legacy-playing';
    }
    socket.emit('generated-preview:seek', {
      requestId: current.requestId,
      sessionId: current.sessionId,
      generation: current.generation,
      t,
      playing,
    });
  }, [cancelPlayback]);

  const command = useCallback((action, extra = {}) => {
    const current = pending.current;
    if (!socket.connected || !current?.sessionId) return;
    socket.emit('generated-preview:command', {
      requestId: current.requestId,
      sessionId: current.sessionId,
      generation: current.generation,
      action,
      ...extra,
    });
  }, []);

  const preparePlayback = useCallback(async (t) => {
    const current = pending.current;
    if (!socket.connected || !current?.playback) return false;
    cancelPlayback(current);
    const epoch = current.epoch;
    current.mode = 'preparing';
    const live = () => mounted.current && socket.connected && pending.current === current && current.epoch === epoch;
    const exchange = (key, payload, timeoutMs) => new Promise((resolve) => {
      const finish = (reply) => {
        clearTimeout(timer);
        current.responses.delete(key);
        resolve(reply);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      current.responses.set(key, finish);
      if (live()) socket.emit('generated-preview:playback', {
        requestId: current.requestId, sessionId: current.sessionId, ...payload,
      });
      else finish(null);
    });
    if (current.offset === null) {
      const samples = [];
      for (let i = 0; i < 3 && live(); i += 1) {
        const clientTime = performance.now();
        const probeId = current.probeId++;
        const reply = await exchange(probeId, { action: 'clock', probeId, clientTime }, 1000);
        const received = performance.now();
        if (reply && reply.clientTime === clientTime && Number.isFinite(reply.workerTime)) {
          samples.push({ uncertainty: (received - clientTime) / 2, offset: reply.workerTime - (clientTime + received) / 2 });
        }
      }
      if (!live()) return null;
      samples.sort((a, b) => a.uncertainty - b.uncertainty);
      if (!samples.length || samples[0].uncertainty > 50) {
        current.mode = 'exact';
        current.playback = false;
        setState((prev) => ({ ...prev, playback: false, playbackReason: 'Native playback clock could not be synchronized; using exact frame playback.' }));
        return false;
      }
      current.offset = samples[0].offset;
    }
    const sequence = ++current.sequence;
    const reply = await exchange(`prepare-${epoch}-${sequence}`, {
      action: 'prepare', epoch, sequence, t, generation: current.generation,
    }, 10000);
    if (!live()) return null;
    if (reply?.status !== 'ready') {
      current.mode = 'exact';
      current.terminalError = true;
      current.hasError = true;
      setState((prev) => ({ ...prev, status: 'error', ready: false, reason: reply?.message || 'Native preview preparation failed. Retry the preview.' }));
      throw new Error(reply?.message || 'Native preview preparation failed.');
    }
    current.mode = 'prepared';
    return true;
  }, [cancelPlayback, mounted]);

  const playbackAnchor = useCallback((action, t) => {
    const current = pending.current;
    if (!socket.connected || !current?.playback || current.offset === null) return;
    if (action === 'play' ? current.mode !== 'prepared' : current.mode !== 'playing') return;
    current.mode = 'playing';
    lastSeek.current = { t, playing: false };
    socket.emit('generated-preview:playback', {
      requestId: current.requestId, sessionId: current.sessionId,
      epoch: current.epoch, sequence: ++current.sequence, action, t,
      workerTime: performance.now() + current.offset,
    });
  }, []);
  const startPlayback = useCallback((t) => playbackAnchor('play', t), [playbackAnchor]);
  const syncPlayback = useCallback((t) => playbackAnchor('sync', t), [playbackAnchor]);
  const pausePlayback = useCallback((t) => seek(t), [seek]);

  useEffect(() => {
    lastSeek.current = null;
    if (!requestKey) {
      const current = pending.current;
      cancelPlayback(current);
      pending.current = null;
      if (current && socket.connected) {
        socket.emit('generated-preview:close', {
          requestId: current.requestId,
          ...(current.sessionId ? { sessionId: current.sessionId } : {}),
        });
      }
      if (mounted.current) setState(EMPTY);
      return undefined;
    }
    let requestId = null;
    const recordingChunks = new Map();
    let stoppedStatus = null;
    // Sessions belong to one socket connection. Never buffer an open/command
    // while offline: the server has already destroyed the previous session.
    const open = (retry = false) => {
      if (!socket.connected) return;
      if (retry && pending.current) {
        const previous = pending.current;
        cancelPlayback(previous);
        pending.current = null;
        socket.emit('generated-preview:close', { requestId: previous.requestId, ...(previous.sessionId ? { sessionId: previous.sessionId } : {}) });
      }
      if (pending.current) return;
      stoppedStatus = null;
      requestId = newRequestId();
      const openControls = { look: controlsRef.current?.look ?? null, card: controlsRef.current?.card ?? null };
      pending.current = { requestId, sessionId: null, generation: 0, generationFloor: 0, completedGeneration: -1, controls: openControls, epoch: 0, sequence: 0, probeId: 0, frameSequence: -1, mode: 'exact', offset: null, playback: false, responses: new Map() };
      if (mounted.current) setState((prev) => ({ ...prev, status: 'opening', sessionId: null, ready: false, reason: '', lastEvent: null, playback: false, playbackReason: '' }));
      socket.emit('generated-preview:open', {
        requestId,
        ...request,
        look: openControls.look,
        card: openControls.card,
      });
    };
    const onDisconnect = () => {
      cancelPlayback();
      pending.current = null;
      recordingChunks.clear();
      if (mounted.current) setState((prev) => ({ ...prev, status: 'disconnected', sessionId: null, ready: false, lastEvent: null }));
    };
    const onConnect = () => {
      if (!stoppedStatus) open();
      else if (mounted.current) setState((prev) => ({ ...prev, status: stoppedStatus, ready: false }));
    };
    const mine = (payload) => payload?.requestId === requestId && pending.current?.requestId === requestId;

    const onOpened = (payload) => {
      if (!mine(payload)) return;
      stoppedStatus = null;
      const capable = request.kind === 'music-video' && !request.lyrics && payload.playback?.version === 1;
      Object.assign(pending.current, { sessionId: payload.sessionId, playback: capable, capable });
      if (!mounted.current) return;
      setState((prev) => ({
        ...prev,
        status: 'ready',
        sessionId: payload.sessionId,
        ready: true,
        reason: '',
        durationSec: Number(payload.durationSec) || 0,
        fps: Number(payload.fps) || 24,
        width: Number(payload.width) || 0,
        height: Number(payload.height) || 0,
        audioStatus: payload.audio || 'none',
        playback: capable,
      }));
      // A reconnect opens at time zero; restore the current scrub/playhead
      // position using the new session, including seeks made while offline.
      if (lastSeek.current) seek(lastSeek.current.t, lastSeek.current);
    };
    const onFrame = (payload) => {
      if (!mine(payload) || !payload.data) return;
      if (pending.current.sessionId && payload.sessionId && payload.sessionId !== pending.current.sessionId) return;
      const current = pending.current;
      if (current.terminalError) return;
      if (payload.playbackEpoch !== undefined) {
        if (current.mode !== 'playing' || payload.playbackEpoch !== current.epoch || !Number.isInteger(payload.sequence) || payload.sequence <= current.frameSequence) return;
        current.frameSequence = payload.sequence;
      } else if (current.capable) {
        if (current.mode === 'legacy-playing') {
          // A completed frame can trail newer playing requests. Display it
          // once, in order, but never cross a pause/scrub/new-play boundary.
          if (!Number.isInteger(payload.generation) || payload.generation < current.generationFloor || payload.generation > current.generation || payload.generation <= current.completedGeneration) return;
          current.completedGeneration = payload.generation;
        } else if (current.mode !== 'exact' || payload.generation !== current.generation) return;
      }
      let url = '';
      try {
        url = URL.createObjectURL(new Blob([decode(payload.data)], { type: 'image/jpeg' }));
      } catch {
        return;
      }
      const previous = frameUrl.current;
      frameUrl.current = url;
      if (previous) URL.revokeObjectURL(previous);
      if (!mounted.current) return;
      // Screencasting can start before the open acknowledgement. Show its
      // frame, but commands need the session identity established by opened.
      const opened = !!pending.current.sessionId;
      if (opened) { stoppedStatus = null; current.hasError = false; }
      setState((prev) => ({ ...prev, frameUrl: url, ...(opened ? { status: 'ready', ready: true } : {}) }));
    };
    const onUnavailable = (payload) => {
      if (!mine(payload) || !mounted.current) return;
      stoppedStatus = 'unavailable';
      cancelPlayback();
      setState((prev) => ({
        ...prev, status: 'unavailable', ready: false, reason: payload.message || 'Isolated preview is unavailable on this host.',
      }));
    };
    const onError = (payload) => {
      if (payload?.requestId && payload.requestId !== requestId) return;
      if (pending.current?.requestId !== requestId || !mounted.current) return;
      // A command/seek failure must not prevent replacing a lost session.
      // Only failures before the open handshake suppress reconnect retries.
      stoppedStatus = pending.current.sessionId ? null : 'error';
      pending.current.hasError = true;
      if (pending.current.capable) pending.current.terminalError = true;
      cancelPlayback();
      setState((prev) => ({
        ...prev, status: 'error', ready: false, reason: payload.message || 'The isolated preview could not start.',
      }));
    };
    const onPlaybackState = (payload) => {
      if (!mine(payload) || payload.sessionId !== pending.current.sessionId) return;
      const current = pending.current;
      if (payload.action === 'clock') {
        current.responses.get(payload.probeId)?.(payload);
        return;
      }
      if (payload.epoch !== current.epoch) return;
      if (payload.action === 'prepare') {
        current.responses.get(`prepare-${payload.epoch}-${payload.sequence}`)?.(payload);
      } else if (payload.status === 'resync-required') {
        cancelPlayback();
        setState((prev) => ({ ...prev, playbackResync: prev.playbackResync + 1, playbackResyncReason: payload.reason || 'clock' }));
      } else if (payload.status === 'error') {
        current.terminalError = true;
        onError({ ...payload, message: payload.message || 'Native preview playback lost synchronization. Retry the preview.' });
      }
    };
    const onEvent = (payload) => {
      if (!mine(payload) || !mounted.current) return;
      setState((prev) => ({ ...prev, lastEvent: payload }));
    };
    const onRecording = (payload) => {
      if (!mine(payload) || typeof payload.chunk !== 'string' || !payload.count) return;
      const gen = payload.generation ?? 0;
      let genChunks = recordingChunks.get(gen);
      if (!genChunks) {
        genChunks = [];
        recordingChunks.set(gen, genChunks);
      }
      genChunks[payload.index] = payload.chunk;
      if (genChunks.filter(Boolean).length !== payload.count) return;
      recordingChunks.delete(gen);
      const blob = new Blob(genChunks.map((chunk) => decode(chunk)), { type: payload.mime || 'video/webm' });
      const url = URL.createObjectURL(blob);
      if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
      recordingUrl.current = url;
      if (!mounted.current) return;
      setState((prev) => ({ ...prev, recording: { blob, url, mime: payload.mime || 'video/webm' } }));
    };
    const onClosed = (payload) => {
      if (!pending.current?.sessionId || payload?.sessionId !== pending.current.sessionId) return;
      const failed = pending.current.hasError;
      cancelPlayback();
      pending.current = null;
      recordingChunks.clear();
      stoppedStatus = failed ? 'error' : 'idle';
      if (!mounted.current) return;
      // Idle/capacity cleanup stays effective until the viewer explicitly
      // resumes. Reopening here would keep idle renderers alive indefinitely.
      setState((prev) => ({ ...prev, status: stoppedStatus, sessionId: null, ready: false, lastEvent: null }));
    };

    socket.on('generated-preview:opened', onOpened);
    socket.on('generated-preview:frame', onFrame);
    socket.on('generated-preview:playback-state', onPlaybackState);
    socket.on('generated-preview:unavailable', onUnavailable);
    socket.on('generated-preview:error', onError);
    socket.on('generated-preview:event', onEvent);
    socket.on('generated-preview:recording', onRecording);
    socket.on('generated-preview:closed', onClosed);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    openRef.current = open;
    if (socket.connected) open();
    else onDisconnect();
    return () => {
      socket.off('generated-preview:opened', onOpened);
      socket.off('generated-preview:frame', onFrame);
      socket.off('generated-preview:playback-state', onPlaybackState);
      socket.off('generated-preview:unavailable', onUnavailable);
      socket.off('generated-preview:error', onError);
      socket.off('generated-preview:event', onEvent);
      socket.off('generated-preview:recording', onRecording);
      socket.off('generated-preview:closed', onClosed);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      openRef.current = null;
      const current = pending.current;
      if (current?.requestId === requestId) {
        cancelPlayback(current);
        pending.current = null;
        if (socket.connected) {
          socket.emit('generated-preview:close', {
            requestId,
            ...(current.sessionId ? { sessionId: current.sessionId } : {}),
          });
        }
      }
    };
    // `request` is read for the payload; requestKey is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, mounted, seek, cancelPlayback]);

  // Reconcile against what this session actually received. Controls can change
  // while its open request is in flight; readiness must not mark those edits sent.
  // This effect follows session setup so a reopen never targets the old session.
  useEffect(() => {
    const current = pending.current;
    if (state.status !== 'ready' || !current?.sessionId) return;
    const next = { look: controls?.look ?? null, card: controls?.card ?? null };
    const previous = current.controls;
    current.controls = next;
    if (JSON.stringify(previous.look) !== JSON.stringify(next.look)) command('film-look', { look: next.look });
    if (JSON.stringify(previous.card) !== JSON.stringify(next.card)) command('title-card', { card: next.card });
  }, [controls, state.status, command, requestKey]);

  useEffect(() => () => {
    if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
  }, []);

  return { ...state, seek, command, resume, preparePlayback, startPlayback, syncPlayback, pausePlayback };
}
