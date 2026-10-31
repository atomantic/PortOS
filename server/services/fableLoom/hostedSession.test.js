import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  _getInternalSession,
  _resetHostedSessions,
  HOSTED_SPEECH_ACK_TIMEOUT_MS,
  abortHostedTurn,
  acknowledgeHostedSpeech,
  checkHostedSessionReadiness,
  createHostedSession,
  endHostedSession,
  getHostedSession,
  initialPhaseForNode,
  processHostedUtterance,
  releaseHostedSpeechOutput,
  revalidateLiveConversationGate,
  startHostedListening,
  startHostedSessionSweep,
  stopHostedSessionSweep,
  switchHostedEpisode,
  updateHostedSession,
  verifyHostedHostToken,
  verifyHostedToken,
} from './hostedSession.js';
import { FABLELOOM_RUNTIME_VERSION } from '../../lib/fableLoomPlayback.js';
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
    }, {
      id: 'ep-2',
      title: 'Episode 2',
      startNodeId: 'node-ep2-start',
      nodes: [
        {
          id: 'node-ep2-start',
          title: 'Mountain Pass',
          prose: 'Snow crunches underfoot as you climb.',
          playbackMode: 'decision',
          audienceConnection: 'connected',
          protagonistPresence: 'offscreen',
          isEnding: false,
          transitions: [{ id: 'tr-ep2-1', targetNodeId: 'node-ep2-start', intent: 'keep climbing', triggers: ['climb'] }],
        },
      ],
    }, {
      id: 'ep-3-not-ready',
      title: 'Episode 3',
      startNodeId: 'missing-start-node',
      nodes: [],
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
      expect(result.session.runtimeVersion).toBe(FABLELOOM_RUNTIME_VERSION);
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

    it('mints a separate host token that never appears in the join URL (#8357)', async () => {
      const result = await createHostedSession('loom-1', 'ep-1', { audioTarget: 'host' });
      expect(result.hostToken).toBeDefined();
      expect(result.hostToken.length).toBe(64); // 256 bits hex
      expect(result.hostToken).not.toBe(result.token);
      expect(result.joinUrl).not.toContain(result.hostToken);

      // Internal storage verifies hashed host token, distinct from the audience hash
      const internal = _getInternalSession(result.session.id);
      expect(internal.hashedHostToken).toBeDefined();
      expect(internal.hashedHostToken).not.toBe(internal.hashedToken);
      expect(internal.hashedHostToken).not.toBe(result.hostToken); // Hashed, not plaintext

      // Sanitized session omits hashedHostToken
      const sanitized = getHostedSession(result.session.id);
      expect(sanitized.hashedHostToken).toBeUndefined();

      // The audience token must NOT verify as a host token, and vice versa
      expect(verifyHostedHostToken(result.session.id, result.hostToken)).toBe(true);
      expect(verifyHostedHostToken(result.session.id, result.token)).toBe(false);
      expect(verifyHostedToken(result.session.id, result.hostToken)).toBe(false);
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

  describe('runtime v1 listening admission', () => {
    // These regressions are checked at turn admission: a stale host phase,
    // explicit window presence or unsafe occupancy must never start providers.
    it.each([
      ['cut node with stale hold phase', { playbackMode: 'cut' }, 'hold', 'PLAYBACK_NOT_DECISION'],
      ['decision entry clip', {}, 'entry', 'PLAYBACK_NOT_IN_HOLD_PHASE'],
      ['decision exit clip', {}, 'exit', 'PLAYBACK_NOT_IN_HOLD_PHASE'],
      ['disconnected decision', { audienceConnection: 'disconnected' }, 'hold', 'AUDIENCE_DISCONNECTED'],
      ['onscreen live window', { interactionWindow: { enabled: true, protagonistPresence: 'onscreen' } }, 'hold', 'PROTAGONIST_ONSCREEN'],
      ['occupied hold', {
        playbackAssets: {
          holdLoopVideoHistoryIds: ['vid-dialogue'],
          audioOccupancy: { 'vid-dialogue': { characterDialogue: [{ startMs: 0, endMs: 1000 }], safeForLiveVoice: true } },
        },
      }, 'hold', 'HOLD_ASSET_OCCUPIED_BY_DIALOGUE'],
    ])('refuses %s before starting a turn', async (_label, patch, phase, code) => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const changedLoom = structuredClone(mockLoom);
      Object.assign(changedLoom.episodes[0].nodes[0], patch);
      vi.mocked(records.getLoom).mockResolvedValue(changedLoom);
      _getInternalSession(session.id).playbackPhase = phase;
      vi.spyOn(weave, 'playTurn');
      const io = makeIo();

      await expect(startHostedListening(session.id, { io })).rejects.toMatchObject({ status: 409, code });

      expect(weave.playTurn).not.toHaveBeenCalled();
      expect(stt.transcribe).not.toHaveBeenCalled();
      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(getHostedSession(session.id).turnPhase).toBe('idle');
      expect(io.emits).toEqual([]);
    });

    it('retains the legacy decision default for a connected offscreen hold', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const legacyLoom = structuredClone(mockLoom);
      delete legacyLoom.episodes[0].nodes[0].playbackMode;
      vi.mocked(records.getLoom).mockResolvedValue(legacyLoom);

      await expect(startHostedListening(session.id)).resolves.toMatchObject({ ok: true });
      expect(getHostedSession(session.id).turnPhase).toBe('listening');
    });
  });

  describe('half-duplex turn execution', () => {
    it('dispatches synthesized speech before committing the story transition', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const io = makeIo();
      const speech = deferred();
      vi.mocked(tts.synthesize).mockReturnValue(speech.promise);
      await startHostedListening(session.id, { io });
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'move', transitionId: 'tr-1',
        narration: 'We shall enter the dark woods together.',
        node: { id: 'node-2', title: 'Deep Woods' },
      });

      const pending = processHostedUtterance(session.id, {
        audioBuffer: Buffer.from('fake-audio-bytes'), io,
      });
      await vi.waitFor(() => expect(tts.synthesize).toHaveBeenCalled());
      expect(getHostedSession(session.id)).toMatchObject({
        currentNodeId: 'node-start', turnPhase: 'speaking',
      });
      expect(io.emits.some(({ event }) => event === 'hosted:story:transition')).toBe(false);

      speech.resolve({ wav: Buffer.from('RIFFmockwavdata') });
      await expect(pending).resolves.toMatchObject({ ok: true });

      expect(io.emits.filter(({ event }) => [
        'hosted:turn:phase', 'hosted:turn:tts', 'hosted:story:transition',
      ].includes(event)).map(({ event, payload }) => payload.phase || event)).toEqual([
        'listening', 'thinking', 'speaking', 'hosted:turn:tts', 'hosted:story:transition',
      ]);
      expect(getHostedSession(session.id).currentNodeId).toBe('node-2');
    });

    it('synthesizes the selected protagonist with its approved AuK profile regardless of character order', async () => {
      vi.spyOn(records, 'getLoom').mockResolvedValue({ ...mockLoom, protagonistCharacterId: 'character-1' });
      vi.spyOn(universeBuilder, 'getUniverse').mockResolvedValue({
        characters: [{ id: 'another-character' }, { id: 'character-1', voiceId: 'piper:example' }],
      });
      vi.spyOn(voiceProfiles, 'resolveCharacterVoice').mockResolvedValue({
        source: 'profile',
        profileId: 'voice-profile-1',
        profileRevision: 3,
        voiceId: 'auk:character-1',
        degraded: false,
        warning: null,
      });
      const { session } = await createHostedSession('loom-1', 'ep-1');
      expect(voiceProfiles.resolveCharacterVoice).toHaveBeenLastCalledWith(expect.objectContaining({ characterId: 'character-1', route: 'interactive' }));
      await startHostedListening(session.id);
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'stay',
        narration: 'The signal is clear.',
        node: { id: 'node-start' },
      });

      await processHostedUtterance(session.id, { textMessage: 'Can you hear me?' });

      expect(voiceProfiles.resolveCharacterVoice).toHaveBeenLastCalledWith(expect.objectContaining({ characterId: 'character-1', route: 'interactive' }));
      expect(tts.synthesize).toHaveBeenCalledWith('The signal is clear.', {
        engine: 'auk',
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

  describe('turn stages', () => {
    const stay = (narration = 'The forest waits.') => ({ action: 'stay', narration, node: { id: 'node-start' } });

    const listen = async (io = makeIo(), loom = mockLoom) => {
      vi.mocked(records.getLoom).mockResolvedValue(loom);
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await startHostedListening(session.id, { io });
      return { session, io };
    };

    it('wraps raw PCM frames in a WAV container and passes encoded audio through unchanged', async () => {
      const { session } = await listen();
      vi.spyOn(weave, 'playTurn').mockResolvedValue(stay());

      await processHostedUtterance(session.id, { audioBuffer: new Int16Array([0, 1200, -1200, 0]) });
      const [pcmPayload] = stt.transcribe.mock.calls[0];
      expect(Buffer.isBuffer(pcmPayload)).toBe(true);
      expect(pcmPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');

      await startHostedListening(session.id);
      const encoded = Buffer.from('already-encoded-wav');
      vi.mocked(stt.transcribe).mockResolvedValueOnce({ text: '  I go north  ' });
      await processHostedUtterance(session.id, { audioBuffer: encoded });
      expect(stt.transcribe.mock.calls[1][0]).toBe(encoded);
      expect(weave.playTurn.mock.calls[1][2].message).toBe('I go north');
    });

    it('uses a typed message instead of transcribing audio that arrived with it', async () => {
      const { session } = await listen();
      vi.spyOn(weave, 'playTurn').mockResolvedValue(stay());

      await processHostedUtterance(session.id, { audioBuffer: Buffer.from('audio'), textMessage: 'open the gate' });

      expect(stt.transcribe).not.toHaveBeenCalled();
      expect(weave.playTurn).toHaveBeenCalledWith('loom-1', 'ep-1', expect.objectContaining({ message: 'open the gate' }));
    });

    it.each([
      ['a failed transcription', () => vi.mocked(stt.transcribe).mockRejectedValue(new Error('stt offline'))],
      ['a blank transcription', () => vi.mocked(stt.transcribe).mockResolvedValue({ text: '   ' })],
      ['a transcription without text', () => vi.mocked(stt.transcribe).mockResolvedValue({})],
    ])('returns to listening without a story turn after %s', async (_label, arrange) => {
      const { session, io } = await listen();
      arrange();
      vi.spyOn(weave, 'playTurn');

      await expect(processHostedUtterance(session.id, { audioBuffer: Buffer.from('audio'), io }))
        .resolves.toEqual({ ok: true, ignored: true });

      expect(weave.playTurn).not.toHaveBeenCalled();
      expect(getHostedSession(session.id).turnPhase).toBe('listening');
      expect(io.emits.at(-1)).toMatchObject({
        event: 'hosted:turn:phase', payload: { phase: 'listening', note: 'ignored-echo-or-empty' },
      });
    });

    it('ignores the room hearing its own narration back on the next turn', async () => {
      const { session } = await listen();
      vi.spyOn(weave, 'playTurn').mockResolvedValue(stay('The lantern flickers in the wind.'));

      await processHostedUtterance(session.id, { textMessage: 'what do I see' });
      expect(getHostedSession(session.id).turnPhase).toBe('listening');

      await expect(processHostedUtterance(session.id, { textMessage: 'The lantern flickers in the wind.' }))
        .resolves.toEqual({ ok: true, ignored: true });
      expect(weave.playTurn).toHaveBeenCalledTimes(1);
    });

    it('keeps the latest 50 transcript items and hands the story turn reader/narrator roles', async () => {
      const { session } = await listen();
      const internal = _getInternalSession(session.id);
      internal.transcript = Array.from({ length: 50 }, (_, i) => ({
        id: `t-${i}`, role: i % 2 ? 'protagonist' : 'audience', text: `line ${i}`,
      }));
      vi.spyOn(weave, 'playTurn').mockResolvedValue(stay('Onward.'));

      await processHostedUtterance(session.id, { textMessage: 'newest line' });

      const sent = weave.playTurn.mock.calls[0][2].transcript;
      expect(sent).toHaveLength(50);
      expect(sent[0]).toEqual({ role: 'narrator', text: 'line 1' });
      expect(sent.at(-2)).toEqual({ role: 'narrator', text: 'line 49' });
      expect(sent.at(-1)).toEqual({ role: 'reader', text: 'newest line' });
      expect(internal.transcript).toHaveLength(50);
      expect(internal.transcript.at(-1)).toMatchObject({ role: 'protagonist', text: 'Onward.', audioTarget: 'host' });
      expect(internal.transcript.at(-2)).toMatchObject({ role: 'audience', text: 'newest line' });
    });

    it.each([
      ['the scene prose', 'You stand at the edge of the dark forest.', 'You stand at the edge of the dark forest.'],
      ['the first 200 characters of long prose', 'a'.repeat(260), 'a'.repeat(200)],
      ['a generic line for a scene without prose', '', "I hear you. Let's see what happens next."],
    ])('narrates %s when the story turn fails', async (_label, prose, expected) => {
      const loom = structuredClone(mockLoom);
      loom.episodes[0].nodes[0].prose = prose;
      const { session } = await listen(makeIo(), loom);
      vi.spyOn(weave, 'playTurn').mockRejectedValue(new Error('provider down'));

      const result = await processHostedUtterance(session.id, { textMessage: 'hello' });

      expect(result.playResult).toMatchObject({ action: 'stay', narration: expected, ended: false, node: { id: 'node-start' } });
      expect(tts.synthesize).toHaveBeenCalledWith(expected, expect.any(Object));
    });

    it('speaks a generic line when the story turn narrates nothing', async () => {
      const { session } = await listen();
      vi.spyOn(weave, 'playTurn').mockResolvedValue(stay('   '));

      await processHostedUtterance(session.id, { textMessage: 'hello' });

      expect(tts.synthesize).toHaveBeenCalledWith("Let's continue.", expect.any(Object));
      expect(_getInternalSession(session.id).transcript.at(-1).text).toBe("Let's continue.");
    });

    it.each([
      ['a move without a transition', { action: 'move', narration: 'Hmm.', node: { id: 'node-2' } }],
      ['a stay that names a transition', { action: 'stay', transitionId: 'tr-1', narration: 'Hmm.', node: { id: 'node-2' } }],
    ])('keeps the current scene for %s', async (_label, playResult) => {
      const { session, io } = await listen();
      vi.spyOn(weave, 'playTurn').mockResolvedValue(playResult);

      await processHostedUtterance(session.id, { textMessage: 'go', io });

      expect(io.emits.some(({ event }) => event === 'hosted:story:transition')).toBe(false);
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'listening' });
    });

    it.each([
      ['its own code', Object.assign(new Error('loom vanished'), { code: 'LOOM_GONE' }), 'LOOM_GONE'],
      ['the generic code', new Error('disk read failed'), 'TURN_FAILED'],
    ])('reports a mid-turn failure to the room with %s and resets the turn', async (_label, failure, code) => {
      const { session, io } = await listen();
      vi.mocked(records.getLoom).mockRejectedValueOnce(failure);

      await expect(processHostedUtterance(session.id, { textMessage: 'hello', io }))
        .rejects.toMatchObject({ message: failure.message, hostedReported: true });

      expect(io.emits.slice(-2)).toEqual([
        { room: `session:${session.id}`, event: 'hosted:error', payload: { code, message: failure.message } },
        { room: `session:${session.id}`, event: 'hosted:turn:phase', payload: { phase: 'idle', turnId: expect.any(String) } },
      ]);
      expect(getHostedSession(session.id).turnPhase).toBe('idle');
      expect(_getInternalSession(session.id).activeTurn).toBeNull();
    });

    it('swallows a failure that lands after teardown instead of reporting it behind ended', async () => {
      const { session, io } = await listen();
      const loomRead = deferred();
      vi.mocked(records.getLoom).mockImplementationOnce(() => loomRead.promise);
      vi.spyOn(weave, 'playTurn');

      const pending = processHostedUtterance(session.id, { textMessage: 'hello', io });
      await vi.waitFor(() => expect(io.emits.some(({ event }) => event === 'hosted:turn:transcript')).toBe(true));
      endHostedSession(session.id, { reason: 'user_ended', io });
      loomRead.reject(new Error('late failure'));

      await expect(pending).resolves.toMatchObject({ ok: true, aborted: true });
      expect(weave.playTurn).not.toHaveBeenCalled();
      expect(io.emits.at(-1).event).toBe('hosted:session:ended');
    });

    it('starts no story turn when the session ends while the loom loads', async () => {
      const { session, io } = await listen();
      const loomRead = deferred();
      vi.mocked(records.getLoom).mockImplementationOnce(() => loomRead.promise);
      vi.spyOn(weave, 'playTurn');

      const pending = processHostedUtterance(session.id, { textMessage: 'hello', io });
      await vi.waitFor(() => expect(io.emits.some(({ event }) => event === 'hosted:turn:transcript')).toBe(true));
      endHostedSession(session.id, { reason: 'user_ended', io });
      loomRead.resolve(mockLoom);

      await expect(pending).resolves.toMatchObject({ aborted: true });
      expect(weave.playTurn).not.toHaveBeenCalled();
      expect(io.emits.at(-1).event).toBe('hosted:session:ended');
    });

    it('starts no synthesis when the session ends while the voice resolves', async () => {
      const { session, io } = await listen();
      vi.spyOn(weave, 'playTurn').mockResolvedValue(stay());
      const voice = deferred();
      vi.spyOn(voiceProfiles, 'resolveCharacterVoice').mockImplementation(() => voice.promise);

      const pending = processHostedUtterance(session.id, { textMessage: 'hello', io });
      await vi.waitFor(() => expect(voiceProfiles.resolveCharacterVoice).toHaveBeenCalled());
      endHostedSession(session.id, { reason: 'user_ended', io });
      voice.resolve({ voiceId: 'kokoro:af_heart' });

      await expect(pending).resolves.toMatchObject({ aborted: true });
      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(io.emits.at(-1).event).toBe('hosted:session:ended');
    });
  });

  describe('speech completion before commitment', () => {
    const move = {
      action: 'move',
      transitionId: 'tr-1',
      narration: 'We shall enter the dark woods together.',
      node: { id: 'node-2', title: 'Deep Woods' },
    };

    const connectOutput = (session, role = 'host') => {
      const internal = _getInternalSession(session.id);
      const socketId = `${role}-sock`;
      if (role === 'audience') {
        internal.audioTarget = 'audience';
        internal.audienceSocketId = socketId;
      } else {
        internal.hostSocketId = socketId;
      }
      return socketId;
    };

    const speakMove = async (session, io) => {
      await startHostedListening(session.id, { io });
      vi.spyOn(weave, 'playTurn').mockResolvedValue(move);
      return processHostedUtterance(session.id, { textMessage: 'enter the forest', io });
    };

    const transitions = (io) => io.emits.filter((event) => event.event === 'hosted:story:transition');

    it('keeps the old node and refuses overlapping input until the designated output ends playback', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const io = makeIo();
      const socketId = connectOutput(session, 'host');
      const result = await speakMove(session, io);

      expect(result).toMatchObject({ ok: true, awaitingSpeech: true });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'speaking' });
      expect(transitions(io)).toHaveLength(0);
      expect(io.emits.some((event) => event.event === 'hosted:turn:tts')).toBe(true);

      await expect(processHostedUtterance(session.id, { textMessage: 'again', io }))
        .resolves.toMatchObject({ dropped: true, reason: 'NOT_IN_LISTENING_PHASE' });
      await expect(startHostedListening(session.id, { io })).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS' });
      expect(getHostedSession(session.id).currentNodeId).toBe('node-start');

      await expect(acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'audience', socketId: 'audience-sock', status: 'ended', io,
      })).resolves.toMatchObject({ accepted: false });
      await expect(acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId: 'someone-else', status: 'ended', io,
      })).resolves.toMatchObject({ accepted: false, reason: 'WRONG_SOCKET' });
      await expect(acknowledgeHostedSpeech(session.id, {
        turnId: '00000000-0000-4000-8000-000000000000', role: 'host', socketId, status: 'ended', io,
      })).resolves.toMatchObject({ accepted: false, reason: 'STALE_TURN' });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'speaking' });

      await expect(acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId, status: 'ended', io,
      })).resolves.toMatchObject({ accepted: true, committed: true });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-2', turnPhase: 'idle' });
      expect(transitions(io)).toHaveLength(1);

      await expect(acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId, status: 'ended', io,
      })).resolves.toMatchObject({ accepted: false, reason: 'NO_PENDING_SPEECH' });
      expect(transitions(io)).toHaveLength(1);
    });

    it('lets only the audience output commit when audio is aimed at the audience', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1', { audioTarget: 'audience' });
      const io = makeIo();
      const socketId = connectOutput(session, 'audience');
      _getInternalSession(session.id).hostSocketId = 'host-sock';
      const result = await speakMove(session, io);

      await acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId: 'host-sock', status: 'ended', io,
      });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'speaking' });

      await acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'audience', socketId, status: 'ended', io,
      });
      expect(getHostedSession(session.id).currentNodeId).toBe('node-2');
      expect(transitions(io)).toHaveLength(1);
    });

    it('commits immediately on the narration text when synthesis fails', async () => {
      vi.mocked(tts.synthesize).mockResolvedValueOnce(null);
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const io = makeIo();
      connectOutput(session, 'host');

      const result = await speakMove(session, io);

      expect(result.awaitingSpeech).toBeUndefined();
      expect(io.emits.some((event) => event.event === 'hosted:turn:tts')).toBe(false);
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-2', turnPhase: 'idle' });
      expect(transitions(io)).toHaveLength(1);
    });

    it('drops the pending move on playback failure without a transition', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const io = makeIo();
      const socketId = connectOutput(session, 'host');
      const result = await speakMove(session, io);

      await expect(acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId, status: 'failed', io,
      })).resolves.toMatchObject({ accepted: true, committed: false });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'idle' });
      expect(transitions(io)).toHaveLength(0);

      await startHostedListening(session.id, { io });
      const next = await processHostedUtterance(session.id, { textMessage: 'enter the forest', io });
      await acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId, status: 'ended', io,
      });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'speaking' });
      await acknowledgeHostedSpeech(session.id, {
        turnId: next.turnId, role: 'host', socketId, status: 'ended', io,
      });
      expect(getHostedSession(session.id).currentNodeId).toBe('node-2');
      expect(transitions(io)).toHaveLength(1);
    });

    it('drops the pending move when acknowledgement times out, and a late ack cannot commit it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { session } = await createHostedSession('loom-1', 'ep-1');
        const io = makeIo();
        const socketId = connectOutput(session, 'host');
        const result = await speakMove(session, io);
        expect(result.awaitingSpeech).toBe(true);

        await vi.advanceTimersByTimeAsync(HOSTED_SPEECH_ACK_TIMEOUT_MS - 1);
        expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'speaking' });
        await vi.advanceTimersByTimeAsync(1);

        expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'idle' });
        expect(transitions(io)).toHaveLength(0);
        await acknowledgeHostedSpeech(session.id, {
          turnId: result.turnId, role: 'host', socketId, status: 'ended', io,
        });
        expect(getHostedSession(session.id).currentNodeId).toBe('node-start');
        expect(transitions(io)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('bounds acknowledgement processing when its loom read stalls and rejects the late read', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { session } = await createHostedSession('loom-1', 'ep-1');
        const io = makeIo();
        const socketId = connectOutput(session, 'host');
        const result = await speakMove(session, io);
        const gate = deferred();
        records.getLoom.mockImplementationOnce(() => gate.promise);
        const acknowledgement = acknowledgeHostedSpeech(session.id, {
          turnId: result.turnId, role: 'host', socketId, status: 'ended', io,
        });
        await vi.advanceTimersByTimeAsync(HOSTED_SPEECH_ACK_TIMEOUT_MS);
        expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'idle' });
        expect(transitions(io)).toHaveLength(0);
        const next = await startHostedListening(session.id, { io });
        gate.resolve(mockLoom);
        await expect(acknowledgement).resolves.toMatchObject({ accepted: false, committed: false });
        expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'listening' });
        expect(_getInternalSession(session.id).activeTurn.id).toBe(next.turnId);
        expect(transitions(io)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not emit a transition when playback is aborted, the output disconnects, or the session ends', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const socketId = connectOutput(session, 'host');
      const aborted = await speakMove(session, io);
      abortHostedTurn(session.id, { reason: 'client_aborted', io });
      expect(io.emits.filter((event) => event.event === 'hosted:turn:phase').at(-1)?.payload).toMatchObject({
        phase: 'idle',
        turnId: aborted.turnId,
        reason: 'client_aborted',
      });
      await acknowledgeHostedSpeech(session.id, {
        turnId: aborted.turnId, role: 'host', socketId, status: 'ended', io,
      });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'idle' });

      const disconnected = await speakMove(session, io);
      releaseHostedSpeechOutput(session.id, socketId, { io });
      await acknowledgeHostedSpeech(session.id, {
        turnId: disconnected.turnId, role: 'host', socketId, status: 'ended', io,
      });
      expect(transitions(io)).toHaveLength(0);

      const ending = await speakMove(session, io);
      endHostedSession(session.id, { reason: 'host_ended', io });
      expect(io.emits.at(-1).event).toBe('hosted:session:ended');
      expect(transitions(io)).toHaveLength(0);
      expect(ending.awaitingSpeech).toBe(true);
    });

    it('drops a pending move when the host switches episodes', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const socketId = connectOutput(session, 'host');
      const pending = await speakMove(session, io);

      await switchHostedEpisode(session.id, 'ep-2', { io });
      await acknowledgeHostedSpeech(session.id, {
        turnId: pending.turnId, role: 'host', socketId, status: 'ended', io,
      });
      expect(getHostedSession(session.id)).toMatchObject({
        episodeId: 'ep-2', currentNodeId: 'node-ep2-start', turnPhase: 'idle',
      });
      expect(transitions(io)).toHaveLength(0);
    });

    it('refuses to commit after the scene generation changes during acknowledgement', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const socketId = connectOutput(session, 'host');
      const result = await speakMove(session, io);
      const gate = deferred();
      records.getLoom.mockImplementationOnce(() => gate.promise);

      const ack = acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId, status: 'ended', io,
      });
      _getInternalSession(session.id).sceneGeneration += 1;
      gate.resolve(mockLoom);

      await expect(ack).resolves.toMatchObject({ accepted: false, committed: false });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'idle' });
      expect(transitions(io)).toHaveLength(0);
    });

    it('returns to listening without a transition when a stay finishes playback', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const io = makeIo();
      const socketId = connectOutput(session, 'host');
      await startHostedListening(session.id, { io });
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'stay',
        narration: 'We hold the path.',
        node: { id: 'node-start' },
      });

      const result = await processHostedUtterance(session.id, { textMessage: 'wait', io });

      expect(result.awaitingSpeech).toBe(true);
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'speaking' });
      await acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId, status: 'ended', io,
      });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'listening' });
      expect(transitions(io)).toHaveLength(0);
    });

    it('drops the pending move when the output reports playback aborted', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const io = makeIo();
      const socketId = connectOutput(session, 'host');
      const result = await speakMove(session, io);

      await expect(acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId, status: 'aborted', io,
      })).resolves.toMatchObject({ accepted: true, committed: false });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'idle' });
      expect(io.emits.some((event) => event.payload?.reason === 'playback_aborted')).toBe(true);
      expect(transitions(io)).toHaveLength(0);
    });

    it('drops a pending move when the host leaves the scene before playback ends', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const io = makeIo();
      const socketId = connectOutput(session, 'host');
      const result = await speakMove(session, io);

      await updateHostedSession(session.id, { currentNodeId: 'node-2' }, { io });

      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-2', turnPhase: 'idle' });
      expect(transitions(io)).toHaveLength(0);
      await acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId, status: 'ended', io,
      });
      expect(getHostedSession(session.id).currentNodeId).toBe('node-2');
      expect(transitions(io)).toHaveLength(0);
    });

    it('does not commit a move whose transition disappeared before playback ended', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const socketId = connectOutput(session, 'host');
      const result = await speakMove(session, io);
      const changed = structuredClone(mockLoom);
      changed.episodes[0].nodes[0].transitions = [];
      records.getLoom.mockResolvedValue(changed);

      await expect(acknowledgeHostedSpeech(session.id, {
        turnId: result.turnId, role: 'host', socketId, status: 'ended', io,
      })).resolves.toMatchObject({ committed: false, reason: 'TRANSITION_UNAVAILABLE' });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-start', turnPhase: 'idle' });
      expect(transitions(io)).toHaveLength(0);
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

  // #8112: the host can advance episodes without the server ever learning
  // about it, so a hosted session used to keep resolving audience turns
  // against the OLD episode's graph — findNode throws "Scene not found" and
  // every turn silently falls back to canned narration.
  describe('updateHostedSession — currentNodeId episode validation', () => {
    it('accepts a currentNodeId that belongs to the session episode', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const updated = await updateHostedSession(session.id, { currentNodeId: 'node-2' });
      expect(updated.currentNodeId).toBe('node-2');
    });

    it('rejects a currentNodeId from another episode and leaves the session unchanged', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await expect(updateHostedSession(session.id, { currentNodeId: 'node-ep2-start' }))
        .rejects.toMatchObject({ status: 400, code: 'NODE_NOT_IN_EPISODE' });
      expect(getHostedSession(session.id).currentNodeId).toBe('node-start');
    });

    it('skips the episode lookup when currentNodeId is unchanged', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      records.getLoom.mockClear();
      const updated = await updateHostedSession(session.id, { currentNodeId: 'node-start', playbackPhase: 'hold' });
      expect(updated.playbackPhase).toBe('hold');
      expect(records.getLoom).not.toHaveBeenCalled();
    });
  });

  describe('switchHostedEpisode', () => {
    it('re-binds the session to the new episode, resets to its opening node, and clears the transcript', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');

      const result = await switchHostedEpisode(session.id, 'ep-2', { io });
      expect(result.ok).toBe(true);
      expect(result.session.currentNodeId).toBe('node-ep2-start');

      const updated = getHostedSession(session.id);
      expect(updated.currentNodeId).toBe('node-ep2-start');
      expect(updated.playbackPhase).toBe('hold');
      expect(updated.turnPhase).toBe('idle');
      expect(updated.transcript).toHaveLength(1);
      expect(updated.transcript[0].role).toBe('narrator');

      // A subsequent audience turn resolves against episode 2's graph rather
      // than throwing "Scene not found" against the old episode.
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'stay',
        narration: 'The pass stretches on.',
        node: { id: 'node-ep2-start' },
      });
      await startHostedListening(session.id, { io });
      const turnResult = await processHostedUtterance(session.id, { textMessage: 'keep climbing', io });
      expect(turnResult.playResult.narration).toBe('The pass stretches on.');
      expect(weave.playTurn).toHaveBeenCalledWith('loom-1', 'ep-2', expect.objectContaining({ nodeId: 'node-ep2-start' }));

      expect(io.emits.some((e) => e.event === 'hosted:session:sync')).toBe(true);
    });

    it('aborts an in-flight turn against the old episode before switching', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await startHostedListening(session.id, { io });

      const storyTurn = deferred();
      vi.spyOn(weave, 'playTurn').mockImplementation(() => storyTurn.promise);
      const pending = processHostedUtterance(session.id, { textMessage: 'enter the forest', io });
      await vi.waitFor(() => expect(weave.playTurn).toHaveBeenCalled());

      await switchHostedEpisode(session.id, 'ep-2', { io });
      storyTurn.resolve({ action: 'stay', narration: 'too late', node: { id: 'node-start' } });

      await expect(pending).resolves.toMatchObject({ aborted: true });
      expect(getHostedSession(session.id).currentNodeId).toBe('node-ep2-start');
    });

    it('ends the session with reason episode_not_ready when the target episode fails preflight', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');

      const result = await switchHostedEpisode(session.id, 'ep-3-not-ready', { io });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('episode_not_ready');
      expect(getHostedSession(session.id)).toBeNull();
      expect(io.emits.at(-1)).toMatchObject({ event: 'hosted:session:ended', payload: { reason: 'episode_not_ready' } });
    });

    it('throws when the target episode does not belong to the session loom', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      await expect(switchHostedEpisode(session.id, 'not-an-episode')).rejects.toMatchObject({ status: 404 });
    });

    // A host "end", DELETE /sessions/:id, or the TTL sweep can land while
    // switchHostedEpisode is off awaiting the loom read or preflight. Losing
    // that race must not resurrect the deleted session's state or emit
    // hosted:session:sync AFTER the room already saw hosted:session:ended.
    it('does not resurrect a session torn down while awaiting the loom read', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');

      const loomRead = deferred();
      records.getLoom.mockImplementationOnce(() => loomRead.promise);

      const pending = switchHostedEpisode(session.id, 'ep-2', { io });
      endHostedSession(session.id, { reason: 'host_ended', io });
      loomRead.resolve(mockLoom);

      await expect(pending).resolves.toMatchObject({ ok: false, reason: 'session_ended' });
      expect(getHostedSession(session.id)).toBeNull();
      expect(io.emits.at(-1).event).toBe('hosted:session:ended');
    });

    // Without this gate a turn that starts while the switch is off awaiting
    // the loom read/preflight would run against the OLD episode and could
    // commit and emit AFTER the new episode's hosted:session:sync, mixing
    // old-episode content into the new episode.
    it('refuses to start a new turn while a switch is in flight, and allows one once it settles', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');

      const loomRead = deferred();
      records.getLoom.mockImplementationOnce(() => loomRead.promise);

      const pending = switchHostedEpisode(session.id, 'ep-2');
      await expect(startHostedListening(session.id)).rejects.toMatchObject({
        status: 409,
        code: 'EPISODE_SWITCH_IN_PROGRESS',
      });

      loomRead.resolve(mockLoom);
      await pending;

      const listenRes = await startHostedListening(session.id);
      expect(listenRes.ok).toBe(true);
    });

    it('rejects a listen request whose loom read resumes after an episode switch', async () => {
      const io = makeIo();
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const pendingRead = deferred();
      records.getLoom
        .mockImplementationOnce(() => pendingRead.promise)
        .mockResolvedValueOnce(mockLoom);

      const pendingListen = startHostedListening(session.id, { io });
      await switchHostedEpisode(session.id, 'ep-2', { io });
      const syncIndex = io.emits.findLastIndex((event) => event.event === 'hosted:session:sync');

      pendingRead.resolve(mockLoom);
      await expect(pendingListen).rejects.toMatchObject({
        status: 409,
        code: 'EPISODE_SWITCH_IN_PROGRESS',
      });

      expect(getHostedSession(session.id)).toMatchObject({ episodeId: 'ep-2', turnPhase: 'idle' });
      expect(io.emits.slice(syncIndex + 1).some((event) => event.event === 'hosted:turn:phase')).toBe(false);
    });

    // Without this, a host double-clicking "Next Episode" before the first
    // switch's async loom-read/preflight resolves fires two overlapping
    // calls that race — the earlier request could commit last and rebind the
    // session to an episode the UI already left.
    it('rejects a second switch while one is already in flight', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');

      const loomRead = deferred();
      records.getLoom.mockImplementationOnce(() => loomRead.promise);

      const pending = switchHostedEpisode(session.id, 'ep-2');
      await expect(switchHostedEpisode(session.id, 'ep-3-not-ready')).rejects.toMatchObject({
        status: 409,
        code: 'EPISODE_SWITCH_IN_PROGRESS',
      });

      loomRead.resolve(mockLoom);
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(getHostedSession(session.id).episodeId).toBe('ep-2');
    });

    // The client's playback-sync effect fires on the very next React commit
    // after "Next Episode" — well before switchHostedEpisode's async work
    // resolves server-side — so a `hosted:playback:update` racing in during
    // that window carries a currentNodeId that legitimately belonged to the
    // OLD episode a moment ago. It must no-op, not reject as drift (#8112).
    it('treats a currentNodeId update that races with an in-flight switch as a stale no-op', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');

      const loomRead = deferred();
      records.getLoom.mockImplementationOnce(() => loomRead.promise);

      const pending = switchHostedEpisode(session.id, 'ep-2');
      const updated = await updateHostedSession(session.id, { currentNodeId: 'node-2' });
      expect(updated.currentNodeId).toBe('node-start');

      loomRead.resolve(mockLoom);
      await pending;
      expect(getHostedSession(session.id).currentNodeId).toBe('node-ep2-start');
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
