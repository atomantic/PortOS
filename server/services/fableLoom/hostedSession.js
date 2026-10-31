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
 * 8. Speech dispatch stays uncommitted until the designated output reports playback (#13112).
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
  FABLELOOM_AUDIO_TARGETS,
  FABLELOOM_RUNTIME_VERSION,
  evaluateFableLoomLiveInput,
  resolvePlaybackPhaseAsset,
} from '../../lib/fableLoomPlayback.js';
import {
  findEpisode,
  getLoom,
} from './records.js';
import {
  publicNode,
  playTurn,
  resolvePlayRoute,
} from './weave.js';
import { getUniverse } from '../universeBuilder.js';
import { parseVoiceId } from '../pipeline/audio.js';

// Explicit casting wins over array order; legacy looms without a selection keep
// their first-character fallback. A deleted selection never becomes another actor.
const protagonistVoiceCharacter = (loom, universe) => loom.protagonistCharacterId
  ? universe?.characters?.find(character => character.id === loom.protagonistCharacterId) || null
  : universe?.characters?.[0] || null;

// Active hosted sessions in memory (ephemeral, machine-local)
const activeSessions = new Map();

// Default session time-to-live: 30 minutes
export const DEFAULT_SESSION_TTL_MINUTES = 30;
export const MAX_SESSION_TTL_MINUTES = 180;

// How often the sweeper walks `activeSessions` looking for expired records.
// TTLs run 1-180 minutes and a machine hosts at most a handful of sessions at
// once, so one unref'd interval is cheaper than arming (and having to cancel)
// a per-session timeout.
export const HOSTED_SESSION_SWEEP_INTERVAL_MS = 60_000;

// How long a dispatched narration may stay in `speaking` waiting for the
// designated output socket. Past this the pending transition is dropped — a
// missing completion is not a successful playback. Long enough for a spoken
// paragraph, short enough that a vanished client cannot hold the scene.
export const HOSTED_SPEECH_ACK_TIMEOUT_MS = 90_000;

/** True once a session record is past its TTL. */
const isExpired = (session) => new Date(session.expiresAt).getTime() <= Date.now();

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
    runtimeVersion: FABLELOOM_RUNTIME_VERSION,
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
  const joinHost = netStatus.cert?.tailscaleHost
    || (netStatus.bind?.host && !isLoopbackHost(netStatus.bind.host) && netStatus.bind.host !== '0.0.0.0' ? netStatus.bind.host : null)
    || 'localhost';
  const joinPort = netStatus.bind?.port || PORTS.API;
  const isHttps = netStatus.scheme === 'https';
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
    const protagonistChar = protagonistVoiceCharacter(loom, universe);
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
  const playbackReady = true;
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

  // An audience token authorizes story participation, never a host harness.
  // Keep authored narration available even if the configured narrator is unsafe.
  const llm = await resolvePlayRoute(loom, { callerPolicy: 'direct-api' })
    .then(() => ({ ok: true }))
    .catch(err => ({ ok: false, error: err.message, code: err.code || 'NO_PROVIDER' }));
  if (!llm.ok) warnings.push(`AI narrator unavailable; using authored narration: ${llm.error}`);

  const checks = {
    https: { ok: isHttps, ...(isHttps ? {} : { error: 'HTTPS required' }) },
    host: { ok: !!startNode, ...(startNode ? {} : { error: 'Missing start scene' }) },
    stt: { ok: sttReady },
    llm,
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
  if (session?.status !== 'active') {
    return { allowed: false, reason: 'SESSION_INACTIVE' };
  }
  return evaluateFableLoomLiveInput({
    node,
    phase: session.playbackPhase,
    asset,
  });
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
  // Generate 256-bit cryptographically secure tokens. The audience (QR/join
  // link) token and the host token are DISTINCT secrets — the audience token
  // must never grant `role: 'host'` (#8357), so each is hashed and verified
  // independently.
  const token = randomBytes(32).toString('hex');
  const hashedToken = createHash('sha256').update(token).digest('hex');
  const hostToken = randomBytes(32).toString('hex');
  const hashedHostToken = createHash('sha256').update(hostToken).digest('hex');

  const boundedTtl = Math.max(1, Math.min(MAX_SESSION_TTL_MINUTES, Number.isInteger(ttlMinutes) ? ttlMinutes : DEFAULT_SESSION_TTL_MINUTES));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + boundedTtl * 60 * 1000).toISOString();

  const rootBaseUrl = baseUrl || preflight.https.url;
  // Fragment-based QR URL: #session=...&token=... — carries ONLY the audience
  // token. The host token is returned in the create response and never
  // appears here.
  const joinUrl = `${rootBaseUrl}/fableloom/join#session=${sessionId}&token=${token}`;

  const session = {
    id: sessionId,
    loomId,
    episodeId,
    universeId: loom.universeId || null,
    hashedToken,
    hashedHostToken,
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
    pendingSpeech: null,
    sceneGeneration: 0,
    switchingEpisode: false,
    episodeSwitchGeneration: 0,
    createdAt: now.toISOString(),
    expiresAt,
  };

  activeSessions.set(sessionId, session);

  return {
    session: sanitizeHostedSession(session),
    token, // audience token — returned ONLY once to session creator; also embedded in joinUrl
    hostToken, // host token — returned ONLY once to session creator; NEVER embedded in joinUrl
    joinUrl,
    preflight,
  };
}

