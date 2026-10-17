import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { describe, it, expect, vi } from 'vitest';
import { SOCKET_MAX_PAYLOAD_BYTES } from '../lib/socketPayloadLimits.js';
import { registerVoiceHandlers, MAX_AUDIO_BYTES, MAX_SCREENSHOT_BYTES } from './voice.js';
import { registerFableLoomHostedNamespace, MAX_UTTERANCE_BYTES } from './fableLoomHosted.js';

vi.mock('../services/voice/config.js', () => ({ getVoiceConfig: vi.fn(async () => ({ enabled: true })) }));
vi.mock('../services/voice/pipeline.js', () => ({ runTurn: vi.fn(async ({ emit, state, text }) => {
  if (text === 'capture') {
    const screenshot = new Promise((resolve) => state.screenshotWaiters.set('example-capture', resolve));
    emit('voice:screenshot:request', { requestId: 'example-capture' });
    const dataUrl = await screenshot;
    emit('test:screenshot', { length: dataUrl?.length ?? null });
  }
  emit('voice:idle', {});
  return {};
}) }));
vi.mock('../services/voice/stt.js', () => ({ transcribe: vi.fn() }));
vi.mock('../services/voice/tts.js', () => ({ synthesize: vi.fn() }));
vi.mock('../services/fableLoom/hostedSession.js', () => {
  const session = { id: 'example-session', status: 'active', turnPhase: 'listening' };
  return {
    _getInternalSession: () => session,
    abortHostedTurn: vi.fn(),
    endHostedSession: vi.fn(),
    getHostedSession: () => session,
    processHostedUtterance: vi.fn(async (_id, { io }) => {
      io.of('/fableloom-hosted').emit('hosted:accepted');
    }),
    sanitizeHostedSession: () => session,
    startHostedListening: vi.fn(),
    switchHostedEpisode: vi.fn(),
    updateHostedSession: vi.fn(),
    verifyHostedHostToken: () => false,
    verifyHostedToken: (_id, token) => token === 'example-token',
  };
});

const nextEvent = (socket, event) => once(socket, event, { signal: AbortSignal.timeout(5000) });

describe('Socket.IO media transport contract', () => {
  it('boots with the shared ceiling above encoded media caps and bounded framing', () => {
    const bootstrap = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(bootstrap).toContain('maxHttpBufferSize: SOCKET_MAX_PAYLOAD_BYTES');
    for (const cap of [MAX_AUDIO_BYTES, MAX_SCREENSHOT_BYTES, MAX_UTTERANCE_BYTES]) {
      expect(SOCKET_MAX_PAYLOAD_BYTES - 4 * Math.ceil(cap / 3)).toBeGreaterThanOrEqual(64 * 1024);
    }
  });

  // Polling expands binary to base64; websocket sends raw bytes. The maximum
  // permitted recording and handler refusal must work on both shipped paths.
  it.each(['websocket', 'polling'])('accepts capped media and refuses over-cap media without losing %s subscriptions', async (transport) => {
    const http = createServer();
    const server = new Server(http, { maxHttpBufferSize: SOCKET_MAX_PAYLOAD_BYTES });
    server.on('connection', (socket) => {
      registerVoiceHandlers(socket);
      socket.on('test:ping', () => socket.emit('test:pong'));
    });
    registerFableLoomHostedNamespace(server);
    const clients = [];
    try {
      http.listen(0, '127.0.0.1');
      await once(http, 'listening');
      const origin = `http://127.0.0.1:${http.address().port}`;
      const voice = connect(origin, { transports: [transport], reconnection: false });
      clients.push(voice);
      await nextEvent(voice, 'connect');
      expect(voice.io.engine.transport.name).toBe(transport);
      for (const size of [2 * 1024 * 1024, MAX_AUDIO_BYTES]) {
        const accepted = nextEvent(voice, 'voice:idle');
        voice.emit('voice:turn', { audio: Buffer.alloc(size), mimeType: 'audio/wav' });
        await accepted;
      }
      const refused = nextEvent(voice, 'voice:error');
      voice.emit('voice:turn', { audio: Buffer.alloc(MAX_AUDIO_BYTES + 1) });
      expect((await refused)[0]).toMatchObject({ stage: 'turn', message: expect.stringContaining('audio too large') });
      const pong = nextEvent(voice, 'test:pong');
      voice.emit('test:ping');
      await pong;
      expect(voice.connected).toBe(true);

      for (const size of [MAX_SCREENSHOT_BYTES, MAX_SCREENSHOT_BYTES + 1]) {
        const request = nextEvent(voice, 'voice:screenshot:request');
        voice.emit('voice:text', { text: 'capture' });
        const [{ requestId }] = await request;
        const result = nextEvent(voice, 'test:screenshot');
        const prefix = 'data:image/jpeg;base64,';
        voice.emit('voice:screenshot:result', { requestId, dataUrl: prefix + 'A'.repeat(size - prefix.length) });
        expect((await result)[0]).toEqual({ length: size <= MAX_SCREENSHOT_BYTES ? size : null });
      }
      expect(voice.connected).toBe(true);

      const guest = connect(`${origin}/fableloom-hosted`, {
        transports: [transport], reconnection: false,
        auth: { sessionId: 'example-session', token: 'example-token', role: 'audience' },
        forceNew: true,
      });
      clients.push(guest);
      await nextEvent(guest, 'connect');
      const accepted = nextEvent(guest, 'hosted:accepted');
      guest.emit('hosted:mic:stop', Buffer.alloc(MAX_UTTERANCE_BYTES));
      await accepted;
      const guestRefused = nextEvent(guest, 'hosted:error');
      guest.emit('hosted:mic:stop', Buffer.alloc(MAX_UTTERANCE_BYTES + 1));
      expect((await guestRefused)[0]).toMatchObject({ code: 'UTTERANCE_TOO_LARGE' });
      const recovered = nextEvent(guest, 'hosted:accepted');
      guest.emit('hosted:mic:stop', Buffer.alloc(1024));
      await recovered;
      expect(guest.connected).toBe(true);
    } finally {
      clients.forEach((client) => client.disconnect());
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
