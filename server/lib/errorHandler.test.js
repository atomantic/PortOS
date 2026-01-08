import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ServerError,
  normalizeError,
  emitErrorEvent,
  errorEvents
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

      expect(listener).toHaveBeenCalledWith(error);
      errorEvents.off('error', listener);
    });
  });
});