/** Shared constant-time comparison against a session's stored token hash. */
function verifyHostedTokenAgainst(sessionId, token, hashField) {
  if (!sessionId || !token || typeof token !== 'string') return false;
  const session = activeSessions.get(sessionId);
  if (session?.status !== 'active') return false;
  if (isExpired(session)) {
    session.status = 'ended';
    return false;
  }
  const storedHash = session[hashField];
  if (!storedHash) return false;
  const candidateHash = createHash('sha256').update(token).digest('hex');
  const storedBuf = Buffer.from(storedHash, 'hex');
  const candidateBuf = Buffer.from(candidateHash, 'hex');
  if (storedBuf.length !== candidateBuf.length) return false;
  return timingSafeEqual(storedBuf, candidateBuf);
}

/**
 * Verify the AUDIENCE join token for a hosted session using constant-time
 * comparison. Does not grant the host role — see `verifyHostedHostToken`.
 */
export function verifyHostedToken(sessionId, token) {
  return verifyHostedTokenAgainst(sessionId, token, 'hashedToken');
}

/**
 * Verify the HOST token for a hosted session using constant-time comparison
 * (#8357). This token is distinct from the audience join token embedded in
 * the QR `joinUrl` — the audience token must never authorize `role: 'host'`.
 */
export function verifyHostedHostToken(sessionId, token) {
  return verifyHostedTokenAgainst(sessionId, token, 'hashedHostToken');
}

/**
 * Retrieve active session by ID.
 */
export function getHostedSession(sessionId) {
  if (!sessionId) return null;
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  if (session.status === 'active' && isExpired(session)) {
    session.status = 'ended';
  }
  return sanitizeHostedSession(session);
}

/**
 * Internal session record retrieval for socket and service operations.
 *
 * Evaluates the TTL, so an expired record reads as absent even when nothing has
 * swept it yet — that is what stops a host reconnecting into the
 * `/fableloom-hosted` namespace minutes after its session should have died.
 */
export function _getInternalSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return null;
  if (session.status === 'active' && isExpired(session)) {
    session.status = 'ended';
  }
  if (session.status !== 'active') return null;
  return session;
}

/**
 * Update hosted session state (e.g. audio target, playback phase, current node).
 *
 * `currentNodeId` is validated against the session's CURRENT `episodeId` (only
 * when it actually changes — a phase/hold-index-only update skips the lookup).
 * Without this, a client that drifted from the server's episode (the host
 * advanced an episode without the server learning about it, #8112) would push
 * a node id that belongs to a different episode's graph; the audience's next
 * turn then resolves `findNode` against the WRONG episode, throws "Scene not
 * found", and silently falls back to canned narration with no visible error.
 * Rejecting here fails loudly instead, so a future client bug can't degrade
 * the same way in silence.
 */
