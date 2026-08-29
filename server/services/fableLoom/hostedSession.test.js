import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  updateHostedSession,
  verifyHostedToken,
} from './hostedSession.js';
import * as records from './records.js';
import * as weave from './weave.js';
import * as networkExposure from '../../lib/networkExposure.js';
import * as tts from '../voice/tts.js';
import * as stt from '../voice/stt.js';

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

  beforeEach(() => {
    _resetHostedSessions();
    vi.restoreAllMocks();
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
    it('passes readiness when loom, episode, and start scene are configured', async () => {
      const result = await checkHostedSessionReadiness({ loomId: 'loom-1', episodeId: 'ep-1' });
      expect(result.ready).toBe(true);
      expect(result.https.url).toMatch(/^https?:\/\//);
      expect(result.checks.host.ok).toBe(true);
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
  });
});
