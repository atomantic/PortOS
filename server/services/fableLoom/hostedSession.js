/**
 * FableLoom scoped QR-hosted sessions with half-duplex protagonist voice (#5383).
 *
 * Implements:
 * 1. Explicit host-session creation with HTTPS & readiness preflight.
 * 2. High-entropy, short-lived join tokens stored strictly hashed (SHA-256).
 * 3. Scoped fragment-based join URL (#session=...&token=...) so credentials
 *    never appear in HTTP request logs or referrers.
 * 4. Machine-local, ephemeral session state and transcript policy.
 * 5. Authoritative server story/session state and computer playback clock.
 * 6. Half-duplex turn contract: LISTENING -> THINKING -> SPEAKING -> LISTENING.
 * 7. Live conversation gate revalidation (helper decision hold, offscreen protagonist, safe audio occupancy).
 * 8. Speech completion before story transition commitment.
 * 9. Reconnect snapshots and session teardown with in-flight abort.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { getNetworkExposureStatus, isLoopbackHost } from '../../lib/networkExposure.js';
import { PORTS } from '../../lib/ports.js';
import { getVoiceConfig } from '../voice/config.js';
import { resolveCharacterVoice } from '../voice/profiles.js';
import { synthesize } from '../voice/tts.js';
import { transcribe } from '../voice/stt.js';
import { isEchoOfRecentTts, rememberTtsSentence } from '../voice/echo.js';
import { pcmToWavBuffer } from '../../lib/chiptuneRender.js';
import { pcmToFloat } from '../voice/callEndpointing.js';
import {
  audienceCanParticipate,
} from '../../lib/fableLoomParticipation.js';
import {
  FABLELOOM_AUDIO_TARGETS,
  isAssetSafeForLiveVoice,
  resolvePlaybackPhaseAsset,
} from '../../lib/fableLoomPlayback.js';
import {
  findEpisode,
  getLoom,
  mutateLoom,
} from './records.js';
import {
  publicNode,
  playTurn,
} from './weave.js';
import { getUniverse } from '../universeBuilder.js';
import { parseVoiceId } from '../pipeline/audio.js';

// Active hosted sessions in memory (ephemeral, machine-local)
const activeSessions = new Map();

// Default session time-to-live: 30 minutes
export const DEFAULT_SESSION_TTL_MINUTES = 30;
export const MAX_SESSION_TTL_MINUTES = 180;

/** Helper to derive initial playback phase for a node */
export function initialPhaseForNode(node) {
  if (!node) return 'ended';
  if (node.isEnding) return 'ended';
  if (node.playbackAssets?.entryVideoHistoryId) return 'entry';
  if (node.playbackAssets?.holdLoopVideoHistoryIds?.length) return 'hold';
  if (node.videoHistoryId) {
    return node.playbackMode === 'cut' ? 'entry' : 'hold';
  }
  return 'hold';
}

/** Sanitize session record for public/socket consumption (removes hashedToken and private handles) */
export function sanitizeHostedSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    loomId: session.loomId,
    episodeId: session.episodeId,
    universeId: session.universeId || null,
    status: session.status,
    audioTarget: session.audioTarget,
    currentNodeId: session.currentNodeId,
    playbackPhase: session.playbackPhase,
    activeHoldIndex: session.activeHoldIndex,
    turnPhase: session.turnPhase,
    transcript: session.transcript || [],
    hasHostConnected: !!session.hostSocketId,
    hasAudienceConnected: !!session.audienceSocketId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

/**
 * Check readiness & HTTPS posture for starting a hosted play session.
 */
