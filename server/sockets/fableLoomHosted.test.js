import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerFableLoomHostedNamespace,
  getHostedNamespace,
} from './fableLoomHosted.js';
import {
  _resetHostedSessions,
  createHostedSession,
  getHostedSession,
} from '../services/fableLoom/hostedSession.js';
import * as records from '../services/fableLoom/records.js';
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
      }],
    }],
  };

  let mockIo;
  let middleware;
  let connectionHandler;
  let mockNamespace;
  let roomEvents;

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
    it('ignores audience mic controls from a host socket', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const listeners = {};
      const socket = {
        id: 'host-sock',
        hostedRole: 'host',
        hostedSessionId: session.id,
        join: vi.fn(),
        emit: vi.fn(),
        on: vi.fn((event, fn) => { listeners[event] = fn; }),
        removeAllListeners: vi.fn(),
      };

      connectionHandler(socket);
      await listeners['hosted:mic:start']();
      expect(getHostedSession(session.id).turnPhase).toBe('idle');
    });

    it('synchronizes session on connection and handles events', async () => {
      const { session, token } = await createHostedSession('loom-1', 'ep-1');
      const listeners = {};
      const emitted = [];

      const socket = {
        id: 'sock-1',
        hostedRole: 'audience',
        hostedSessionId: session.id,
        join: vi.fn(),
        emit: vi.fn((event, data) => emitted.push({ event, data })),
        on: vi.fn((event, fn) => { listeners[event] = fn; }),
        removeAllListeners: vi.fn(),
      };

      connectionHandler(socket);

      expect(socket.join).toHaveBeenCalledWith(`session:${session.id}`);
      expect(emitted.find((e) => e.event === 'hosted:session:sync')).toBeDefined();

      // Trigger mic:start
      expect(listeners['hosted:mic:start']).toBeDefined();
      await listeners['hosted:mic:start']();
      expect(getHostedSession(session.id).turnPhase).toBe('listening');

      // Trigger mic:stop with text/audio
      expect(listeners['hosted:turn:text']).toBeDefined();
      await listeners['hosted:turn:text']({ text: 'go next' });

      // Disconnect
      expect(listeners.disconnect).toBeDefined();
      listeners.disconnect();
      expect(socket.removeAllListeners).toHaveBeenCalled();
    });
  });
});
