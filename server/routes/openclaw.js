import express from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  isConfigured,
  getRuntimeStatus,
  listSessions,
  getSessionMessages,
  sendSessionMessage,
  streamSessionMessage
} from '../integrations/openclaw/api.js';

const router = express.Router();

// ~10 MB as base64 = ~13,333,333 chars (base64 expands 3 bytes → 4 chars)
const ATTACHMENT_BASE64_MAX_CHARS = 13_333_333;
// 50 MB combined base64 cap across all attachments in a single request
const ATTACHMENTS_TOTAL_BASE64_MAX_CHARS = 50_000_000;

const attachmentSchema = z.object({
  kind: z.enum(['image', 'file']).optional(),
  sourceType: z.enum(['base64', 'url']).optional(),
  name: z.string().trim().min(1).optional(),
  filename: z.string().trim().min(1).optional(),
  mediaType: z.string().trim().min(1).optional(),
  mimeType: z.string().trim().min(1).optional(),
  data: z.string().trim().min(1).max(ATTACHMENT_BASE64_MAX_CHARS, 'Attachment base64 data exceeds the 10 MB per-attachment limit.').optional(),
  url: z.string().trim().url().refine(
    url => url.startsWith('http://') || url.startsWith('https://'),
    'Attachment url must use http or https scheme.'
  ).optional()
}).superRefine((value, ctx) => {
  const hasData = typeof value.data === 'string' && value.data.trim().length > 0;
  const hasUrl = typeof value.url === 'string' && value.url.trim().length > 0;

  if (!hasData && !hasUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Attachment must include either base64 data or url.'
    });
  }

  if (hasData && hasUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Attachment must include either base64 data or url, not both.'
    });
  }

  if (value.sourceType === 'base64' && !hasData) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['data'],
      message: 'Attachment with sourceType "base64" must include non-empty data.'
    });
  }

  if (value.sourceType === 'url' && !hasUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: 'Attachment with sourceType "url" must include a valid url.'
    });
  }
});

const contextSchema = z.object({
  appName: z.string().trim().min(1).optional(),
  repoPath: z.string().trim().min(1).optional(),
  directoryPath: z.string().trim().min(1).optional(),
  extraInstructions: z.string().trim().min(1).optional()
}).optional();

export const sendMessageSchema = z.object({
  message: z.string().trim().min(1),
  context: contextSchema,
  attachments: z.array(attachmentSchema).max(8).optional()
}).superRefine((value, ctx) => {
  if (!value.attachments || value.attachments.length === 0) return;
  const totalChars = value.attachments.reduce((sum, a) => sum + (typeof a.data === 'string' ? a.data.length : 0), 0);
  if (totalChars > ATTACHMENTS_TOTAL_BASE64_MAX_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attachments'],
      message: `Combined attachment base64 data exceeds the 50 MB total limit (${Math.round(totalChars / 1_000_000)} MB submitted).`
    });
  }
});

router.get('/status', asyncHandler(async (req, res) => {
  const status = await getRuntimeStatus();
  res.json(status);
}));

router.get('/sessions', asyncHandler(async (req, res) => {
  const result = await listSessions();
  res.json(result);
}));

router.get('/sessions/:id/messages', asyncHandler(async (req, res) => {
  const sessionId = req.params.id?.trim();
  if (!sessionId) {
    throw new ServerError('Session ID is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  let limit = req.query.limit !== undefined ? Number.parseInt(String(req.query.limit), 10) : 50;
  if (Number.isNaN(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  const status = await isConfigured();
  if (!status.configured) {
    return res.json({
      configured: false,
      reachable: false,
      sessionId,
      messages: []
    });
  }

  const result = await getSessionMessages(sessionId, { limit });
  res.json(result);
}));

router.post('/sessions/:id/messages', asyncHandler(async (req, res) => {
  const sessionId = req.params.id?.trim();
  if (!sessionId) {
    throw new ServerError('Session ID is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const payload = validateRequest(sendMessageSchema, req.body);
  const status = await isConfigured();
  if (!status.configured) {
    throw new ServerError('OpenClaw is not configured for this PortOS instance', {
      status: 503,
      code: 'OPENCLAW_UNCONFIGURED'
    });
  }

  const result = await sendSessionMessage(sessionId, payload);
  res.json(result);
}));

router.post('/sessions/:id/messages/stream', asyncHandler(async (req, res) => {
  const sessionId = req.params.id?.trim();
  if (!sessionId) {
    throw new ServerError('Session ID is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const payload = validateRequest(sendMessageSchema, req.body);
  const status = await isConfigured();
  if (!status.configured) {
    throw new ServerError('OpenClaw is not configured for this PortOS instance', {
      status: 503,
      code: 'OPENCLAW_UNCONFIGURED'
    });
  }

  const abortController = new AbortController();
  let clientDisconnected = false;
  let reader;

  const handleClose = async () => {
    clientDisconnected = true;
    abortController.abort();
    if (reader) {
      try { await reader.cancel(); } catch { /* no-op */ }
    }
  };

  req.on('close', handleClose);

  try {
    let streamResult;
    try {
      streamResult = await streamSessionMessage(sessionId, payload, { signal: abortController.signal });
    } catch (err) {
      if (clientDisconnected) return;
      throw err;
    }

    if (clientDisconnected || res.writableEnded || res.destroyed) return;

    const { response } = streamResult;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const upstream = response.body;
    if (!upstream) {
      res.write('event: error\ndata: {"error":"No upstream stream body"}\n\n');
      return res.end();
    }

    reader = upstream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || clientDisconnected || res.writableEnded || res.destroyed) break;
        if (value) {
          const canContinue = res.write(decoder.decode(value, { stream: true }));
          if (!canContinue) await new Promise(resolve => res.once('drain', resolve));
        }
      }
      const tail = decoder.decode();
      if (tail && !res.writableEnded && !res.destroyed) res.write(tail);
    } catch (err) {
      if (err?.name !== 'AbortError' && !clientDisconnected && !res.writableEnded && !res.destroyed) {
        const errorPayload = {
          error: 'Upstream stream error',
          message: err instanceof Error ? err.message : String(err)
        };
        res.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
        console.error(`❌ OpenClaw stream error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!res.writableEnded && !res.destroyed) res.end();
  } finally {
    req.off('close', handleClose);
  }
}));

export default router;