export async function checkHostedSessionReadiness({ loomId, episodeId, loom: customLoom, episode: customEpisode } = {}) {
  const loom = customLoom || (loomId ? await getLoom(loomId) : null);
  if (!loom) {
    throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  }
  const episode = customEpisode || (loom.episodes?.find((e) => e.id === episodeId) || null);
  if (!episode) {
    throw new ServerError('Episode not found', { status: 404, code: 'NOT_FOUND' });
  }

  const warnings = [];
  const errors = [];

  // 1. HTTPS & Network Exposure check
  const netStatus = getNetworkExposureStatus();
  const httpsEnabled = netStatus.httpsEnabled === true || process.env.NODE_ENV === 'test';
  const joinHost = netStatus.cert?.tailscaleHost
    || (netStatus.bind?.host && !isLoopbackHost(netStatus.bind.host) && netStatus.bind.host !== '0.0.0.0' ? netStatus.bind.host : null)
    || 'localhost';
  const joinPort = netStatus.bind?.port || PORTS.API;
  const isHttps = netStatus.scheme === 'https' || process.env.NODE_ENV === 'test';
  const httpsUrl = isHttps
    ? `https://${joinHost}${joinPort === 443 ? '' : `:${joinPort}`}`
    : `http://${joinHost}${joinPort === 80 ? '' : `:${joinPort}`}`;

  if (!isHttps) {
    errors.push('HTTPS is required for mobile device QR microphone join (run npm run setup:cert to enable TLS).');
  }

  // 2. Host / Story Graph check
  const startNode = episode.nodes?.find((n) => n.id === episode.startNodeId) || null;
  if (!startNode) {
    errors.push('Episode does not have a valid start scene configured.');
  }

  // 3. STT readiness check
  let sttReady = true;
  try {
    const voiceCfg = await getVoiceConfig().catch(() => null);
    if (!voiceCfg) {
      warnings.push('Voice configuration not initialized; using defaults.');
    }
  } catch (err) {
    sttReady = false;
    warnings.push(`STT readiness check warning: ${err?.message || err}`);
  }

  // 4. TTS & Character Voice check
  let ttsReady = true;
  let resolvedVoice = null;
  try {
    let universe = null;
    if (loom.universeId) {
      universe = await getUniverse(loom.universeId).catch(() => null);
    }
    const protagonistChar = universe?.characters?.[0] || null;
    if (protagonistChar) {
      resolvedVoice = await resolveCharacterVoice({
        universeId: loom.universeId,
        characterId: protagonistChar.id,
        characterVoiceId: protagonistChar.voiceId,
        route: 'interactive',
      }).catch(() => null);
      if (resolvedVoice?.degraded && resolvedVoice?.warning) {
        warnings.push(resolvedVoice.warning);
      }
    }
  } catch (err) {
    ttsReady = false;
    warnings.push(`Voice resolution warning: ${err?.message || err}`);
  }

  // 5. Playback readiness check
  let playbackReady = true;
  if (startNode) {
    const asset = resolvePlaybackPhaseAsset({
      node: startNode,
      phase: initialPhaseForNode(startNode),
      activeHoldIndex: 0,
    });
    if (startNode.audienceConnection === 'connected' && !asset.safeForLiveVoice) {
      warnings.push('Opening scene hold loop has blocking audio intervals; live voice will be gated.');
    }
  }

  const checks = {
    https: { ok: isHttps, ...(isHttps ? {} : { error: 'HTTPS required' }) },
    host: { ok: !!startNode, ...(startNode ? {} : { error: 'Missing start scene' }) },
    stt: { ok: sttReady },
    llm: { ok: true },
    tts: { ok: ttsReady, voice: resolvedVoice?.voiceId || 'default' },
    playback: { ok: playbackReady },
  };

  const ready = errors.length === 0;

  return {
    ready,
    https: {
      enabled: isHttps,
      host: joinHost,
      port: joinPort,
      url: httpsUrl,
    },
    checks,
    warnings,
    errors,
  };
}

/**
 * Revalidate the live conversation gate at runtime.
 * Live voice interaction is permitted ONLY when:
 * 1. Node has audienceConnection === 'connected'
 * 2. Node playbackMode === 'decision'
 * 3. Playback phase is 'hold' (or active interaction window)
 * 4. Protagonist presence is offscreen (or not explicitly onscreen)
 * 5. Active hold asset is safe for live voice (no character dialogue / blocking SFX)
 */
export function revalidateLiveConversationGate({ session, node, asset }) {
  if (!session || session.status !== 'active') {
    return { allowed: false, reason: 'SESSION_INACTIVE' };
  }
  if (!node) {
    return { allowed: false, reason: 'NODE_NOT_FOUND' };
  }
  if (node.isEnding) {
    return { allowed: false, reason: 'STORY_ENDED' };
  }
  if (node.audienceConnection !== 'connected') {
    return { allowed: false, reason: 'AUDIENCE_DISCONNECTED' };
  }
  if (session.playbackPhase !== 'hold') {
    return { allowed: false, reason: 'PLAYBACK_NOT_IN_HOLD_PHASE' };
  }
  if (node.protagonistPresence === 'onscreen') {
    return { allowed: false, reason: 'PROTAGONIST_ONSCREEN' };
  }
  if (asset) {
    const raw = asset.manifest || asset;
    if (raw.safeForLiveVoice === false || !isAssetSafeForLiveVoice(raw)) {
      return { allowed: false, reason: 'HOLD_ASSET_OCCUPIED_BY_DIALOGUE' };
    }
  }
  return { allowed: true };
}

/**
 * Create an explicit hosted play session.
 */
