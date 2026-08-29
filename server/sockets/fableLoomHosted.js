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

let hostedNsInstance = null;

export function getHostedNamespace() {
  return hostedNsInstance;
}

export function registerFableLoomHostedNamespace(io) {
  if (!io || typeof io.of !== 'function') return null;

  const ns = io.of('/fableloom-hosted');
  hostedNsInstance = ns;

  // Handshake authentication middleware for /fableloom-hosted
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

      if (role === 'host') {
        socket.hostedRole = 'host';
        socket.hostedSessionId = sessionId;
        return next();
      }

      // Audience role requires valid join token
      if (!token || !verifyHostedToken(sessionId, token)) {
        return next(new Error('HOSTED_SESSION_UNAUTHORIZED'));
      }

      socket.hostedRole = 'audience';
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

    // Inbound frame buffer for streaming mic chunks
    let micChunks = [];

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
      micChunks = [];
      try {
        await startHostedListening(sessionId, { io });
      } catch (err) {
        socket.emit('hosted:error', { code: err.code || 'MIC_START_FAILED', message: err.message });
      }
    });

    socket.on('hosted:mic:frame', (chunk) => {
      if (!session || session.turnPhase !== 'listening') return;
      if (chunk) {
        micChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    });

    socket.on('hosted:mic:stop', async (completeBuffer) => {
      if (!session || session.turnPhase !== 'listening') return;
      let finalAudio = null;
      if (completeBuffer && (Buffer.isBuffer(completeBuffer) || ArrayBuffer.isView(completeBuffer))) {
        finalAudio = Buffer.isBuffer(completeBuffer) ? completeBuffer : Buffer.from(completeBuffer);
      } else if (micChunks.length > 0) {
        finalAudio = Buffer.concat(micChunks);
      }
      micChunks = [];

      try {
        await processHostedUtterance(sessionId, { audioBuffer: finalAudio, io });
      } catch (err) {
        socket.emit('hosted:error', { code: err.code || 'UTTERANCE_FAILED', message: err.message });
      }
    });

    socket.on('hosted:turn:text', async (data) => {
      if (!session || session.turnPhase !== 'listening') return;
      try {
        await processHostedUtterance(sessionId, { textMessage: data?.text, io });
      } catch (err) {
        socket.emit('hosted:error', { code: err.code || 'TEXT_FAILED', message: err.message });
      }
    });

    socket.on('hosted:speech:done', (_data) => {
      // Speech finished playback on output target
      if (session && session.turnPhase === 'speaking') {
        session.turnPhase = 'listening';
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
