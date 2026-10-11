import { useCallback, useEffect, useRef, useState } from 'react';
import { uuidv4 } from '../lib/uuid.js';
import socket from '../services/socket';
import useMounted from './useMounted.js';

const EMPTY = {
  status: 'idle',
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
  const frameUrl = useRef('');
  const recordingUrl = useRef('');
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const sentControls = useRef(null);
  const [state, setState] = useState(EMPTY);
  const requestKey = active && request ? JSON.stringify(request) : '';

  const seek = useCallback((t) => {
    const current = pending.current;
    if (!current?.sessionId) return;
    current.generation += 1;
    socket.emit('generated-preview:seek', {
      requestId: current.requestId,
      sessionId: current.sessionId,
      generation: current.generation,
      t,
    });
  }, []);

  const command = useCallback((action, extra = {}) => {
    const current = pending.current;
    if (!current?.sessionId) return;
    socket.emit('generated-preview:command', {
      requestId: current.requestId,
      sessionId: current.sessionId,
      generation: current.generation,
      action,
      ...extra,
    });
  }, []);

  useEffect(() => {
    sentControls.current = null;
  }, [requestKey]);

  useEffect(() => {
    if (state.status !== 'ready' || !pending.current?.sessionId) return undefined;
    const key = JSON.stringify(controls ?? null);
    if (sentControls.current === key) return undefined;
    const first = sentControls.current == null;
    sentControls.current = key;
    if (first || !controls) return undefined;
    if ('look' in controls) command('film-look', { look: controls.look ?? null });
    if ('card' in controls) command('title-card', { card: controls.card ?? null });
    return undefined;
  }, [controls, state.status, command, requestKey]);

  useEffect(() => {
    if (!requestKey) {
      const current = pending.current;
      pending.current = null;
      if (current) {
        socket.emit('generated-preview:close', {
          requestId: current.requestId,
          ...(current.sessionId ? { sessionId: current.sessionId } : {}),
        });
      }
      if (mounted.current) setState(EMPTY);
      return undefined;
    }
    const requestId = newRequestId();
    pending.current = { requestId, sessionId: null, generation: 0 };
    if (mounted.current) setState((prev) => ({ ...prev, status: 'opening', ready: false, reason: '', lastEvent: null }));
    const mine = (payload) => payload?.requestId === requestId && pending.current?.requestId === requestId;

    const onOpened = (payload) => {
      if (!mine(payload)) return;
      pending.current = { requestId, sessionId: payload.sessionId, generation: 0 };
      if (!mounted.current) return;
      setState((prev) => ({
        ...prev,
        status: 'ready',
        ready: true,
        reason: '',
        durationSec: Number(payload.durationSec) || 0,
        fps: Number(payload.fps) || 24,
        width: Number(payload.width) || 0,
        height: Number(payload.height) || 0,
        audioStatus: payload.audio || 'none',
      }));
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
      setState((prev) => ({ ...prev, frameUrl: url, status: 'ready', ready: true }));
    };
    const onUnavailable = (payload) => {
      if (!mine(payload) || !mounted.current) return;
      setState((prev) => ({
        ...prev, status: 'unavailable', ready: false, reason: payload.message || 'Isolated preview is unavailable on this host.',
      }));
    };
    const onError = (payload) => {
      if (payload?.requestId && payload.requestId !== requestId) return;
      if (pending.current?.requestId !== requestId || !mounted.current) return;
      setState((prev) => ({
        ...prev, status: 'error', ready: false, reason: payload.message || 'The isolated preview could not start.',
      }));
    };
    const onEvent = (payload) => {
      if (!mine(payload) || !mounted.current) return;
      setState((prev) => ({ ...prev, lastEvent: payload }));
    };
    let recordingChunks = new Map();
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
      if (!mounted.current) return;
      setState((prev) => ({ ...prev, status: 'idle', ready: false }));
    };

    socket.on('generated-preview:opened', onOpened);
    socket.on('generated-preview:frame', onFrame);
    socket.on('generated-preview:unavailable', onUnavailable);
    socket.on('generated-preview:error', onError);
    socket.on('generated-preview:event', onEvent);
    socket.on('generated-preview:recording', onRecording);
    socket.on('generated-preview:closed', onClosed);
    const openControls = controlsRef.current || {};
    socket.emit('generated-preview:open', {
      requestId,
      ...request,
      look: openControls.look ?? null,
      card: openControls.card ?? null,
    });
    return () => {
      socket.off('generated-preview:opened', onOpened);
      socket.off('generated-preview:frame', onFrame);
      socket.off('generated-preview:unavailable', onUnavailable);
      socket.off('generated-preview:error', onError);
      socket.off('generated-preview:event', onEvent);
      socket.off('generated-preview:recording', onRecording);
      socket.off('generated-preview:closed', onClosed);
      const current = pending.current;
      if (current?.requestId === requestId) {
        socket.emit('generated-preview:close', {
          requestId,
          ...(current.sessionId ? { sessionId: current.sessionId } : {}),
        });
      }
    };
    // `request` is read for the payload; requestKey is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, mounted]);

  useEffect(() => () => {
    if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
  }, []);

  return { ...state, seek, command };
}