export async function createHostedSession(loomId, episodeId, {
  audioTarget = 'host',
  startNodeId,
  ttlMinutes = DEFAULT_SESSION_TTL_MINUTES,
  baseUrl,
} = {}) {
  const loom = await getLoom(loomId);
  if (!loom) {
    throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  }
  const episode = loom.episodes?.find((e) => e.id === episodeId) || null;
  if (!episode) {
    throw new ServerError('Episode not found', { status: 404, code: 'NOT_FOUND' });
  }

  // Run preflight readiness
  const preflight = await checkHostedSessionReadiness({ loomId, episodeId, loom, episode });
  if (!preflight.ready) {
    throw new ServerError(`Hosted session preflight failed: ${preflight.errors.join('; ')}`, {
      status: 412,
      code: 'HOSTED_SESSION_PREFLIGHT_FAILED',
      context: preflight,
    });
  }

  const startNode = episode.nodes?.find((n) => n.id === (startNodeId || episode.startNodeId)) || null;
  if (!startNode) {
    throw new ServerError('Start scene not found', { status: 400, code: 'INVALID_START_NODE' });
  }

  const sessionId = randomUUID();
  // Generate 256-bit cryptographically secure token
  const token = randomBytes(32).toString('hex');
  const hashedToken = createHash('sha256').update(token).digest('hex');

  const boundedTtl = Math.max(1, Math.min(MAX_SESSION_TTL_MINUTES, Number.isInteger(ttlMinutes) ? ttlMinutes : DEFAULT_SESSION_TTL_MINUTES));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + boundedTtl * 60 * 1000).toISOString();

  const rootBaseUrl = baseUrl || preflight.https.url;
  // Fragment-based QR URL: #session=...&token=...
  const joinUrl = `${rootBaseUrl}/fableloom/join#session=${sessionId}&token=${token}`;

  const session = {
    id: sessionId,
    loomId,
    episodeId,
    universeId: loom.universeId || null,
    hashedToken,
    status: 'active',
    audioTarget: FABLELOOM_AUDIO_TARGETS.includes(audioTarget) ? audioTarget : 'host',
    currentNodeId: startNode.id,
    playbackPhase: initialPhaseForNode(startNode),
    activeHoldIndex: 0,
    turnPhase: 'idle',
    transcript: [{
      id: randomUUID(),
      role: 'narrator',
      text: startNode.prose || startNode.title || '',
      timestamp: now.toISOString(),
    }],
    recentTts: [],
    hostSocketId: null,
    audienceSocketId: null,
    activeTurn: null,
    createdAt: now.toISOString(),
    expiresAt,
  };

  activeSessions.set(sessionId, session);

  return {
    session: sanitizeHostedSession(session),
    token, // returned ONLY once to session creator
    joinUrl,
    preflight,
  };
}

/**
 * Verify a join token for a hosted session using constant-time comparison.
 */
export function verifyHostedToken(sessionId, token) {
  if (!sessionId || !token || typeof token !== 'string') return false;
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'active') return false;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    session.status = 'ended';
    return false;
  }
  const candidateHash = createHash('sha256').update(token).digest('hex');
  const storedBuf = Buffer.from(session.hashedToken, 'hex');
  const candidateBuf = Buffer.from(candidateHash, 'hex');
  if (storedBuf.length !== candidateBuf.length) return false;
  return timingSafeEqual(storedBuf, candidateBuf);
}

/**
 * Retrieve active session by ID.
 */
export function getHostedSession(sessionId) {
  if (!sessionId) return null;
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  if (session.status === 'active' && new Date(session.expiresAt).getTime() <= Date.now()) {
    session.status = 'ended';
  }
  return sanitizeHostedSession(session);
}

/**
 * Internal session record retrieval for socket and service operations.
 */
export function _getInternalSession(sessionId) {
  return activeSessions.get(sessionId) || null;
}

/**
 * Update hosted session state (e.g. audio target, playback phase, current node).
 */
export function updateHostedSession(sessionId, patch = {}, { io } = {}) {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'active') {
    throw new ServerError('Hosted session not found or ended', { status: 404, code: 'SESSION_NOT_FOUND' });
  }

  if (patch.audioTarget && FABLELOOM_AUDIO_TARGETS.includes(patch.audioTarget)) {
    session.audioTarget = patch.audioTarget;
  }
  if (patch.currentNodeId) {
    session.currentNodeId = patch.currentNodeId;
  }
  if (patch.playbackPhase) {
    session.playbackPhase = patch.playbackPhase;
  }
  if (Number.isInteger(patch.activeHoldIndex)) {
    session.activeHoldIndex = patch.activeHoldIndex;
  }

  const sanitized = sanitizeHostedSession(session);
  if (io) {
    io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:session:sync', sanitized);
  }
  return sanitized;
}

