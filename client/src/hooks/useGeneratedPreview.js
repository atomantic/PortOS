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
  const resume = useCallback(() => openRef.current?.(), []);

  const seek = useCallback((t, { playing = false } = {}) => {
    lastSeek.current = { t, playing };
    const current = pending.current;
    if (!socket.connected || !current?.sessionId) return;
    current.generation += 1;
    socket.emit('generated-preview:seek', {
      requestId: current.requestId,
      sessionId: current.sessionId,
      generation: current.generation,
      t,
      playing,
    });
  }, []);

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

  useEffect(() => {
    lastSeek.current = null;
    if (!requestKey) {
      const current = pending.current;
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
    const open = () => {
      if (!socket.connected || pending.current) return;
      stoppedStatus = null;
      requestId = newRequestId();
      const openControls = { look: controlsRef.current?.look ?? null, card: controlsRef.current?.card ?? null };
      pending.current = { requestId, sessionId: null, generation: 0, controls: openControls };
      if (mounted.current) setState((prev) => ({ ...prev, status: 'opening', sessionId: null, ready: false, reason: '', lastEvent: null }));
      socket.emit('generated-preview:open', {
        requestId,
        ...request,
        look: openControls.look,
        card: openControls.card,
      });
    };
    const onDisconnect = () => {
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
      pending.current = { ...pending.current, sessionId: payload.sessionId };
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
      }));
      // A reconnect opens at time zero; restore the current scrub/playhead
      // position using the new session, including seeks made while offline.
      if (lastSeek.current) seek(lastSeek.current.t, lastSeek.current);
    };
    const onFrame = (payload) => {
      if (!mine(payload) || !payload.data) return;
      if (pending.current.sessionId && payload.sessionId && payload.sessionId !== pending.current.sessionId) return;
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
      if (opened) stoppedStatus = null;
      setState((prev) => ({ ...prev, frameUrl: url, ...(opened ? { status: 'ready', ready: true } : {}) }));
    };
    const onUnavailable = (payload) => {
      if (!mine(payload) || !mounted.current) return;
      stoppedStatus = 'unavailable';
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
      setState((prev) => ({
        ...prev, status: 'error', ready: false, reason: payload.message || 'The isolated preview could not start.',
      }));
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
      pending.current = null;
      recordingChunks.clear();
      stoppedStatus = 'idle';
      if (!mounted.current) return;
      // Idle/capacity cleanup stays effective until the viewer explicitly
      // resumes. Reopening here would keep idle renderers alive indefinitely.
      setState((prev) => ({ ...prev, status: 'idle', sessionId: null, ready: false, lastEvent: null }));
    };

    socket.on('generated-preview:opened', onOpened);
    socket.on('generated-preview:frame', onFrame);
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
  }, [requestKey, mounted, seek]);

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

  return { ...state, seek, command, resume };
}