export async function updateHostedSession(sessionId, patch = {}, { io } = {}) {
  const session = activeSessions.get(sessionId);
  if (session?.status !== 'active') {
    throw new ServerError('Hosted session not found or ended', { status: 404, code: 'SESSION_NOT_FOUND' });
  }

  // A `switchHostedEpisode` in flight is about to overwrite currentNodeId /
  // playbackPhase / activeHoldIndex with the NEW episode's values anyway. The
  // client's playback-sync effect fires on the very next React commit — well
  // before the switch's async loom-read/preflight work resolves server-side
  // — so a `currentNodeId` racing in during that window legitimately belonged
  // to the OLD episode a moment ago. Treat it as stale and no-op rather than
  // reject it as a `NODE_NOT_IN_EPISODE` bug (#8112).
  if (session.switchingEpisode) {
    return sanitizeHostedSession(session);
  }

  if (patch.audioTarget && FABLELOOM_AUDIO_TARGETS.includes(patch.audioTarget)) {
    session.audioTarget = patch.audioTarget;
  }
  if (patch.currentNodeId && patch.currentNodeId !== session.currentNodeId) {
    const loom = await getLoom(session.loomId);
    const episode = loom?.episodes?.find((e) => e.id === session.episodeId) || null;
    const nodeBelongsToEpisode = !!episode?.nodes?.some((n) => n.id === patch.currentNodeId);
    if (!nodeBelongsToEpisode) {
      throw new ServerError('currentNodeId does not belong to the hosted session\'s current episode', {
        status: 400,
        code: 'NODE_NOT_IN_EPISODE',
      });
    }
    session.currentNodeId = patch.currentNodeId;
    session.sceneGeneration += 1;
    // The host left the scene this narration was spoken against. Dropping the
    // wait here is what stops a late playback ack from committing that move
    // onto the scene the host already left.
    cancelPendingSpeech(session, sessionId, { io, reason: 'node_changed' });
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
 * Re-bind a hosted session to a different episode of the same loom, so the
 * audience's phone stays connected across an episode transition instead of
 * being silently stranded on the old episode's graph (#8112).
 *
 * Aborts any in-flight turn against the OLD episode first (a turn that
 * resolves mid-switch must not land narration/a transition against the new
 * one), re-runs the same readiness preflight `createHostedSession` requires,
 * and — on failure — ends the session outright via `endHostedSession` rather
 * than leaving it half-bound to an episode that can't play. Resets
 * `currentNodeId` to the new episode's opening node and clears the
 * transcript/turnPhase so the audience view starts clean.
 */
export async function switchHostedEpisode(sessionId, episodeId, { io } = {}) {
  const session = activeSessions.get(sessionId);
  if (session?.status !== 'active') {
    throw new ServerError('Hosted session not found or ended', { status: 404, code: 'SESSION_NOT_FOUND' });
  }

  // Serializes switches — without it, two overlapping calls (a host
  // double-clicking "Next Episode" before the first one's async work
  // resolves) could race and let the EARLIER request commit last, rebinding
  // the session to an episode the UI has already left.
  if (session.switchingEpisode) {
    throw new ServerError('An episode switch is already in progress', { status: 409, code: 'EPISODE_SWITCH_IN_PROGRESS' });
  }

  // Abort BEFORE the first await: a turn already in flight against the OLD
  // episode must not be able to resolve and commit narration/a transition
  // while this function is off awaiting the loom read below. Clear the speech
  // wait in the same turn so its timer cannot emit that transition later.
  cancelPendingSpeech(session, sessionId, { io, reason: 'episode_switch' });
  if (session.activeTurn?.abortController) {
    session.activeTurn.abortController.abort('episode_switch');
    session.activeTurn = null;
  }
  session.sceneGeneration += 1;
  // Blocks `startHostedListening` from starting a NEW turn for the rest of
  // this function — without it, a turn that starts during the awaits below
  // would run against the OLD episode and could commit/emit AFTER this
  // switch's `hosted:session:sync`, mixing old-episode content into the new
  // episode. Always cleared in `finally`, including on every early return.
  session.switchingEpisode = true;
  session.episodeSwitchGeneration += 1;

  // Re-checked after every await below — a host "end", DELETE /sessions/:id,
  // or the TTL sweep can tear this session down while we're off reading the
  // loom or running preflight. Without this a switch that loses that race
  // would resurrect a deleted session's state and emit `hosted:session:sync`
  // AFTER the room already saw the terminal `hosted:session:ended`.
  const isLive = () => activeSessions.get(sessionId) === session && session.status === 'active';

  try {
    const loom = await getLoom(session.loomId);
    if (!isLive()) return { ok: false, ended: true, reason: 'session_ended' };
    if (!loom) {
      throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
    }
    const episode = findEpisode(loom, episodeId);

    const preflight = await checkHostedSessionReadiness({ loomId: session.loomId, episodeId, loom, episode });
    if (!isLive()) return { ok: false, ended: true, reason: 'session_ended' };
    const startNode = preflight.ready
      ? episode.nodes?.find((n) => n.id === episode.startNodeId) || null
      : null;
    if (!preflight.ready || !startNode) {
      endHostedSession(sessionId, { reason: 'episode_not_ready', io });
      return { ok: false, ended: true, reason: 'episode_not_ready', preflight };
    }

    return commitHostedEpisodeSwitch(session, sessionId, episodeId, startNode, { io });
  } finally {
    session.switchingEpisode = false;
  }
}

function commitHostedEpisodeSwitch(session, sessionId, episodeId, startNode, { io }) {
  const now = new Date();
  session.episodeId = episodeId;
  session.currentNodeId = startNode.id;
  session.playbackPhase = initialPhaseForNode(startNode);
  session.activeHoldIndex = 0;
  session.turnPhase = 'idle';
  session.transcript = [{
    id: randomUUID(),
    role: 'narrator',
    text: startNode.prose || startNode.title || '',
    timestamp: now.toISOString(),
  }];
  session.recentTts = [];

  const sanitized = sanitizeHostedSession(session);
  if (io) {
    io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:session:sync', sanitized);
  }
  return { ok: true, session: sanitized };
}

/**
 * End a hosted session and notify connected clients.
 */
export function endHostedSession(sessionId, { reason = 'ended', io } = {}) {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: true };

  // Take the timer before the session leaves the map. A timeout that fires
  // after `hosted:session:ended` must not emit a transition into a dead room.
  takePendingSpeech(session);
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
  if (session?.status !== 'active') {
    throw new ServerError('Session is not active', { status: 400, code: 'SESSION_INACTIVE' });
  }

  // `switchHostedEpisode` holds this while it's off awaiting the loom read
  // and readiness preflight. Without this gate a turn could start against the
  // OLD episode mid-switch, then commit and emit AFTER the new episode's
  // `hosted:session:sync` — mixing old-episode content into the new episode.
  if (session.switchingEpisode) {
    throw new ServerError('An episode switch is in progress', { status: 409, code: 'EPISODE_SWITCH_IN_PROGRESS' });
  }

  // Reserve admission before the loom read so simultaneous mic/text starts
  // cannot replace each other's active turn while their gate checks await.
  if (session.startingListening) {
    throw new ServerError('A turn is already starting', { status: 409, code: 'TURN_IN_PROGRESS' });
  }
  session.startingListening = true;
  try {
    const episodeId = session.episodeId;
    const switchGeneration = session.episodeSwitchGeneration;
    const loom = await getLoom(session.loomId);
    if (activeSessions.get(sessionId) !== session || session.status !== 'active') {
      throw new ServerError('Session is not active', { status: 400, code: 'SESSION_INACTIVE' });
    }
    if (session.switchingEpisode || session.episodeSwitchGeneration !== switchGeneration || session.episodeId !== episodeId) {
      throw new ServerError('Session changed while starting the listening turn', { status: 409, code: 'EPISODE_SWITCH_IN_PROGRESS' });
    }

    const episode = loom.episodes?.find((e) => e.id === episodeId) || null;
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
  } finally {
    session.startingListening = false;
  }
}

function emitHosted(io, sessionId, event, payload) {
  if (!io) return;
  io.of('/fableloom-hosted').to(`session:${sessionId}`).emit(event, payload);
}

function designatedOutputSocketId(session) {
  if (!session) return null;
  return session.audioTarget === 'audience' ? session.audienceSocketId : session.hostSocketId;
}

function takePendingSpeech(session) {
  const pending = session?.pendingSpeech;
  if (!pending) return null;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  session.pendingSpeech = null;
  return pending;
}

// Drop a playback wait without committing its transition. `emit` is false when
// the caller is about to publish its own terminal phase (session end).
function cancelPendingSpeech(session, sessionId, { io, reason, emit = true } = {}) {
  const pending = takePendingSpeech(session);
  if (!pending) return false;
  if (session.activeTurn?.id === pending.turnId) {
    session.activeTurn.abortController?.abort(reason);
    session.activeTurn = null;
  }
  if (!emit || session.status !== 'active' || session.turnPhase !== 'speaking') return true;
  session.turnPhase = 'idle';
  emitHosted(io, sessionId, 'hosted:turn:phase', { phase: 'idle', turnId: pending.turnId, reason });
  return true;
}

function expireHostedSpeech(sessionId, turnId, io) {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'active') return;
  const pending = session.pendingSpeech;
  if (!pending || pending.turnId !== turnId) return;
  // A switch or scene change already owns the outcome. Clearing here must not
  // publish a phase (or a transition) for a turn the room has left.
  if (session.switchingEpisode
    || session.episodeSwitchGeneration !== pending.episodeSwitchGeneration
    || session.sceneGeneration !== pending.sceneGeneration
    || session.currentNodeId !== pending.sourceNodeId) {
    takePendingSpeech(session);
    return;
  }
  cancelPendingSpeech(session, sessionId, { io, reason: 'speech_timeout' });
  console.log(`⏭️ Hosted speech ${turnId} timed out before playback completion`);
}

