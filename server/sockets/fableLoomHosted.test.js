import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerFableLoomHostedNamespace,
  getHostedNamespace,
} from './fableLoomHosted.js';
import {
  _getInternalSession,
  _resetHostedSessions,
  createHostedSession,
  getHostedSession,
} from '../services/fableLoom/hostedSession.js';
import * as records from '../services/fableLoom/records.js';
import * as weave from '../services/fableLoom/weave.js';
import * as networkExposure from '../lib/networkExposure.js';
import * as tts from '../services/voice/tts.js';
import * as stt from '../services/voice/stt.js';

describe('fableLoomHosted Socket.IO namespace', () => {
  const mockLoom = {
    id: 'loom-1',
    name: 'Story 1',
    format: 'prose',
    participationMode: 'helper',
    episodes: [{
      id: 'ep-1',
      title: 'Episode 1',
      startNodeId: 'node-1',
      nodes: [{
        id: 'node-1',
        title: 'Start',
        prose: 'Opening prose',
        playbackMode: 'decision',
        audienceConnection: 'connected',
        protagonistPresence: 'offscreen',
        isEnding: false,
        playbackAssets: { holdLoopVideoHistoryIds: ['vid-1'] },
        transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'go next' }],
      }, {
        id: 'node-2',
        title: 'Next',
        prose: 'Second scene prose',
        playbackMode: 'decision',
        audienceConnection: 'connected',
        protagonistPresence: 'offscreen',
        isEnding: false,
        playbackAssets: { holdLoopVideoHistoryIds: ['vid-2'] },
        transitions: [],
      }],
    }],
  };

  let mockIo;
  let middleware;
  let connectionHandler;
  let mockNamespace;
  let roomEvents;

  /**
   * Socket.IO socket double. `listeners` and `emitted` hang off the returned
   * object so a test can drive one handler and read that socket's own emissions
   * without threading three values around.
   */
  const makeSocket = ({ role, sessionId, id = `${role}-sock` }) => {
    const listeners = {};
    const emitted = [];
    return {
      id,
      hostedRole: role,
      hostedSessionId: sessionId,
      join: vi.fn(),
      emit: vi.fn((event, data) => emitted.push({ event, data })),
      on: vi.fn((event, fn) => { listeners[event] = fn; }),
      removeAllListeners: vi.fn(),
      listeners,
      emitted,
    };
  };

  const roomEvent = (event) => roomEvents.find((e) => e.event === event);

  beforeEach(() => {
    _resetHostedSessions();
    vi.restoreAllMocks();
    // createHostedSession runs the readiness preflight, which refuses to start
    // a session unless the install is serving HTTPS.
    vi.spyOn(networkExposure, 'getNetworkExposureStatus').mockReturnValue({
      scheme: 'https',
      httpsEnabled: true,
      bind: { host: '0.0.0.0', port: 5555, audience: 'all-interfaces' },
      cert: { mode: 'tailscale', tailscaleHost: 'host-example.example-tailnet.ts.net' },
    });
    vi.spyOn(records, 'getLoom').mockResolvedValue(mockLoom);
    vi.spyOn(tts, 'synthesize').mockResolvedValue({ wav: Buffer.from('mockwav'), latencyMs: 20 });
    vi.spyOn(stt, 'transcribe').mockResolvedValue({ text: 'go next', latencyMs: 50 });

    roomEvents = [];
    mockNamespace = {
      sockets: new Map(),
      use: vi.fn((fn) => { middleware = fn; }),
      on: vi.fn((evt, fn) => {
        if (evt === 'connection') connectionHandler = fn;
      }),
      to: vi.fn((room) => ({
        emit: vi.fn((event, data) => {
          roomEvents.push({ room, event, data });
        }),
      })),
    };

    mockIo = {
      of: vi.fn(() => mockNamespace),
    };

    registerFableLoomHostedNamespace(mockIo);
  });

  it('registers namespace at /fableloom-hosted', () => {
    expect(mockIo.of).toHaveBeenCalledWith('/fableloom-hosted');
    expect(getHostedNamespace()).toBe(mockNamespace);
    expect(middleware).toBeDefined();
    expect(connectionHandler).toBeDefined();
  });

  describe('handshake auth middleware', () => {
    it('rejects connection without sessionId', async () => {
      const socket = { handshake: { auth: {} } };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('SESSION_ID_REQUIRED');
    });

    it('rejects audience connection with missing/invalid token', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'audience', token: 'bad-token' },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('HOSTED_SESSION_UNAUTHORIZED');
    });

    it('allows audience connection with valid token', async () => {
      const { session, token } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'audience', token },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith();
      expect(socket.hostedRole).toBe('audience');
      expect(socket.hostedSessionId).toBe(session.id);
    });

    it('rejects host connection without a token', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'host' },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('HOSTED_SESSION_UNAUTHORIZED');
    });

    it('rejects a host connection using another session token', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const { token: otherToken } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'host', token: otherToken },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('HOSTED_SESSION_UNAUTHORIZED');
    });

    it('allows host connection with its session token', async () => {
      const { session, token } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'host', token },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith();
      expect(socket.hostedRole).toBe('host');
      expect(socket.hostedSessionId).toBe(session.id);
    });
  });

  describe('socket event exchange', () => {
    let session;
    let token;
    let audience;

    /** Connect a second, host-role socket into the same session room. */
    const connectHost = () => {
      const host = makeSocket({ role: 'host', sessionId: session.id });
      connectionHandler(host);
      roomEvents.length = 0;
      return host;
    };

    beforeEach(async () => {
      ({ session, token } = await createHostedSession('loom-1', 'ep-1'));
      // The LLM turn is stubbed by default so utterance tests assert the
      // session state machine, not provider behaviour. Tests that care about
      // the outcome override this.
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'stay',
        narration: 'Nothing changes.',
        node: { id: 'node-1' },
        ended: false,
      });
      audience = makeSocket({ role: 'audience', sessionId: session.id });
      connectionHandler(audience);
      roomEvents.length = 0;
    });

    it('emits a sanitized session snapshot on connection', () => {
      expect(audience.join).toHaveBeenCalledWith(`session:${session.id}`);
      const sync = audience.emitted.find((e) => e.event === 'hosted:session:sync');
      expect(sync).toBeDefined();
      expect(sync.data).toMatchObject({
        id: session.id,
        loomId: 'loom-1',
        episodeId: 'ep-1',
        status: 'active',
        currentNodeId: 'node-1',
        playbackPhase: 'hold',
        turnPhase: 'idle',
        hasAudienceConnected: true,
      });
      // The snapshot must never carry the join credential in either form.
      expect(sync.data.hashedToken).toBeUndefined();
      expect(JSON.stringify(sync.data)).not.toContain(token);
    });

    it('ignores audience mic controls from a host socket', async () => {
      const host = connectHost();
      await host.listeners['hosted:mic:start']();
      expect(getHostedSession(session.id).turnPhase).toBe('idle');
    });

    it('advances to the transition target when the utterance matches its intent', async () => {
      weave.playTurn.mockResolvedValue({
        action: 'move',
        transitionId: 'tr-1',
        narration: 'Onward.',
        node: { id: 'node-2' },
        ended: false,
      });

      await audience.listeners['hosted:mic:start']();
      expect(getHostedSession(session.id).turnPhase).toBe('listening');

      await audience.listeners['hosted:turn:text']({ text: 'go next' });

      expect(getHostedSession(session.id).currentNodeId).toBe('node-2');
      expect(roomEvent('hosted:story:transition')?.data).toMatchObject({ transitionId: 'tr-1' });
    });

    it('stays on the current scene when the utterance matches no transition', async () => {
      await audience.listeners['hosted:mic:start']();
      await audience.listeners['hosted:turn:text']({ text: 'unrelated words' });

      const state = getHostedSession(session.id);
      expect(state.currentNodeId).toBe('node-1');
      expect(state.turnPhase).toBe('listening');
      expect(roomEvent('hosted:story:transition')).toBeUndefined();
    });

    it('emits hosted:error to the audience when the turn fails', async () => {
      await audience.listeners['hosted:mic:start']();
      records.getLoom.mockRejectedValueOnce(new Error('loom read failed'));

      await audience.listeners['hosted:turn:text']({ text: 'go next' });

      expect(audience.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'TEXT_FAILED', message: 'loom read failed' });
    });

    it('ignores hosted:turn:text when the session is not listening', async () => {
      await audience.listeners['hosted:turn:text']({ text: 'go next' });

      expect(weave.playTurn).not.toHaveBeenCalled();
      expect(getHostedSession(session.id).currentNodeId).toBe('node-1');
      expect(audience.emitted.find((e) => e.event === 'hosted:error')).toBeUndefined();
    });

    it('buffers mic frames while listening and transcribes them on mic:stop', async () => {
      await audience.listeners['hosted:mic:start']();
      audience.listeners['hosted:mic:frame'](Buffer.from('aa'));
      audience.listeners['hosted:mic:frame'](Buffer.from('bb'));
      await audience.listeners['hosted:mic:stop']();

      expect(stt.transcribe).toHaveBeenCalledWith(Buffer.from('aabb'), expect.anything());
    });

    it('ignores hosted:mic:stop when the session is not listening', async () => {
      await audience.listeners['hosted:mic:stop'](Buffer.from('aa'));

      expect(stt.transcribe).not.toHaveBeenCalled();
      expect(getHostedSession(session.id).turnPhase).toBe('idle');
    });

    it('lets a host drive hosted:playback:update', () => {
      const host = connectHost();

      host.listeners['hosted:playback:update']({ phase: 'entry', activeHoldIndex: 1, nodeId: 'node-2' });

      expect(roomEvent('hosted:playback:sync')?.data).toEqual({
        phase: 'entry',
        activeHoldIndex: 1,
        nodeId: 'node-2',
      });
      expect(getHostedSession(session.id)).toMatchObject({
        playbackPhase: 'entry',
        activeHoldIndex: 1,
        currentNodeId: 'node-2',
      });
    });

    it('refuses hosted:playback:update from an audience socket', () => {
      audience.listeners['hosted:playback:update']({ phase: 'entry', activeHoldIndex: 1, nodeId: 'node-2' });

      expect(roomEvent('hosted:playback:sync')).toBeUndefined();
      expect(getHostedSession(session.id)).toMatchObject({
        playbackPhase: 'hold',
        activeHoldIndex: 0,
        currentNodeId: 'node-1',
      });
    });

    it('returns the turn to listening on hosted:speech:done', () => {
      _getInternalSession(session.id).turnPhase = 'speaking';

      audience.listeners['hosted:speech:done']({});

      expect(getHostedSession(session.id).turnPhase).toBe('listening');
      expect(roomEvent('hosted:turn:phase')?.data).toMatchObject({ phase: 'listening' });
    });

    it('drops the in-flight turn on hosted:turn:abort', async () => {
      await audience.listeners['hosted:mic:start']();
      roomEvents.length = 0;

      audience.listeners['hosted:turn:abort']();

      expect(getHostedSession(session.id).turnPhase).toBe('idle');
      expect(roomEvent('hosted:turn:phase')?.data).toMatchObject({ phase: 'idle', reason: 'client_aborted' });
    });

    it('releases the audience slot and tears down listeners on disconnect', () => {
      audience.listeners.disconnect();

      expect(audience.removeAllListeners).toHaveBeenCalled();
      expect(roomEvent('hosted:peer:status')?.data).toMatchObject({
        hasAudienceConnected: false,
        disconnectedRole: 'audience',
      });
      expect(getHostedSession(session.id).hasAudienceConnected).toBe(false);
    });
  });
});
