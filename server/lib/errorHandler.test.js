import { describe, it, expect, vi } from 'vitest';
import {
  ServerError,
  normalizeError,
  emitErrorEvent,
  errorEvents,
  errorMiddleware,
  createServiceErrorMapper
} from './errorHandler.js';

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
});