function armPendingSpeech(session, sessionId, { io, turn, playResult, targetNode }) {
  const outputSocketId = designatedOutputSocketId(session);
  if (!outputSocketId) return false;
  const pending = {
    turnId: turn.id,
    target: session.audioTarget === 'audience' ? 'audience' : 'host',
    outputSocketId,
    episodeId: session.episodeId,
    episodeSwitchGeneration: session.episodeSwitchGeneration,
    sceneGeneration: session.sceneGeneration,
    sourceNodeId: session.currentNodeId,
    action: targetNode ? 'move' : 'stay',
    transitionId: targetNode ? playResult.transitionId : null,
    targetNodeId: targetNode?.id || null,
    timer: null,
  };
  pending.timer = setTimeout(() => {
    try {
      expireHostedSpeech(sessionId, pending.turnId, io);
    } catch (err) {
      console.error(`❌ Hosted speech timeout failed: ${err.message}`);
    }
  }, HOSTED_SPEECH_ACK_TIMEOUT_MS);
  pending.timer.unref?.();
  session.pendingSpeech = pending;
  turn.outputSocketId = outputSocketId;
  return true;
}

function commitHostedMove(session, sessionId, { io, loom, targetNode, transitionId }) {
  session.currentNodeId = targetNode.id;
  session.playbackPhase = initialPhaseForNode(targetNode);
  session.activeHoldIndex = 0;
  session.sceneGeneration += 1;
  session.turnPhase = 'idle';
  session.activeTurn = null;
  emitHosted(io, sessionId, 'hosted:story:transition', {
    node: publicNode(targetNode, loom),
    transitionId,
    playbackPhase: session.playbackPhase,
  });
}

