/**
 * Dedicated Socket.IO namespace for FableLoom QR-hosted play sessions (#5383).
 *
 * Scoped to `/fableloom-hosted`. A guest connection authenticated with a
 * single-use QR token can ONLY access its designated session room and never
 * acquires general PortOS auth privileges or access to other socket events.
 */

import {
  _getInternalSession,
  abortHostedTurn,
  endHostedSession,
  getHostedSession,
  processHostedUtterance,
  sanitizeHostedSession,
  startHostedListening,
  updateHostedSession,
  verifyHostedToken,
} from '../services/fableLoom/hostedSession.js';

// Guest mic payload caps. This socket is authenticated by a single-use QR token
// from a guest device, not by the install's one trusted user, so the root trust
// model does not cover it and the numbers mirror the trusted call path in
// `voice.js` (`MAX_CALL_FRAME_BYTES` / `MAX_AUDIO_BYTES`): one 64 KB frame is
// two seconds of headroom over the ~20 ms bursts the audience page ships, and
// 8 MB is ~4 minutes of 16 kHz mono audio for a single turn.
const MAX_MIC_FRAME_BYTES = 64 * 1024;
const MAX_UTTERANCE_BYTES = 8 * 1024 * 1024;

let hostedNsInstance = null;

export function getHostedNamespace() {
  return hostedNsInstance;
}