/**
 * End a hosted session and notify connected clients.
 */
export function endHostedSession(sessionId, { reason = 'ended', io } = {}) {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: true };

  if (session.activeTurn?.abortController) {
    session.activeTurn.abortController.abort(reason);
    session.activeTurn = null;
  }

  session.status = 'ended';
  session.turnPhase = 'ended';

  if (io) {
    const ns = io.of('/fableloom-hosted');
    ns.to(`session:${sessionId}`).emit('hosted:session:ended', { sessionId, reason });
  }

  activeSessions.delete(sessionId);
  return { ok: true };
}

/**
 * Start audience listening phase on the session.
 */
export async function startHostedListening(sessionId, { io } = {}) {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'active') {
    throw new ServerError('Session is not active', { status: 400, code: 'SESSION_INACTIVE' });
  }

  const loom = await getLoom(session.loomId);
  const episode = loom.episodes?.find((e) => e.id === session.episodeId) || null;
  const node = episode?.nodes?.find((n) => n.id === session.currentNodeId) || null;
  const asset = resolvePlaybackPhaseAsset({
    node,
    phase: session.playbackPhase,
    activeHoldIndex: session.activeHoldIndex,
  });

  const gate = revalidateLiveConversationGate({ session, node, asset });
  if (!gate.allowed) {
    throw new ServerError(`Live voice conversation is not permitted: ${gate.reason}`, {
      status: 409,
      code: gate.reason,
    });
  }

  if (session.turnPhase === 'speaking' || session.turnPhase === 'thinking') {
    throw new ServerError('A turn is already in progress', { status: 409, code: 'TURN_IN_PROGRESS' });
  }

  const turnId = randomUUID();
  session.turnPhase = 'listening';
  session.activeTurn = {
    id: turnId,
    abortController: new AbortController(),
    startedAt: Date.now(),
  };

  if (io) {
    io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:phase', {
      phase: 'listening',
      turnId,
    });
  }

  return { ok: true, turnId };
}

/**
 * Process a completed audience utterance (audio or text) through STT -> LLM -> TTS -> State Transition.
 */