function releaseHostedStay(session, sessionId, { io, turnId }) {
  session.turnPhase = 'listening';
  session.activeTurn = null;
  emitHosted(io, sessionId, 'hosted:turn:phase', { phase: 'listening', turnId });
}

function speechClaimStillCurrent(session, sessionId, claim) {
  return activeSessions.get(sessionId) === session
    && session.status === 'active'
    && !session.switchingEpisode
    && session.turnPhase === 'speaking'
    && session.activeTurn?.id === claim.turnId
    && !session.activeTurn.abortController.signal.aborted
    && session.episodeId === claim.episodeId
    && session.episodeSwitchGeneration === claim.episodeSwitchGeneration
    && session.sceneGeneration === claim.sceneGeneration
    && session.currentNodeId === claim.sourceNodeId;
}

/**
 * Finish or drop the narration that `processHostedUtterance` left in `speaking`.
 *
 * Only the designated output socket's current-turn `ended` commits, and only
 * after the session, episode, and scene generations still match the dispatch.
 * Anything else leaves the node where it was.
 */
export async function acknowledgeHostedSpeech(sessionId, {
  turnId,
  role,
  socketId,
  status,
  io,
} = {}) {
  const session = _getInternalSession(sessionId);
  const pending = session?.pendingSpeech;
  if (!session || !pending) return { accepted: false, reason: 'NO_PENDING_SPEECH' };
  if (pending.turnId !== turnId) return { accepted: false, reason: 'STALE_TURN' };
  if (role !== pending.target) return { accepted: false, reason: 'WRONG_ROLE' };
  if (!socketId || socketId !== pending.outputSocketId) return { accepted: false, reason: 'WRONG_SOCKET' };
  if (!speechClaimStillCurrent(session, sessionId, pending)) return { accepted: false, reason: 'STALE_TURN' };
  if (status !== 'ended' && status !== 'failed' && status !== 'aborted') {
    return { accepted: false, reason: 'INVALID_STATUS' };
  }

  if (status === 'ended' && pending.acknowledging) return { accepted: false, reason: 'ACKNOWLEDGEMENT_IN_PROGRESS' };
  // Keep the original deadline while the authoritative scene read is pending.
  // Its timeout invalidates this turn, so a delayed read cannot commit later.
  const claim = status === 'ended' ? pending : takePendingSpeech(session);
  if (status !== 'ended') {
    if (session.activeTurn?.id === claim.turnId) {
      session.activeTurn.abortController?.abort(status === 'failed' ? 'playback_failed' : 'playback_aborted');
      session.activeTurn = null;
    }
    if (session.turnPhase === 'speaking') {
      session.turnPhase = 'idle';
      emitHosted(io, sessionId, 'hosted:turn:phase', {
        phase: 'idle',
        turnId: claim.turnId,
        reason: status === 'failed' ? 'playback_failed' : 'playback_aborted',
      });
    }
    return { accepted: true, committed: false };
  }

  claim.acknowledging = true;
  try {
    const loom = await getLoom(session.loomId);
    if (!speechClaimStillCurrent(session, sessionId, claim)) {
      // The scene changed while this acknowledgement was being checked.
      // Release this speaking turn without changing a successor's state.
      if (activeSessions.get(sessionId) === session
        && session.status === 'active'
        && session.turnPhase === 'speaking'
        && session.activeTurn?.id === claim.turnId) {
        session.activeTurn.abortController?.abort('speech_superseded');
        session.activeTurn = null;
        session.turnPhase = 'idle';
        emitHosted(io, sessionId, 'hosted:turn:phase', {
          phase: 'idle',
          turnId: claim.turnId,
          reason: 'speech_superseded',
        });
      }
      return { accepted: false, committed: false, reason: 'STALE_TURN' };
    }
    if (claim.action !== 'move') {
      releaseHostedStay(session, sessionId, { io, turnId: claim.turnId });
      return { accepted: true, committed: true };
    }
    const episode = loom?.episodes?.find((item) => item.id === claim.episodeId) || null;
    const source = episode?.nodes?.find((node) => node.id === claim.sourceNodeId) || null;
    const transition = source?.transitions?.find((item) => item.id === claim.transitionId) || null;
    const targetNode = episode?.nodes?.find((node) => node.id === claim.targetNodeId) || null;
    if (!transition || transition.targetNodeId !== claim.targetNodeId || !targetNode) {
      session.activeTurn = null;
      session.turnPhase = 'idle';
      emitHosted(io, sessionId, 'hosted:turn:phase', {
        phase: 'idle',
        turnId: claim.turnId,
        reason: 'transition_unavailable',
      });
      return { accepted: true, committed: false, reason: 'TRANSITION_UNAVAILABLE' };
    }
    commitHostedMove(session, sessionId, {
      io,
      loom,
      targetNode,
      transitionId: claim.transitionId,
    });
    return { accepted: true, committed: true };
  } catch (err) {
    if (speechClaimStillCurrent(session, sessionId, claim)) {
      session.activeTurn = null;
      session.turnPhase = 'idle';
      emitHosted(io, sessionId, 'hosted:turn:phase', {
        phase: 'idle',
        turnId: claim.turnId,
        reason: 'speech_commit_failed',
      });
    }
    console.error(`❌ Hosted speech commit failed: ${err?.message || err}`);
    return { accepted: false, committed: false, reason: 'COMMIT_FAILED' };
  } finally {
    if (session.pendingSpeech === claim) takePendingSpeech(session);
  }
}