export function registerFableLoomHostedNamespace(io) {
  if (!io || typeof io.of !== 'function') return null;

  const ns = io.of('/fableloom-hosted');
  hostedNsInstance = ns;

  // `io.use(socketAuthGate)` only covers the default namespace, so every role
  // here must authenticate with this session's join token.
  ns.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const query = socket.handshake.query || {};
      const sessionId = auth.sessionId || query.sessionId;
      const token = auth.token || query.token;
      const role = auth.role || query.role || 'audience';

      if (!sessionId || typeof sessionId !== 'string') {
        return next(new Error('SESSION_ID_REQUIRED'));
      }

      const session = _getInternalSession(sessionId);
      if (!session || session.status !== 'active') {
        return next(new Error('HOSTED_SESSION_NOT_FOUND_OR_EXPIRED'));
      }

      if (!token || !verifyHostedToken(sessionId, token)) {
        return next(new Error('HOSTED_SESSION_UNAUTHORIZED'));
      }

      if (role !== 'audience' && role !== 'host') {
        return next(new Error('HOSTED_SESSION_ROLE_INVALID'));
      }

      socket.hostedRole = role;
      socket.hostedSessionId = sessionId;
      return next();
    } catch (err) {
      return next(new Error(`AUTH_ERROR: ${err?.message || err}`));
    }
  });

  ns.on('connection', (socket) => {
    const { hostedSessionId: sessionId, hostedRole: role } = socket;
    const room = `session:${sessionId}`;
    socket.join(room);

    const session = _getInternalSession(sessionId);
    if (!session) {
      socket.disconnect(true);
      return;
    }

    if (role === 'host') {
      session.hostSocketId = socket.id;
    } else if (role === 'audience') {
      // Single audience device policy: if an existing audience socket was connected, notify/replace
      if (session.audienceSocketId && session.audienceSocketId !== socket.id) {
        const oldSocket = ns.sockets.get(session.audienceSocketId);
        if (oldSocket) {
          oldSocket.emit('hosted:session:replaced', { reason: 'Another audience device joined this session.' });
          oldSocket.disconnect(true);
        }
      }
      session.audienceSocketId = socket.id;
    }

    // Emit initial sync snapshot to newly connected client
    socket.emit('hosted:session:sync', sanitizeHostedSession(session));

    // Broadcast peer connection status to the room
    ns.to(room).emit('hosted:peer:status', {
      hasHostConnected: !!session.hostSocketId,
      hasAudienceConnected: !!session.audienceSocketId,
      role,
    });

    // Inbound frame buffer for streaming mic chunks. `micBytes` is a running
    // counter rather than a re-sum of the array, and `micOverflow` latches the
    // refusal so an over-cap turn is reported once and never processed as if it
    // were a complete utterance.
    let micChunks = [];
    let micBytes = 0;
    let micOverflow = false;

    const resetMicBuffer = () => {
      micChunks = [];
      micBytes = 0;
      micOverflow = false;
    };

    // The record captured at connect goes stale: TTL expiry marks a session
    // `ended` without touching `turnPhase`, so a closure gated on that snapshot
    // reads `listening` forever. `_getInternalSession` re-evaluates the TTL and
    // returns null for a dead session.
    const liveSession = () => _getInternalSession(sessionId);

    // --- Host actions ---
    socket.on('hosted:playback:update', (data) => {
      if (socket.hostedRole !== 'host') return;
      try {
        const updated = updateHostedSession(sessionId, {
          playbackPhase: data?.phase,
          activeHoldIndex: data?.activeHoldIndex,
          currentNodeId: data?.nodeId,
        }, { io });
        ns.to(room).emit('hosted:playback:sync', {
          phase: updated.playbackPhase,
          activeHoldIndex: updated.activeHoldIndex,
          nodeId: updated.currentNodeId,
        });
      } catch (err) {
        socket.emit('hosted:error', { code: 'UPDATE_FAILED', message: err.message });
      }
    });

    socket.on('hosted:audio:target', (data) => {
      if (socket.hostedRole !== 'host') return;
      try {
        const updated = updateHostedSession(sessionId, { audioTarget: data?.target }, { io });
        ns.to(room).emit('hosted:audio:target:updated', { audioTarget: updated.audioTarget });
      } catch (err) {
        socket.emit('hosted:error', { code: 'TARGET_UPDATE_FAILED', message: err.message });
      }
    });

    socket.on('hosted:session:end', () => {
      if (socket.hostedRole !== 'host') return;
      endHostedSession(sessionId, { reason: 'host_ended', io });
    });

    // --- Audience actions ---
    socket.on('hosted:mic:start', async () => {
      if (socket.hostedRole !== 'audience') return;
      resetMicBuffer();
      try {
        await startHostedListening(sessionId, { io });
      } catch (err) {
        socket.emit('hosted:error', { code: err.code || 'MIC_START_FAILED', message: err.message });
      }
    });

    socket.on('hosted:mic:frame', (chunk) => {
      if (socket.hostedRole !== 'audience') return;
      const live = liveSession();
      if (!live || live.turnPhase !== 'listening') return;
      // Already refused this turn — keep dropping until the next mic:start.
      if (micOverflow || !chunk) return;

      const frame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (frame.length > MAX_MIC_FRAME_BYTES) return;

      if (micBytes + frame.length > MAX_UTTERANCE_BYTES) {
        micOverflow = true;
        micChunks = [];
        micBytes = 0;
        socket.emit('hosted:error', {
          code: 'UTTERANCE_TOO_LARGE',
          message: `audio too large (over ${MAX_UTTERANCE_BYTES} bytes)`,
        });
        return;
      }

      micChunks.push(frame);
      micBytes += frame.length;
    });

    socket.on('hosted:mic:stop', async (completeBuffer) => {
      if (socket.hostedRole !== 'audience') return;
      const live = liveSession();
      if (!live || live.turnPhase !== 'listening') return;

      const overflowed = micOverflow;
      let finalAudio = null;
      if (!overflowed && completeBuffer
        && (Buffer.isBuffer(completeBuffer) || ArrayBuffer.isView(completeBuffer))) {
        const complete = Buffer.isBuffer(completeBuffer) ? completeBuffer : Buffer.from(completeBuffer);
        if (complete.length > MAX_UTTERANCE_BYTES) {
          resetMicBuffer();
          socket.emit('hosted:error', {
            code: 'UTTERANCE_TOO_LARGE',
            message: `audio too large (${complete.length} > ${MAX_UTTERANCE_BYTES} bytes)`,
          });
          return;
        }
        finalAudio = complete;
      } else if (!overflowed && micChunks.length > 0) {
        finalAudio = Buffer.concat(micChunks);
      }
      resetMicBuffer();

      // A truncated buffer would hand the LLM half a sentence with no signal,
      // so an overflowed turn is refused outright; the error already went out.
      if (overflowed) return;

      try {
        await processHostedUtterance(sessionId, { audioBuffer: finalAudio, io });
      } catch (err) {
        socket.emit('hosted:error', { code: err.code || 'UTTERANCE_FAILED', message: err.message });
      }
    });

    socket.on('hosted:turn:text', async (data) => {
      if (socket.hostedRole !== 'audience') return;
      const live = liveSession();
      if (!live || live.turnPhase !== 'listening') return;
      try {
        await processHostedUtterance(sessionId, { textMessage: data?.text, io });
      } catch (err) {
        socket.emit('hosted:error', { code: err.code || 'TEXT_FAILED', message: err.message });
      }
    });

    socket.on('hosted:speech:done', (_data) => {
      // Speech finished playback on output target
      const live = liveSession();
      if (live && live.turnPhase === 'speaking') {
        live.turnPhase = 'listening';
        ns.to(room).emit('hosted:turn:phase', { phase: 'listening' });
      }
    });

    socket.on('hosted:turn:abort', () => {
      abortHostedTurn(sessionId, { reason: 'client_aborted', io });
    });

    // --- Disconnect lifecycle ---
    socket.on('disconnect', () => {
      if (socket.hostedRole === 'host' && session.hostSocketId === socket.id) {
        session.hostSocketId = null;
      } else if (socket.hostedRole === 'audience' && session.audienceSocketId === socket.id) {
        session.audienceSocketId = null;
      }
      ns.to(room).emit('hosted:peer:status', {
        hasHostConnected: !!session.hostSocketId,
        hasAudienceConnected: !!session.audienceSocketId,
        disconnectedRole: socket.hostedRole,
      });
      socket.removeAllListeners();
    });
  });

  return ns;
}

export { MAX_MIC_FRAME_BYTES, MAX_UTTERANCE_BYTES };
