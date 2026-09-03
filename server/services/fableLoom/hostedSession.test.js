import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  _getInternalSession,
  _resetHostedSessions,
  abortHostedTurn,
  checkHostedSessionReadiness,
  createHostedSession,
  endHostedSession,
  getHostedSession,
  initialPhaseForNode,
  processHostedUtterance,
  revalidateLiveConversationGate,
  sanitizeHostedSession,
  startHostedListening,
  startHostedSessionSweep,
  stopHostedSessionSweep,
  updateHostedSession,
  verifyHostedToken,
} from './hostedSession.js';
import * as records from './records.js';
import * as weave from './weave.js';
import * as networkExposure from '../../lib/networkExposure.js';
import * as tts from '../voice/tts.js';
import * as stt from '../voice/stt.js';
import * as voiceProfiles from '../voice/profiles.js';
import * as universeBuilder from '../universeBuilder.js';

describe('fableLoom hostedSession', () => {
  const mockLoom = {
    id: 'loom-1',
    name: 'Dragon Quest',
    format: 'prose',
    participationMode: 'helper',
    universeId: 'universe-1',
    episodes: [{
      id: 'ep-1',
      title: 'Episode 1',
      startNodeId: 'node-start',
      nodes: [
        {
          id: 'node-start',
          title: 'Forest Entrance',
          prose: 'You stand at the edge of the dark forest.',
          playbackMode: 'decision',
          audienceConnection: 'connected',
          protagonistPresence: 'offscreen',
          isEnding: false,
          playbackAssets: {
            holdLoopVideoHistoryIds: ['vid-hold-1'],
            audioOccupancy: {
              'vid-hold-1': { durationMs: 5000, characterDialogue: [], music: [], effects: [], safeForLiveVoice: true },
            },
          },
          transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'enter forest', triggers: ['go into forest'] }],
        },
        {
          id: 'node-2',
          title: 'Deep Woods',
          prose: 'The trees tower above you.',
          playbackMode: 'decision',
          audienceConnection: 'connected',
          protagonistPresence: 'offscreen',
          isEnding: false,
          transitions: [],
        },
      ],
    }],
  };

  // Hosted-session preflight gates on the live network posture. Every test
  // that isn't specifically exercising the HTTPS gate runs against this
  // TLS-provisioned snapshot so the rest of the readiness checks are what
  // the assertion is about.
  const httpsExposure = () => ({
    scheme: 'https',
    httpsEnabled: true,
    bind: { host: '0.0.0.0', port: 5555, audience: 'all-interfaces' },
    cert: { mode: 'tailscale', tailscaleHost: 'host-example.example-tailnet.ts.net' },
  });

  const httpExposure = () => ({
    ...httpsExposure(),
    scheme: 'http',
    httpsEnabled: false,
  });

  // A stub Socket.IO surface that records every namespace emit.
  const makeIo = () => {
    const emits = [];
    return {
      emits,
      of: () => ({
        to: (room) => ({
          emit: (event, payload) => emits.push({ room, event, payload }),
        }),
      }),
    };
  };

  // A promise the test resolves by hand, so one provider stage can be held
  // pending across a teardown without any real timing.
  const deferred = () => {
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    return { promise, ...settle };
  };

  beforeEach(() => {
    _resetHostedSessions();
    vi.restoreAllMocks();
    vi.spyOn(networkExposure, 'getNetworkExposureStatus').mockImplementation(httpsExposure);
    vi.spyOn(records, 'getLoom').mockResolvedValue(mockLoom);
    vi.spyOn(tts, 'synthesize').mockResolvedValue({
      wav: Buffer.from('RIFFmockwavdata'),
      latencyMs: 50,
      engine: 'kokoro',
    });
    vi.spyOn(stt, 'transcribe').mockResolvedValue({
      text: 'I want to enter the forest',
      latencyMs: 100,
    });
  });

  describe('initialPhaseForNode', () => {
    it('returns ended for ending nodes', () => {
      expect(initialPhaseForNode({ isEnding: true })).toBe('ended');
    });

    it('returns entry when entry clip is present', () => {
      expect(initialPhaseForNode({ playbackAssets: { entryVideoHistoryId: 'vid-entry-1' } })).toBe('entry');
    });

    it('returns hold when hold loops exist', () => {
      expect(initialPhaseForNode({ playbackAssets: { holdLoopVideoHistoryIds: ['vid-hold-1'] } })).toBe('hold');
    });
  });

  describe('checkHostedSessionReadiness', () => {
    it('passes readiness when loom, episode, and start scene are configured over HTTPS', async () => {
      const result = await checkHostedSessionReadiness({ loomId: 'loom-1', episodeId: 'ep-1' });
      expect(result.ready).toBe(true);
      expect(result.https.enabled).toBe(true);
      expect(result.https.url).toMatch(/^https:\/\//);
      expect(result.checks.https.ok).toBe(true);
      expect(result.checks.host.ok).toBe(true);
    });

    it('flags error when the install is serving plain HTTP', async () => {
      vi.spyOn(networkExposure, 'getNetworkExposureStatus').mockImplementation(httpExposure);
      const result = await checkHostedSessionReadiness({ loomId: 'loom-1', episodeId: 'ep-1' });
      expect(result.ready).toBe(false);
      expect(result.https.enabled).toBe(false);
      expect(result.checks.https.ok).toBe(false);
      expect(result.https.url).toMatch(/^http:\/\//);
      expect(result.errors).toContain(
        'HTTPS is required for mobile device QR microphone join (run npm run setup:cert to enable TLS).',
      );
    });

    it('flags error if start scene is missing', async () => {
      const badLoom = {
        ...mockLoom,
        episodes: [{ id: 'ep-1', startNodeId: 'missing-node', nodes: [] }],
      };
      vi.spyOn(records, 'getLoom').mockResolvedValue(badLoom);
      const result = await checkHostedSessionReadiness({ loomId: 'loom-1', episodeId: 'ep-1' });
      expect(result.ready).toBe(false);
      expect(result.errors).toContain('Episode does not have a valid start scene configured.');
    });
  });

  describe('createHostedSession & verifyHostedToken', () => {
    it('creates an active hosted session with hashed token and fragment join URL', async () => {
      const result = await createHostedSession('loom-1', 'ep-1', { audioTarget: 'host' });
      expect(result.session).toBeDefined();
      expect(result.session.id).toBeDefined();
      expect(result.session.status).toBe('active');
      expect(result.session.audioTarget).toBe('host');
      expect(result.session.currentNodeId).toBe('node-start');
      expect(result.token).toBeDefined();
      expect(result.token.length).toBe(64); // 256 bits hex
      expect(result.joinUrl).toContain(`#session=${result.session.id}&token=${result.token}`);

      // Internal storage verifies hashed token
      const internal = _getInternalSession(result.session.id);
      expect(internal.hashedToken).toBeDefined();
      expect(internal.hashedToken).not.toBe(result.token); // Hashed, not plaintext

      // Sanitized session omits hashedToken
      const sanitized = getHostedSession(result.session.id);
      expect(sanitized.hashedToken).toBeUndefined();

      // Verify token
      expect(verifyHostedToken(result.session.id, result.token)).toBe(true);
      expect(verifyHostedToken(result.session.id, 'wrong-token')).toBe(false);
      expect(verifyHostedToken('missing-session', result.token)).toBe(false);
    });

    it('refuses to start a session on an HTTP-only install with a 412 preflight failure', async () => {
      vi.spyOn(networkExposure, 'getNetworkExposureStatus').mockImplementation(httpExposure);
      await expect(createHostedSession('loom-1', 'ep-1', { audioTarget: 'host' })).rejects.toMatchObject({
        status: 412,
        code: 'HOSTED_SESSION_PREFLIGHT_FAILED',
      });
    });
  });

  describe('revalidateLiveConversationGate', () => {
    it('allows live conversation for connected helper decision hold scene with offscreen protagonist', () => {
      const session = { status: 'active', playbackPhase: 'hold' };
      const node = {
        audienceConnection: 'connected',
        playbackMode: 'decision',
        protagonistPresence: 'offscreen',
        isEnding: false,
      };
      const asset = { manifest: { safeForLiveVoice: true } };

      const gate = revalidateLiveConversationGate({ session, node, asset });
      expect(gate.allowed).toBe(true);
    });

    it('rejects if scene audience is disconnected', () => {
      const session = { status: 'active', playbackPhase: 'hold' };
      const node = { audienceConnection: 'disconnected', playbackMode: 'decision', protagonistPresence: 'offscreen' };
      expect(revalidateLiveConversationGate({ session, node }).allowed).toBe(false);
    });

    it('rejects if protagonist is onscreen', () => {
      const session = { status: 'active', playbackPhase: 'hold' };
      const node = { audienceConnection: 'connected', playbackMode: 'decision', protagonistPresence: 'onscreen' };
      expect(revalidateLiveConversationGate({ session, node }).allowed).toBe(false);
    });

    it('rejects if hold asset has blocking character dialogue', () => {
      const session = { status: 'active', playbackPhase: 'hold' };
      const node = { audienceConnection: 'connected', playbackMode: 'decision', protagonistPresence: 'offscreen' };
      const asset = { manifest: { safeForLiveVoice: false } };
      expect(revalidateLiveConversationGate({ session, node, asset }).allowed).toBe(false);
    });
  });

  describe('half-duplex turn execution', () => {
    it('executes full speech-first turn and commits story transition', async () => {
      const { session, token } = await createHostedSession('loom-1', 'ep-1');
      const mockIo = {
        of: () => ({
          to: () => ({
            emit: vi.fn(),
          }),
        }),
      };

      // 1. Start listening
      const listenRes = await startHostedListening(session.id, { io: mockIo });
      expect(listenRes.ok).toBe(true);
      expect(getHostedSession(session.id).turnPhase).toBe('listening');

      // Mock LLM play response
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'move',
        transitionId: 'tr-1',
        narration: 'We shall enter the dark woods together.',
        node: { id: 'node-2', title: 'Deep Woods' },
      });

      // 2. Process audience utterance
      const turnRes = await processHostedUtterance(session.id, {
        audioBuffer: Buffer.from('fake-audio-bytes'),
        io: mockIo,
      });

      expect(turnRes.ok).toBe(true);
      const afterSession = getHostedSession(session.id);
      expect(afterSession.currentNodeId).toBe('node-2'); // Moved to next node
      expect(afterSession.transcript.length).toBeGreaterThan(1);
    });

    it('synthesizes live replies with the approved interactive voice profile', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await startHostedListening(session.id);
      vi.spyOn(universeBuilder, 'getUniverse').mockResolvedValue({
        characters: [{ id: 'character-1', voiceId: 'kokoro:af_heart' }],
      });
      vi.spyOn(voiceProfiles, 'resolveCharacterVoice').mockResolvedValue({
        source: 'profile',
        profileId: 'voice-profile-1',
        profileRevision: 3,
        voiceId: 'qwen3-tts:character-1',
        degraded: false,
        warning: null,
      });
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'stay',
        narration: 'The signal is clear.',
        node: { id: 'node-start' },
      });

      await processHostedUtterance(session.id, { textMessage: 'Can you hear me?' });

      expect(tts.synthesize).toHaveBeenCalledWith('The signal is clear.', {
        engine: 'qwen3-tts',
        profileId: 'voice-profile-1',
        route: 'interactive',
        signal: expect.any(AbortSignal),
        voice: 'character-1',
      });
    });

    it('splits a namespaced character preset before live synthesis', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await startHostedListening(session.id);
      vi.spyOn(universeBuilder, 'getUniverse').mockResolvedValue({
        characters: [{ id: 'character-1', voiceId: 'kokoro:af_heart' }],
      });
      vi.spyOn(voiceProfiles, 'resolveCharacterVoice').mockResolvedValue({
        source: 'character-preset',
        profileId: null,
        profileRevision: null,
        voiceId: 'kokoro:af_heart',
        degraded: false,
        warning: null,
      });
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'stay',
        narration: 'Stay on the line.',
        node: { id: 'node-start' },
      });

      await processHostedUtterance(session.id, { textMessage: 'Hello?' });

      expect(tts.synthesize).toHaveBeenCalledWith('Stay on the line.', {
        engine: 'kokoro',
        profileId: undefined,
        route: 'interactive',
        signal: expect.any(AbortSignal),
        voice: 'af_heart',
      });
    });

    it('drops audio frames sent outside listening phase', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      // session is currently idle
      const res = await processHostedUtterance(session.id, {
        audioBuffer: Buffer.from('dropped'),
      });
      expect(res.dropped).toBe(true);
      expect(res.reason).toBe('NOT_IN_LISTENING_PHASE');
    });

    it('aborts active turn on request', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await startHostedListening(session.id);
      expect(getHostedSession(session.id).turnPhase).toBe('listening');

      abortHostedTurn(session.id);
      expect(getHostedSession(session.id).turnPhase).toBe('idle');
    });
  });

  describe('session teardown', () => {
    it('ends hosted session cleanly', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      expect(getHostedSession(session.id)).not.toBeNull();

      endHostedSession(session.id, { reason: 'user_ended' });
      expect(getHostedSession(session.id)).toBeNull();
    });

    // #5786: the turn holds `session`/`turn` across every provider await, so a
    // teardown landing mid-flight used to let the LLM and TTS run to completion
    // and emit turn frames AFTER the room's terminal `hosted:session:ended`.
    it('abandons a turn whose session is torn down mid story turn, emitting nothing after ended', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await startHostedListening(session.id, { io });

      const storyTurn = deferred();
      vi.spyOn(weave, 'playTurn').mockImplementation(() => storyTurn.promise);

      const pending = processHostedUtterance(session.id, {
        textMessage: 'What is behind the trees?',
        io,
      });
      await vi.waitFor(() => expect(weave.playTurn).toHaveBeenCalled());

      endHostedSession(session.id, { reason: 'user_ended', io });
      storyTurn.resolve({
        action: 'move',
        transitionId: 'tr-1',
        narration: 'We shall enter the dark woods together.',
        node: { id: 'node-2', title: 'Deep Woods' },
      });

      await expect(pending).resolves.toMatchObject({ aborted: true });
      // The provider work downstream of the abandoned stage never ran…
      expect(tts.synthesize).not.toHaveBeenCalled();
      // …and `hosted:session:ended` is the last thing the room ever saw.
      expect(io.emits.at(-1).event).toBe('hosted:session:ended');
    });

    it('treats an aborted transcription as a cancellation, not an empty utterance', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await startHostedListening(session.id, { io });

      const transcription = deferred();
      stt.transcribe.mockImplementation((_audio, opts) => {
        opts.signal.addEventListener('abort', () => transcription.reject(new Error('transcribe aborted')));
        return transcription.promise;
      });
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'stay',
        narration: 'Still here.',
        node: { id: 'node-start' },
      });

      const pending = processHostedUtterance(session.id, {
        audioBuffer: Buffer.from('fake-audio-bytes'),
        io,
      });
      await vi.waitFor(() => expect(stt.transcribe).toHaveBeenCalled());

      endHostedSession(session.id, { reason: 'expired', io });

      await expect(pending).resolves.toMatchObject({ aborted: true });
      // An abort used to fall through the STT catch as `{ text: '' }`, which
      // reads as a successfully-empty utterance rather than a cancellation.
      expect(weave.playTurn).not.toHaveBeenCalled();
      expect(io.emits.at(-1).event).toBe('hosted:session:ended');
    });
  });

  describe('expired-session sweep', () => {
    // Age a session past its TTL without waiting out 30 real minutes.
    const expire = (sessionId) => {
      const internal = _getInternalSession(sessionId);
      internal.expiresAt = new Date(Date.now() - 1000).toISOString();
      return internal;
    };

    afterEach(() => {
      stopHostedSessionSweep();
      vi.useRealTimers();
    });

    it('deletes an expired session on the next sweep tick, aborting its turn and notifying the room', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await startHostedListening(session.id);
      const internal = expire(session.id);
      const { signal } = internal.activeTurn.abortController;
      expect(signal.aborted).toBe(false);

      vi.useFakeTimers();
      startHostedSessionSweep({ intervalMs: 60_000, io });
      // Arming alone tears nothing down; the first tick does.
      expect(io.emits).toHaveLength(0);
      vi.advanceTimersByTime(60_000);

      expect(signal.aborted).toBe(true);
      expect(getHostedSession(session.id)).toBeNull();
      expect(io.emits).toContainEqual({
        room: `session:${session.id}`,
        event: 'hosted:session:ended',
        payload: { sessionId: session.id, reason: 'expired' },
      });
    });

    it('leaves an unexpired session untouched', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');

      vi.useFakeTimers();
      startHostedSessionSweep({ intervalMs: 60_000, io });
      vi.advanceTimersByTime(180_000);

      expect(getHostedSession(session.id)?.status).toBe('active');
      expect(io.emits).toHaveLength(0);
    });

    it('rejects a late reconnect: _getInternalSession returns null once the TTL has passed', async () => {
      const { session, token } = await createHostedSession('loom-1', 'ep-1');
      expect(_getInternalSession(session.id)).not.toBeNull();

      expire(session.id);

      // What the /fableloom-hosted handshake gates on, for host and audience alike.
      expect(_getInternalSession(session.id)).toBeNull();
      expect(verifyHostedToken(session.id, token)).toBe(false);
    });

    it('arms an unref\'d timer once and clears it on stop', () => {
      vi.useFakeTimers();
      const first = startHostedSessionSweep({ intervalMs: 60_000 });
      expect(first.unref).toBeTypeOf('function');
      // Re-arming is a no-op rather than a second leaked interval.
      expect(startHostedSessionSweep({ intervalMs: 60_000 })).toBe(first);
      expect(vi.getTimerCount()).toBe(1);

      stopHostedSessionSweep();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