/**
 * The designated output disconnected while its narration was still in flight.
 * A replacement socket must not inherit the wait: it never played this audio.
 */
export function releaseHostedSpeechOutput(sessionId, socketId, { io } = {}) {
  const session = activeSessions.get(sessionId);
  if (!session || session.status !== 'active' || !socketId) return { released: false };
  const pendingMatches = session.pendingSpeech?.outputSocketId === socketId;
  const claimedMatches = session.turnPhase === 'speaking' && session.activeTurn?.outputSocketId === socketId;
  if (!pendingMatches && !claimedMatches) return { released: false };
  if (pendingMatches) cancelPendingSpeech(session, sessionId, { io, reason: 'output_disconnected' });
  else if (session.activeTurn?.outputSocketId === socketId) {
    const turnId = session.activeTurn.id;
    session.activeTurn.abortController?.abort('output_disconnected');
    session.activeTurn = null;
    session.turnPhase = 'idle';
    emitHosted(io, sessionId, 'hosted:turn:phase', {
      phase: 'idle',
      turnId,
      reason: 'output_disconnected',
    });
  }
  return { released: true };
}

const HOSTED_TRANSCRIPT_LIMIT = 50;

function appendTranscriptItem(session, role, text, extra = {}) {
  const item = { id: randomUUID(), role, text, timestamp: new Date().toISOString(), ...extra };
  session.transcript.push(item);
  if (session.transcript.length > HOSTED_TRANSCRIPT_LIMIT) session.transcript.shift();
  return item;
}

// Raw PCM frames (any typed-array view other than a Buffer) arrive from the
// browser mic; encoded audio arrives as a Buffer and is passed through.
const isRawPcmFrame = (audio) => ArrayBuffer.isView(audio) && !(audio instanceof Buffer);

/** Resolves to the trimmed transcript, or null when the turn was cancelled. */
async function transcribeTurnAudio(audioBuffer, signal) {
  const wavPayload = isRawPcmFrame(audioBuffer)
    ? pcmToWavBuffer(pcmToFloat(audioBuffer), { sampleRate: 16000 })
    : audioBuffer;
  const sttResult = await transcribe(wavPayload, { signal }).catch((err) => {
    // A torn-down turn aborts this signal. That is a cancellation, not a
    // successful empty transcription, and must not fall through as one.
    if (signal.aborted) return null;
    console.warn(`⚠️ [HostedPlay] STT transcription failed: ${err.message}`);
    return { text: '' };
  });
  return sttResult ? (sttResult.text || '').trim() : null;
}

/** Resolves to `{ playResult }`, or null when the turn died while the story turn ran. */
async function playStoryTurn(session, { loom, node, message, signal, isLive }) {
  try {
    const playResult = await playTurn(session.loomId, session.episodeId, {
      nodeId: session.currentNodeId,
      message,
      signal,
      callerPolicy: 'direct-api',
      transcript: session.transcript.map((t) => ({
        role: t.role === 'audience' ? 'reader' : 'narrator',
        text: t.text,
      })),
    });
    return { playResult };
  } catch (err) {
    // A cancelled turn has no one left to narrate to — the authored fallback
    // would only produce a reply for a room that already saw `ended`.
    if (!isLive()) return null;
    console.warn(`⚠️ [HostedPlay] LLM turn error, using authored fallback: ${err?.message}`);
    return {
      playResult: {
        action: 'stay',
        narration: node?.prose?.slice(0, 200) || "I hear you. Let's see what happens next.",
        node: node ? publicNode(node, loom) : null,
        ended: false,
      },
    };
  }
}

async function resolveProtagonistVoice(loom) {
  const universe = loom.universeId ? await getUniverse(loom.universeId).catch(() => null) : null;
  const char = protagonistVoiceCharacter(loom, universe);
  return resolveCharacterVoice({
    universeId: loom.universeId,
    characterId: char?.id,
    characterVoiceId: char?.voiceId,
    route: 'interactive',
  }).catch(() => null);
}

