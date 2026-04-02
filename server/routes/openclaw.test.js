import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import openclawRoutes from './openclaw.js';

vi.mock('../integrations/openclaw/api.js', () => ({
  getRuntimeStatus: vi.fn(),
  listSessions: vi.fn(),
  getSessionMessages: vi.fn(),
  sendSessionMessage: vi.fn(),
  streamSessionMessage: vi.fn()
}));

import * as openclawApi from '../integrations/openclaw/api.js';

const CONFIGURED_STATUS = {
  configured: true,
  enabled: true,
  reachable: true,
  label: 'OpenClaw Runtime',
  defaultSession: 'main',
  message: null,
  runtime: null
};

const UNCONFIGURED_STATUS = {
  configured: false,
  enabled: true,
  reachable: false,
  label: 'OpenClaw Runtime',
  defaultSession: null,
  message: 'OpenClaw is not configured'
};

describe('OpenClaw Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    // Match the 50mb body limit used in production (server/index.js)
    app.use(express.json({ limit: '50mb' }));
    app.use('/api/openclaw', openclawRoutes);
    vi.clearAllMocks();
  });

  // ===========================================================================
  // GET /api/openclaw/status
  // ===========================================================================

  describe('GET /api/openclaw/status', () => {
    it('should return configured status when OpenClaw is set up', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);

      const response = await request(app).get('/api/openclaw/status');

      expect(response.status).toBe(200);
      expect(response.body.configured).toBe(true);
      expect(response.body.reachable).toBe(true);
      expect(openclawApi.getRuntimeStatus).toHaveBeenCalledTimes(1);
    });

    it('should return unconfigured status when OpenClaw is not set up', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(UNCONFIGURED_STATUS);

      const response = await request(app).get('/api/openclaw/status');

      expect(response.status).toBe(200);
      expect(response.body.configured).toBe(false);
      expect(response.body.reachable).toBe(false);
    });
  });

  // ===========================================================================
  // GET /api/openclaw/sessions
  // ===========================================================================

  describe('GET /api/openclaw/sessions', () => {
    it('should return sessions list when configured', async () => {
      openclawApi.listSessions.mockResolvedValue({
        configured: true,
        reachable: true,
        label: 'OpenClaw Runtime',
        defaultSession: 'main',
        sessions: [
          { id: 'main', title: 'Main Session', status: 'active' },
          { id: 'work', title: 'Work Session', status: 'idle' }
        ]
      });

      const response = await request(app).get('/api/openclaw/sessions');

      expect(response.status).toBe(200);
      expect(response.body.sessions).toHaveLength(2);
      expect(response.body.configured).toBe(true);
      expect(openclawApi.listSessions).toHaveBeenCalledTimes(1);
    });

    it('should return empty sessions when unconfigured', async () => {
      openclawApi.listSessions.mockResolvedValue({
        configured: false,
        reachable: false,
        sessions: [],
        defaultSession: null,
        label: 'OpenClaw Runtime'
      });

      const response = await request(app).get('/api/openclaw/sessions');

      expect(response.status).toBe(200);
      expect(response.body.configured).toBe(false);
      expect(response.body.sessions).toHaveLength(0);
    });
  });

  // ===========================================================================
  // GET /api/openclaw/sessions/:id/messages
  // ===========================================================================

  describe('GET /api/openclaw/sessions/:id/messages', () => {
    it('should return messages for a session', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);
      openclawApi.getSessionMessages.mockResolvedValue({
        configured: true,
        reachable: true,
        sessionId: 'main',
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'msg-2', role: 'assistant', content: 'Hi there', createdAt: '2026-01-01T00:00:01.000Z' }
        ]
      });

      const response = await request(app).get('/api/openclaw/sessions/main/messages');

      expect(response.status).toBe(200);
      expect(response.body.messages).toHaveLength(2);
      expect(response.body.sessionId).toBe('main');
      expect(openclawApi.getSessionMessages).toHaveBeenCalledWith('main', { limit: 50 });
    });

    it('should respect limit query param', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);
      openclawApi.getSessionMessages.mockResolvedValue({
        configured: true,
        reachable: true,
        sessionId: 'main',
        messages: []
      });

      await request(app).get('/api/openclaw/sessions/main/messages?limit=10');

      expect(openclawApi.getSessionMessages).toHaveBeenCalledWith('main', { limit: 10 });
    });

    it('should cap limit at 200', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);
      openclawApi.getSessionMessages.mockResolvedValue({
        configured: true,
        reachable: true,
        sessionId: 'main',
        messages: []
      });

      await request(app).get('/api/openclaw/sessions/main/messages?limit=999');

      expect(openclawApi.getSessionMessages).toHaveBeenCalledWith('main', { limit: 200 });
    });

    it('should return unconfigured response without calling getSessionMessages when not configured', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(UNCONFIGURED_STATUS);

      const response = await request(app).get('/api/openclaw/sessions/main/messages');

      expect(response.status).toBe(200);
      expect(response.body.configured).toBe(false);
      expect(response.body.messages).toHaveLength(0);
      expect(openclawApi.getSessionMessages).not.toHaveBeenCalled();
    });

    it('should use default limit of 50 when limit is invalid', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);
      openclawApi.getSessionMessages.mockResolvedValue({
        configured: true,
        reachable: true,
        sessionId: 'main',
        messages: []
      });

      await request(app).get('/api/openclaw/sessions/main/messages?limit=notanumber');

      expect(openclawApi.getSessionMessages).toHaveBeenCalledWith('main', { limit: 50 });
    });
  });

  // ===========================================================================
  // POST /api/openclaw/sessions/:id/messages
  // ===========================================================================

  describe('POST /api/openclaw/sessions/:id/messages', () => {
    it('should send a message and return the reply', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);
      openclawApi.sendSessionMessage.mockResolvedValue({
        ok: true,
        configured: true,
        reachable: true,
        sessionId: 'main',
        message: {
          id: 'resp-1',
          role: 'assistant',
          content: 'Hello back!',
          createdAt: '2026-01-01T00:00:01.000Z',
          status: 'completed'
        }
      });

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages')
        .send({ message: 'Hello!' });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.message.role).toBe('assistant');
      expect(openclawApi.sendSessionMessage).toHaveBeenCalledWith('main', expect.objectContaining({ message: 'Hello!' }));
    });

    it('should pass context and attachments to the service', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);
      openclawApi.sendSessionMessage.mockResolvedValue({
        ok: true,
        configured: true,
        reachable: true,
        sessionId: 'main',
        message: { id: 'resp-1', role: 'assistant', content: 'Got it', createdAt: '2026-01-01T00:00:01.000Z', status: 'completed' }
      });

      const payload = {
        message: 'Review this',
        context: { appName: 'myapp', repoPath: '/projects/myapp' },
        attachments: [{ sourceType: 'url', url: 'https://example.com/image.png', kind: 'image' }]
      };

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages')
        .send(payload);

      expect(response.status).toBe(200);
      expect(openclawApi.sendSessionMessage).toHaveBeenCalledWith('main', expect.objectContaining({
        message: 'Review this',
        context: expect.objectContaining({ appName: 'myapp' }),
        attachments: expect.arrayContaining([expect.objectContaining({ url: 'https://example.com/image.png' })])
      }));
    });

    it('should return 400 when message is missing', async () => {
      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages')
        .send({ context: { appName: 'myapp' } });

      expect(response.status).toBe(400);
      expect(openclawApi.sendSessionMessage).not.toHaveBeenCalled();
    });

    it('should return 400 when message is empty string', async () => {
      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages')
        .send({ message: '   ' });

      expect(response.status).toBe(400);
      expect(openclawApi.sendSessionMessage).not.toHaveBeenCalled();
    });

    it('should return 503 when OpenClaw is not configured', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(UNCONFIGURED_STATUS);

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages')
        .send({ message: 'Hello' });

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('OPENCLAW_UNCONFIGURED');
      expect(openclawApi.sendSessionMessage).not.toHaveBeenCalled();
    });

    it('should return 400 when attachment count exceeds 8', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);

      const attachments = Array.from({ length: 9 }, (_, i) => ({
        sourceType: 'url',
        url: `https://example.com/image${i}.png`,
        kind: 'image'
      }));

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages')
        .send({ message: 'Too many', attachments });

      expect(response.status).toBe(400);
      expect(openclawApi.sendSessionMessage).not.toHaveBeenCalled();
    });

    it('should return 400 when attachment has neither data nor url', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages')
        .send({
          message: 'Bad attachment',
          attachments: [{ kind: 'image', sourceType: 'base64' }]
        });

      expect(response.status).toBe(400);
      expect(openclawApi.sendSessionMessage).not.toHaveBeenCalled();
    });

    it('should return 400 when a base64 attachment exceeds the 10 MB per-attachment limit', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);

      // 13,333,334 chars > ATTACHMENT_BASE64_MAX_CHARS (13,333,333)
      const oversizedData = 'A'.repeat(13_333_334);

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages')
        .send({
          message: 'Big attachment',
          attachments: [{ sourceType: 'base64', data: oversizedData, mediaType: 'image/png', kind: 'image' }]
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(openclawApi.sendSessionMessage).not.toHaveBeenCalled();
    });

    it('should return 400 when combined attachments exceed the 50 MB total limit', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);

      // Use 6 attachments each at 9,000,000 chars (each individually under the ~13.3M per-attachment cap)
      // Combined = 54,000,000 chars > ATTACHMENTS_TOTAL_BASE64_MAX_CHARS (50,000,000).
      // A dedicated app instance with a higher body-parser limit is required here so Express
      // parses the request and hands it to Zod, rather than rejecting it with 413 itself.
      const bigApp = express();
      bigApp.use(express.json({ limit: '100mb' }));
      bigApp.use('/api/openclaw', openclawRoutes);

      const data = 'A'.repeat(9_000_000);
      const attachments = Array.from({ length: 6 }, () => ({
        sourceType: 'base64',
        data,
        mediaType: 'image/png',
        kind: 'image'
      }));

      const response = await request(bigApp)
        .post('/api/openclaw/sessions/main/messages')
        .send({ message: 'Combined too large', attachments });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(openclawApi.sendSessionMessage).not.toHaveBeenCalled();
    });

    it('should accept a valid base64 attachment within size limits', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);
      openclawApi.sendSessionMessage.mockResolvedValue({
        ok: true,
        configured: true,
        reachable: true,
        sessionId: 'main',
        message: { id: 'r1', role: 'assistant', content: 'ok', createdAt: '2026-01-01T00:00:00.000Z', status: 'completed' }
      });

      // 100 chars — well within any limit
      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages')
        .send({
          message: 'Small attachment',
          attachments: [{ sourceType: 'base64', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', mediaType: 'image/png', kind: 'image' }]
        });

      expect(response.status).toBe(200);
      expect(openclawApi.sendSessionMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // POST /api/openclaw/sessions/:id/messages/stream
  // ===========================================================================

  describe('POST /api/openclaw/sessions/:id/messages/stream', () => {
    it('should return 503 when OpenClaw is not configured', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(UNCONFIGURED_STATUS);

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages/stream')
        .send({ message: 'Stream this' });

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('OPENCLAW_UNCONFIGURED');
      expect(openclawApi.streamSessionMessage).not.toHaveBeenCalled();
    });

    it('should return 400 when message is missing', async () => {
      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages/stream')
        .send({});

      expect(response.status).toBe(400);
      expect(openclawApi.streamSessionMessage).not.toHaveBeenCalled();
    });

    it('should return 400 when a base64 attachment exceeds the per-attachment size limit', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);

      const oversizedData = 'A'.repeat(13_333_334);

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages/stream')
        .send({
          message: 'Stream big',
          attachments: [{ sourceType: 'base64', data: oversizedData, mediaType: 'image/png', kind: 'image' }]
        });

      expect(response.status).toBe(400);
      expect(openclawApi.streamSessionMessage).not.toHaveBeenCalled();
    });

    it('should stream SSE events when configured and upstream is available', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);

      const sseChunks = ['data: {"type":"text_delta","text":"Hello"}\n\n', 'data: [DONE]\n\n'];
      let chunkIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (chunkIndex < sseChunks.length) {
            const encoder = new TextEncoder();
            return { done: false, value: encoder.encode(sseChunks[chunkIndex++]) };
          }
          return { done: true, value: undefined };
        }),
        cancel: vi.fn().mockResolvedValue(undefined)
      };
      const mockBody = { getReader: vi.fn().mockReturnValue(mockReader) };
      const mockResponse = { ok: true, body: mockBody };

      openclawApi.streamSessionMessage.mockResolvedValue({ response: mockResponse });

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages/stream')
        .send({ message: 'Stream this' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(openclawApi.streamSessionMessage).toHaveBeenCalledWith('main', expect.objectContaining({ message: 'Stream this' }));
    });

    it('should write an error SSE event when upstream body is null', async () => {
      openclawApi.getRuntimeStatus.mockResolvedValue(CONFIGURED_STATUS);
      openclawApi.streamSessionMessage.mockResolvedValue({ response: { ok: true, body: null } });

      const response = await request(app)
        .post('/api/openclaw/sessions/main/messages/stream')
        .send({ message: 'No body' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('No upstream stream body');
    });
  });
});
