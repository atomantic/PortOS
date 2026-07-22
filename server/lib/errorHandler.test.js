import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ServerError,
  normalizeError,
  emitErrorEvent,
  errorEvents,
  errorMiddleware,
  createServiceErrorMapper,
  asyncHandler,
  buildErrorEnvelope,
  sendErrorResponse
} from './errorHandler.js';

// Build a fake Express req/res pair. `res.status()` and `res.json()` are
// chainable (they return `res`) to mirror Express, and `req.app.get('io')`
// resolves to whatever io stub the test supplies (or null for the no-io path).
function makeReqRes(io) {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  const req = { method: 'GET', originalUrl: '/api/thing', app: { get: vi.fn(() => io) } };
  return { req, res };
}

// asyncHandler wires the rejection handling onto a `.catch()` microtask and the
// returned middleware does not itself return that promise — so flush the
// microtask queue before asserting the response/emit happened.
const flushMicrotasks = () => new Promise((r) => setImmediate(r));

describe('errorHandler.js', () => {
  describe('ServerError', () => {
    it('should create error with default options', () => {
      const error = new ServerError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('ServerError');
      expect(error.status).toBe(500);
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.severity).toBe('error');
      expect(error.canAutoFix).toBe(false);
      expect(error.timestamp).toBeDefined();
      expect(error.context).toEqual({});
    });

    it('should create error with custom options', () => {
      const error = new ServerError('Not found', {
        status: 404,
        code: 'NOT_FOUND',
        severity: 'warning',
        canAutoFix: true,
        context: { resource: 'user' }
      });
      expect(error.status).toBe(404);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.severity).toBe('warning');
      expect(error.canAutoFix).toBe(true);
      expect(error.context).toEqual({ resource: 'user' });
    });

    it('should derive code from status when no explicit code is passed', () => {
      expect(new ServerError('nope', { status: 404 }).code).toBe('NOT_FOUND');
      expect(new ServerError('bad', { status: 400 }).code).toBe('BAD_REQUEST');
      expect(new ServerError('conflict', { status: 409 }).code).toBe('CONFLICT');
      expect(new ServerError('down', { status: 503 }).code).toBe('SERVICE_UNAVAILABLE');
    });

    it('should let an explicit code override the status-derived one', () => {
      const error = new ServerError('dup', { status: 409, code: 'DUPLICATE_ENTRY' });
      expect(error.code).toBe('DUPLICATE_ENTRY');
    });

    it('should be an instance of Error', () => {
      const error = new ServerError('Test');
      expect(error instanceof Error).toBe(true);
      expect(error instanceof ServerError).toBe(true);
    });

    it('should have stack trace', () => {
      const error = new ServerError('Test');
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('ServerError');
    });
  });

  describe('normalizeError', () => {
    it('should return ServerError as-is', () => {
      const serverError = new ServerError('Original', { status: 400 });
      const normalized = normalizeError(serverError);
      expect(normalized).toBe(serverError);
    });

    it('should convert regular Error to ServerError', () => {
      const error = new Error('Regular error');
      const normalized = normalizeError(error);
      expect(normalized instanceof ServerError).toBe(true);
      expect(normalized.message).toBe('Regular error');
      expect(normalized.status).toBe(500);
      expect(normalized.context.originalError).toBe('Error');
    });

    it('should preserve status from Error if present', () => {
      const error = new Error('Not found');
      error.status = 404;
      const normalized = normalizeError(error);
      expect(normalized.status).toBe(404);
      expect(normalized.code).toBe('NOT_FOUND');
    });

    it('should preserve code from Error if present', () => {
      const error = new Error('Conflict');
      error.code = 'DUPLICATE_ENTRY';
      const normalized = normalizeError(error);
      expect(normalized.code).toBe('DUPLICATE_ENTRY');
    });

    it('should convert string to ServerError', () => {
      const normalized = normalizeError('String error');
      expect(normalized instanceof ServerError).toBe(true);
      expect(normalized.message).toBe('String error');
      expect(normalized.status).toBe(500);
    });

    it('should convert other types to ServerError', () => {
      const normalized = normalizeError({ someObject: true });
      expect(normalized instanceof ServerError).toBe(true);
      expect(normalized.message).toBe('[object Object]');
    });

    it('should map status codes to error codes', () => {
      const testCases = [
        { status: 400, code: 'BAD_REQUEST' },
        { status: 401, code: 'UNAUTHORIZED' },
        { status: 403, code: 'FORBIDDEN' },
        { status: 404, code: 'NOT_FOUND' },
        { status: 409, code: 'CONFLICT' },
        { status: 422, code: 'VALIDATION_ERROR' },
        { status: 502, code: 'BAD_GATEWAY' },
        { status: 503, code: 'SERVICE_UNAVAILABLE' }
      ];

      for (const tc of testCases) {
        const error = new Error('Test');
        error.status = tc.status;
        const normalized = normalizeError(error);
        expect(normalized.code).toBe(tc.code);
      }
    });

    it('should default to INTERNAL_ERROR for unknown status', () => {
      const error = new Error('Test');
      error.status = 418; // I'm a teapot
      const normalized = normalizeError(error);
      expect(normalized.code).toBe('INTERNAL_ERROR');
    });

    it('should unwrap err.cause chain and capture system fields', () => {
      const root = Object.assign(new Error('getaddrinfo ENOTFOUND foo.example'), {
        code: 'ENOTFOUND',
        errno: -3008,
        syscall: 'getaddrinfo',
        hostname: 'foo.example'
      });
      const wrapped = Object.assign(new TypeError('fetch failed'), { cause: root });
      const normalized = normalizeError(wrapped);
      expect(normalized.message).toBe('fetch failed');
      expect(normalized.context.causeChain).toContain('getaddrinfo ENOTFOUND foo.example');
      expect(normalized.context.cause[0]).toMatchObject({
        message: 'getaddrinfo ENOTFOUND foo.example',
        code: 'ENOTFOUND',
        errno: -3008,
        syscall: 'getaddrinfo',
        hostname: 'foo.example'
      });
    });

    it('should not loop on self-referential cause chains', () => {
      const a = new Error('a');
      const b = new Error('b');
      a.cause = b;
      b.cause = a;
      const normalized = normalizeError(a);
      expect(normalized.context.cause.length).toBeLessThanOrEqual(5);
    });
  });

  describe('errorMiddleware', () => {
    const makeRes = () => {
      const res = {};
      res.status = vi.fn(() => res);
      res.json = vi.fn(() => res);
      return res;
    };
    const makeReq = () => ({ method: 'GET', originalUrl: '/x', app: { get: () => null } });

    it('emits the standard envelope and includes non-empty sanitized context', () => {
      const res = makeRes();
      errorMiddleware(
        new ServerError('boom', { status: 404, context: { modelId: 'm', apiKey: 'secret' } }),
        makeReq(),
        res,
        () => {}
      );
      expect(res.status).toHaveBeenCalledWith(404);
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBe('boom');
      expect(body.code).toBe('NOT_FOUND');
      expect(body.timestamp).toBeDefined();
      // context is forwarded but sensitive keys are stripped.
      expect(body.context).toEqual({ modelId: 'm' });
    });

    it('omits context when it is empty', () => {
      const res = makeRes();
      errorMiddleware(new ServerError('nope', { status: 400 }), makeReq(), res, () => {});
      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty('context');
    });

    // A streaming/SSE route that fails mid-response has no envelope left to
    // write — delegate to Express's finalhandler so it destroys the socket
    // rather than leaving the request hanging until a timeout.
    it('delegates to next(err) when the response is already streaming', () => {
      const res = makeRes();
      res.headersSent = true;
      const next = vi.fn();
      const err = new ServerError('mid-stream', { status: 500 });
      errorMiddleware(err, makeReq(), res, next);

      expect(res.json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(err);
    });

    it('does not delegate to next when the envelope was written', () => {
      const res = makeRes();
      // Express flips headersSent once the body is written — mirror that so the
      // middleware can't mistake its own write for a mid-stream failure.
      res.json = vi.fn(() => { res.headersSent = true; return res; });
      const next = vi.fn();
      errorMiddleware(new ServerError('nope', { status: 400 }), makeReq(), res, next);

      expect(res.json).toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('emitErrorEvent', () => {
    it('should emit error event to errorEvents', () => {
      const listener = vi.fn();
      errorEvents.on('error', listener);

      const mockIo = {
        emit: vi.fn()
      };
      const error = new ServerError('Test error');

      emitErrorEvent(mockIo, error);

      // Listener receives (error, safeContext) — sensitive fields stripped so
      // socket.js subscribers can safely re-broadcast.
      expect(listener).toHaveBeenCalledWith(error, expect.any(Object));
      errorEvents.off('error', listener);
    });

    it('should pass sanitized context to errorEvents listeners', () => {
      const listener = vi.fn();
      errorEvents.on('error', listener);

      const mockIo = { emit: vi.fn() };
      const error = new ServerError('Test error', {
        context: { apiKey: 'secret-123', safe: 'visible' },
      });

      emitErrorEvent(mockIo, error);

      const safeContext = listener.mock.calls[0][1];
      expect(safeContext).toEqual({ safe: 'visible' });
      expect(safeContext.apiKey).toBeUndefined();
      errorEvents.off('error', listener);
    });
  });

  describe('createServiceErrorMapper', () => {
    const STATUS = { SVC_NOT_FOUND: 404, SVC_VALIDATION: 400 };

    it('maps a recognized code to a ServerError with the mapped status', () => {
      const map = createServiceErrorMapper(STATUS);
      const mapped = map(Object.assign(new Error('missing'), { code: 'SVC_NOT_FOUND' }));
      expect(mapped).toBeInstanceOf(ServerError);
      expect(mapped.status).toBe(404);
      expect(mapped.code).toBe('SVC_NOT_FOUND');
      expect(mapped.message).toBe('missing');
    });

    it('passes an unrecognized error through untouched', () => {
      const map = createServiceErrorMapper(STATUS);
      const original = Object.assign(new Error('boom'), { code: 'SOMETHING_ELSE' });
      expect(map(original)).toBe(original);
    });

    it('passes a code-less error through untouched', () => {
      const map = createServiceErrorMapper(STATUS);
      const original = new Error('plain');
      expect(map(original)).toBe(original);
    });

    it('attaches a non-empty buildContext result as context', () => {
      const map = createServiceErrorMapper(STATUS, (err) => ({ blockingSeries: err.blockingSeries }));
      const mapped = map(Object.assign(new Error('busy'), { code: 'SVC_VALIDATION', blockingSeries: ['s1'] }));
      expect(mapped.context).toEqual({ blockingSeries: ['s1'] });
    });

    it('omits context when buildContext returns undefined or an empty object', () => {
      const map = createServiceErrorMapper(STATUS, () => undefined);
      const mapped = map(Object.assign(new Error('x'), { code: 'SVC_VALIDATION' }));
      expect(mapped.context).toEqual({});

      const mapEmpty = createServiceErrorMapper(STATUS, () => ({}));
      const mappedEmpty = mapEmpty(Object.assign(new Error('y'), { code: 'SVC_VALIDATION' }));
      expect(mappedEmpty.context).toEqual({});
    });
  });

  describe('asyncHandler', () => {
    // `errorEvents` is a Node EventEmitter: emitting 'error' with zero listeners
    // re-throws the argument (the classic footgun). Production always has
    // subscribers (autoFixer / socket.js); keep a noop attached so emitErrorEvent
    // doesn't throw out of asyncHandler's catch during these tests.
    // Cleanup lives in afterEach (not test bodies) so a failing assertion can't
    // leak the noop listener, any test-registered listener, or the console.error
    // spy into sibling tests.
    let noopErrorListener;
    let errorSpy;
    let testListeners;
    // Register an errorEvents 'error' listener that this describe will remove.
    const trackListener = (fn) => { testListeners.push(fn); errorEvents.on('error', fn); };

    beforeEach(() => {
      testListeners = [];
      noopErrorListener = () => {};
      errorEvents.on('error', noopErrorListener);
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      errorEvents.off('error', noopErrorListener);
      for (const fn of testListeners) errorEvents.off('error', fn);
      errorSpy.mockRestore();
    });

    it('catches a thrown ServerError, emits, and responds with status + body', async () => {
      const io = { emit: vi.fn() };
      const { req, res } = makeReqRes(io);
      const events = [];
      trackListener((err, ctx) => events.push({ err, ctx }));

      const handler = asyncHandler(async () => {
        throw new ServerError('nope', { status: 403, code: 'FORBIDDEN', context: { detail: 'x' } });
      });
      await handler(req, res, vi.fn());
      await flushMicrotasks();

      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBe('nope');
      expect(body.code).toBe('FORBIDDEN');
      expect(body.timestamp).toBeDefined();
      expect(body.context).toEqual({ detail: 'x' });
      // Both channels fire: the process-local errorEvents emitter and the io broadcast.
      expect(events).toHaveLength(1);
      expect(io.emit).toHaveBeenCalledWith(
        'error:occurred',
        expect.objectContaining({ code: 'FORBIDDEN', status: 403, message: 'nope' })
      );
    });

    it('normalizes a plain thrown Error to a 500 INTERNAL_ERROR response', async () => {
      const io = { emit: vi.fn() };
      const { req, res } = makeReqRes(io);

      const handler = asyncHandler(async () => {
        throw new Error('kaboom');
      });
      await handler(req, res, vi.fn());
      await flushMicrotasks();

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.error).toBe('kaboom');
    });

    it('does not touch res when the wrapped handler resolves successfully', async () => {
      const { req, res } = makeReqRes({ emit: vi.fn() });

      const handler = asyncHandler(async () => 'ok');
      await handler(req, res, vi.fn());
      await flushMicrotasks();

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('still responds when no io is registered on the app', async () => {
      const { req, res } = makeReqRes(null);

      const handler = asyncHandler(async () => {
        throw new ServerError('missing', { status: 404 });
      });
      await handler(req, res, vi.fn());
      await flushMicrotasks();

      expect(res.status).toHaveBeenCalledWith(404);
      // status→code derivation still runs even without an io channel.
      expect(res.json.mock.calls[0][0].code).toBe('NOT_FOUND');
    });
  });

  describe('sendErrorResponse', () => {
    const makeRes = (overrides = {}) => {
      const res = { headersSent: false, ...overrides };
      res.status = vi.fn(() => res);
      res.json = vi.fn(() => res);
      return res;
    };

    it('emits the standard envelope for callers outside a handler catch', () => {
      const res = makeRes();
      sendErrorResponse(res, new ServerError('Sample not found', { status: 404 }));

      expect(res.status).toHaveBeenCalledWith(404);
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBe('Sample not found');
      expect(body.code).toBe('NOT_FOUND');
      expect(typeof body.timestamp).toBe('number');
    });

    it('normalizes a plain Error and returns the ServerError to the caller', () => {
      const res = makeRes();
      const error = sendErrorResponse(res, new Error('kaboom'));

      expect(error).toBeInstanceOf(ServerError);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json.mock.calls[0][0].code).toBe('INTERNAL_ERROR');
    });

    it('does not write once headers are already sent', () => {
      const res = makeRes({ headersSent: true });
      sendErrorResponse(res, new ServerError('too late', { status: 404 }));

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('emits the socket event with the sanitized context when io is supplied', () => {
      const res = makeRes();
      const io = { emit: vi.fn() };
      // `errorEvents` is an EventEmitter — an 'error' emit with no listener
      // re-throws, so subscribe for the duration of this assertion.
      const listener = vi.fn();
      errorEvents.on('error', listener);
      sendErrorResponse(
        res,
        new ServerError('boom', { status: 400, context: { modelId: 'm', apiKey: 'secret' } }),
        { io }
      );

      const payload = io.emit.mock.calls.find(([event]) => event === 'error:occurred')[1];
      expect(payload.context).toEqual({ modelId: 'm' });
      expect(res.json.mock.calls[0][0].context).toEqual({ modelId: 'm' });
      errorEvents.off('error', listener);
    });
  });

  describe('buildErrorEnvelope', () => {
    it('omits context when the sanitized context is empty', () => {
      const body = buildErrorEnvelope(new ServerError('nope', { status: 400 }), {});
      expect(body).toEqual({ error: 'nope', code: 'BAD_REQUEST', timestamp: expect.any(Number) });
    });
  });
});