/** Resolves to the narration WAV, or null when synthesis failed or was cancelled. */
async function synthesizeNarration(narration, resolved, signal) {
  const { engine, voice } = parseVoiceId(resolved?.voiceId);
  const synth = await synthesize(narration, {
    engine: engine || undefined,
    profileId: resolved?.profileId || undefined,
    route: 'interactive',
    signal,
    voice: voice || undefined,
  }).catch((err) => {
    if (!signal.aborted) console.warn(`⚠️ [HostedPlay] Protagonist TTS synthesis failed: ${err.message}`);
    return null;
  });
  return synth?.wav || null;
}

function moveTargetNode(playResult, episode) {
  if (playResult.action !== 'move' || !playResult.transitionId || !episode) return null;
  return episode.nodes?.find((node) => node.id === playResult.node?.id) || null;
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
  if (session?.status !== 'active') {
    throw new ServerError('Session is not active', { status: 400, code: 'SESSION_INACTIVE' });
  }

  if (session.turnPhase !== 'listening') {
    // Drop frames/utterances received outside LISTENING phase
    return { dropped: true, reason: 'NOT_IN_LISTENING_PHASE' };
  }

  const turn = session.activeTurn || { id: randomUUID(), abortController: new AbortController(), startedAt: Date.now() };
  session.activeTurn = turn;
  session.turnPhase = 'thinking';
  const { signal } = turn.abortController;

  // This function holds `session` and `turn` across every provider await, but a
  // teardown landing mid-turn (host "end", DELETE /sessions/:id, or the TTL
  // sweep) aborts the controller, clears `activeTurn` and drops the map entry.
  // Re-derive liveness at each boundary so no provider work starts — and no
  // frame is emitted — after the terminal `hosted:session:ended` (#5786).
  const isLive = () => !signal.aborted
    && activeSessions.get(sessionId) === session
    && session.status === 'active'
    && session.activeTurn === turn;

  const emitIfLive = (event, payload) => {
    if (io && isLive()) io.of('/fableloom-hosted').to(`session:${sessionId}`).emit(event, payload);
  };

  const abandonedResult = { ok: true, aborted: true, turnId: turn.id };
  const abandonTurn = (stage) => {
    console.log(`🛑 Hosted turn ${turn.id} abandoned during ${stage} — session no longer live`);
    return abandonedResult;
  };

  emitIfLive('hosted:turn:phase', { phase: 'thinking', turnId: turn.id });

  try {
    let message = textMessage || '';

    // 1. Transcribe audio if supplied
    if (audioBuffer && !message.trim()) {
      const transcript = await transcribeTurnAudio(audioBuffer, signal);
      if (transcript === null || !isLive()) return abandonTurn('transcription');
      message = transcript;
    }

    // Check for echo / empty message
    if (!message.trim() || isEchoOfRecentTts(message, session.recentTts)) {
      session.turnPhase = 'listening';
      emitIfLive('hosted:turn:phase', {
        phase: 'listening',
        turnId: turn.id,
        note: 'ignored-echo-or-empty',
      });
      return { ok: true, ignored: true };
    }

    emitIfLive('hosted:turn:transcript', appendTranscriptItem(session, 'audience', message));

    // 2. Run LLM Play Turn
    const loom = await getLoom(session.loomId);
    if (!isLive()) return abandonTurn('loom load');
    const episode = loom.episodes?.find((e) => e.id === session.episodeId) || null;
    const node = episode?.nodes?.find((n) => n.id === session.currentNodeId) || null;

    const story = await playStoryTurn(session, { loom, node, message, signal, isLive });
    if (!story || !isLive()) return abandonTurn('story turn');
    const { playResult } = story;

    const narration = (playResult?.narration || '').trim() || "Let's continue.";
    const protagonistItem = appendTranscriptItem(session, 'protagonist', narration, { audioTarget: session.audioTarget });

    // 3. Synthesize Protagonist Voice
    session.turnPhase = 'speaking';
    rememberTtsSentence(session.recentTts, narration);

    emitIfLive('hosted:turn:phase', { phase: 'speaking', turnId: turn.id, text: narration });
    emitIfLive('hosted:turn:transcript', protagonistItem);

    let ttsAudio = null;
    try {
      const resolved = await resolveProtagonistVoice(loom);
      if (!isLive()) return abandonTurn('voice resolution');
      ttsAudio = await synthesizeNarration(narration, resolved, signal);
    } catch (err) {
      console.warn(`⚠️ [HostedPlay] Protagonist TTS synthesis failed: ${err.message}`);
    }
    if (!isLive()) return abandonTurn('speech synthesis');

    const targetNode = moveTargetNode(playResult, episode);

    // 4. Dispatch audio to the designated output. While that socket is
    // connected, the move stays pending: committing here is what let the
    // scene change under audio that was still playing.
    if (ttsAudio) {
      emitIfLive('hosted:turn:tts', {
        audio: Buffer.from(ttsAudio).toString('base64'),
        mimeType: 'audio/wav',
        target: session.audioTarget,
        turnId: turn.id,
      });
    }
    if (!isLive()) return abandonTurn('speech dispatch');

    if (ttsAudio && armPendingSpeech(session, sessionId, { io, turn, playResult, targetNode })) {
      return { ok: true, awaitingSpeech: true, turnId: turn.id, playResult };
    }

    // No audio (synthesis failed) or no connected output: nothing is playing,
    // so the narration text is the whole delivery and the turn commits now.
    if (targetNode) {
      commitHostedMove(session, sessionId, {
        io,
        loom,
        targetNode,
        transitionId: playResult.transitionId,
      });
    } else {
      releaseHostedStay(session, sessionId, { io, turnId: turn.id });
    }
    return { ok: true, playResult };
  } catch (err) {
    takePendingSpeech(session);
    // A failure that lands after teardown has no room left to tell: the session
    // already emitted its terminal frame, so log and swallow rather than
    // emitting `hosted:error` behind it.
    if (!isLive()) {
      console.warn(`⚠️ [HostedPlay] Hosted turn ${turn.id} failed after teardown: ${err?.message || err}`);
      return abandonedResult;
    }
    // Emit BEFORE clearing `activeTurn` — clearing it first makes the turn
    // non-live and would suppress the very error frame the client needs.
    emitIfLive('hosted:error', {
      code: err?.code || 'TURN_FAILED',
      message: err?.message || String(err),
    });
    // Without a phase frame every client stays in `thinking` (mic and text
    // input disabled) until a reload resyncs.
    session.turnPhase = 'idle';
    emitIfLive('hosted:turn:phase', { phase: 'idle', turnId: turn.id });
    session.activeTurn = null;
    // Tells the socket handlers this failure already reached the room.
    if (err && typeof err === 'object') err.hostedReported = true;
    throw err;
  }
}