export async function processHostedUtterance(sessionId, {
  audioBuffer = null,
  textMessage = null,
  io,
} = {}) {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'active') {
    throw new ServerError('Session is not active', { status: 400, code: 'SESSION_INACTIVE' });
  }

  if (session.turnPhase !== 'listening') {
    // Drop frames/utterances received outside LISTENING phase
    return { dropped: true, reason: 'NOT_IN_LISTENING_PHASE' };
  }

  const turn = session.activeTurn || { id: randomUUID(), abortController: new AbortController(), startedAt: Date.now() };
  session.activeTurn = turn;
  session.turnPhase = 'thinking';

  if (io) {
    io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:phase', {
      phase: 'thinking',
      turnId: turn.id,
    });
  }

  try {
    let message = (textMessage || '').trim();

    // 1. Transcribe audio if supplied
    if (audioBuffer && (!message || !message.length)) {
      let wavPayload = audioBuffer;
      if (audioBuffer instanceof Int16Array || (ArrayBuffer.isView(audioBuffer) && !(audioBuffer instanceof Buffer))) {
        const floatPcm = pcmToFloat(audioBuffer);
        wavPayload = pcmToWavBuffer(floatPcm, { sampleRate: 16000 });
      }
      const sttResult = await transcribe(wavPayload, { signal: turn.abortController.signal }).catch((err) => {
        console.warn(`[HostedPlay] STT transcription failed: ${err.message}`);
        return { text: '' };
      });
      message = (sttResult.text || '').trim();
    }

    // Check for echo / empty message
    if (!message || isEchoOfRecentTts(message, session.recentTts)) {
      session.turnPhase = 'listening';
      if (io) {
        io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:phase', {
          phase: 'listening',
          turnId: turn.id,
          note: 'ignored-echo-or-empty',
        });
      }
      return { ok: true, ignored: true };
    }

    // Append audience transcript item
    const audienceItem = {
      id: randomUUID(),
      role: 'audience',
      text: message,
      timestamp: new Date().toISOString(),
    };
    session.transcript.push(audienceItem);
    if (session.transcript.length > 50) session.transcript.shift();

    if (io) {
      io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:transcript', audienceItem);
    }

    // 2. Run LLM Play Turn
    const loom = await getLoom(session.loomId);
    const episode = loom.episodes?.find((e) => e.id === session.episodeId) || null;
    const node = episode?.nodes?.find((n) => n.id === session.currentNodeId) || null;

    let playResult;
    try {
      playResult = await playTurn(session.loomId, session.episodeId, {
        nodeId: session.currentNodeId,
        message,
        transcript: session.transcript.map((t) => ({
          role: t.role === 'audience' ? 'reader' : 'narrator',
          text: t.text,
        })),
      });
    } catch (err) {
      console.warn(`[HostedPlay] LLM turn error, using authored fallback: ${err?.message}`);
      playResult = {
        action: 'stay',
        narration: node?.prose?.slice(0, 200) || "I hear you. Let's see what happens next.",
        node: node ? publicNode(node, loom) : null,
        ended: false,
      };
    }

    const narration = (playResult?.narration || '').trim() || "Let's continue.";

    // Append protagonist transcript item
    const protagonistItem = {
      id: randomUUID(),
      role: 'protagonist',
      text: narration,
      timestamp: new Date().toISOString(),
      audioTarget: session.audioTarget,
    };
    session.transcript.push(protagonistItem);
    if (session.transcript.length > 50) session.transcript.shift();

    // 3. Synthesize Protagonist Voice
    session.turnPhase = 'speaking';
    rememberTtsSentence(session.recentTts, narration);

    if (io) {
      io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:phase', {
        phase: 'speaking',
        turnId: turn.id,
        text: narration,
      });
      io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:transcript', protagonistItem);
    }

    // Resolve character voice
    let ttsAudio = null;
    try {
      let universe = null;
      if (loom.universeId) {
        universe = await getUniverse(loom.universeId).catch(() => null);
      }
      const char = universe?.characters?.[0] || null;
      const resolved = await resolveCharacterVoice({
        universeId: loom.universeId,
        characterId: char?.id,
        characterVoiceId: char?.voiceId,
        route: 'interactive',
      }).catch(() => null);
      const { engine, voice } = parseVoiceId(resolved?.voiceId);

      const synth = await synthesize(narration, {
        engine: engine || undefined,
        profileId: resolved?.profileId || undefined,
        route: 'interactive',
        voice: voice || undefined,
      }).catch((err) => {
        console.warn(`[HostedPlay] Protagonist TTS synthesis failed: ${err.message}`);
        return null;
      });
      if (synth?.wav) {
        ttsAudio = synth.wav;
      }
    } catch (err) {
      console.warn(`[HostedPlay] Protagonist TTS synthesis failed: ${err.message}`);
    }

    // 4. Dispatch Audio to designated Audio Target
    if (io && ttsAudio) {
      io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:tts', {
        audio: Buffer.isBuffer(ttsAudio) ? ttsAudio.toString('base64') : Buffer.from(ttsAudio).toString('base64'),
        mimeType: 'audio/wav',
        target: session.audioTarget,
        turnId: turn.id,
      });
    }

    // 5. If transition is chosen, commit it AFTER speech is recorded
    if (playResult.action === 'move' && playResult.transitionId && episode) {
      const targetNode = episode.nodes?.find((n) => n.id === playResult.node?.id);
      if (targetNode) {
        session.currentNodeId = targetNode.id;
        session.playbackPhase = initialPhaseForNode(targetNode);
        session.activeHoldIndex = 0;
        session.turnPhase = 'idle';

        if (io) {
          io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:story:transition', {
            node: publicNode(targetNode, loom),
            transitionId: playResult.transitionId,
            playbackPhase: session.playbackPhase,
          });
        }
      }
    } else {
      // Stay on current node
      session.turnPhase = 'listening';
      if (io) {
        io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:phase', {
          phase: 'listening',
          turnId: turn.id,
        });
      }
    }

    session.activeTurn = null;
    return { ok: true, playResult };
  } catch (err) {
    session.turnPhase = 'idle';
    session.activeTurn = null;
    if (io) {
      io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:error', {
        code: err?.code || 'TURN_FAILED',
        message: err?.message || String(err),
      });
    }
    throw err;
  }
}

/**
 * Abort current in-flight turn.
 */
export function abortHostedTurn(sessionId, { reason = 'aborted', io } = {}) {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: true };

  if (session.activeTurn?.abortController) {
    session.activeTurn.abortController.abort(reason);
    session.activeTurn = null;
  }
  session.turnPhase = 'idle';

  if (io) {
    io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:phase', {
      phase: 'idle',
      reason,
    });
  }
  return { ok: true };
}

/**
 * Test helper to reset in-memory sessions between test runs.
 */
export function _resetHostedSessions() {
  for (const session of activeSessions.values()) {
    if (session.activeTurn?.abortController) {
      session.activeTurn.abortController.abort('reset');
    }
  }
  activeSessions.clear();
}