/**
 * Abort current in-flight turn.
 */
export function abortHostedTurn(sessionId, { reason = 'aborted', io } = {}) {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: true };

  const turnId = session.pendingSpeech?.turnId || session.activeTurn?.id || null;
  takePendingSpeech(session);
  if (session.activeTurn?.abortController) {
    session.activeTurn.abortController.abort(reason);
    session.activeTurn = null;
  }
  session.turnPhase = 'idle';

  if (io) {
    io.of('/fableloom-hosted').to(`session:${sessionId}`).emit('hosted:turn:phase', {
      phase: 'idle',
      reason,
      ...(turnId ? { turnId } : {}),
    });
  }
  return { ok: true };
}

let sweepTimer = null;
let sweepIo = null;

/**
 * Arm the expired-session sweeper.
 *
 * Expiry used to be evaluated only when something happened to look a session up,
 * and even then it just flipped `status` — so the normal end of a QR play
 * session (guest closes the tab, host navigates away) left the record, its node
 * history and its live `AbortController` resident for the process lifetime, and
 * the room never saw `hosted:session:ended`. The sweep reuses `endHostedSession`
 * so teardown stays in one place.
 */
export function startHostedSessionSweep({ intervalMs = HOSTED_SESSION_SWEEP_INTERVAL_MS, io = null } = {}) {
  sweepIo = io || sweepIo;
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    // Timer callback — outside the request lifecycle, so an uncaught throw here
    // would take the process down instead of reaching error middleware.
    try {
      sweepExpiredHostedSessions();
    } catch (err) {
      console.error(`❌ FableLoom hosted-session sweep failed: ${err.message}`);
    }
  }, intervalMs);
  sweepTimer.unref?.();
  return sweepTimer;
}

/** Disarm the sweeper (graceful shutdown, tests). */
export function stopHostedSessionSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  sweepIo = null;
}

/**
 * Tear down every expired or already-ended session. Exported so a test (and a
 * future manual "clean up" action) can run one tick without waiting on wall time.
 */
export function sweepExpiredHostedSessions({ io = sweepIo } = {}) {
  const doomed = [];
  for (const [id, session] of activeSessions) {
    if (session.status !== 'active' || isExpired(session)) doomed.push(id);
  }
  for (const id of doomed) {
    endHostedSession(id, { reason: 'expired', io });
  }
  if (doomed.length) {
    console.log(`🧹 Swept ${doomed.length} expired FableLoom hosted session(s)`);
  }
  return doomed.length;
}

/**
 * Test helper to reset in-memory sessions between test runs.
 */
export function _resetHostedSessions() {
  stopHostedSessionSweep();
  for (const session of activeSessions.values()) {
    takePendingSpeech(session);
    if (session.activeTurn?.abortController) {
      session.activeTurn.abortController.abort('reset');
    }
  }
  activeSessions.clear();
}
