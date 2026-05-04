import { describe, it, expect, vi } from 'vitest';
import {
  detectStartSchema,
  standardizeStartSchema,
  logsSubscribeSchema,
  errorRecoverSchema,
  shellInputSchema,
  shellResizeSchema,
  shellSessionIdSchema,
  shellStopSchema,
  appUpdateSchema,
  appStandardizeSchema,
  appDeploySchema,
  validateSocketData
} from './socketValidation.js';

describe('socketValidation schemas', () => {
  describe('detectStartSchema', () => {
    it('accepts a non-empty path', () => {
      expect(detectStartSchema.safeParse({ path: '/repos/foo' }).success).toBe(true);
    });

    it('rejects an empty or missing path', () => {
      expect(detectStartSchema.safeParse({ path: '' }).success).toBe(false);
      expect(detectStartSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('standardizeStartSchema', () => {
    it('accepts repoPath alone', () => {
      expect(standardizeStartSchema.safeParse({ repoPath: '/x' }).success).toBe(true);
    });

    it('accepts repoPath with optional providerId', () => {
      const result = standardizeStartSchema.safeParse({ repoPath: '/x', providerId: 'openai' });
      expect(result.success).toBe(true);
    });

    it('rejects empty repoPath', () => {
      expect(standardizeStartSchema.safeParse({ repoPath: '' }).success).toBe(false);
    });

    it('rejects empty providerId when supplied', () => {
      expect(standardizeStartSchema.safeParse({ repoPath: '/x', providerId: '' }).success).toBe(false);
    });
  });

  describe('logsSubscribeSchema', () => {
    it('defaults lines to 100 when only processName is supplied', () => {
      const result = logsSubscribeSchema.safeParse({ processName: 'portos' });
      expect(result.success).toBe(true);
      expect(result.data.lines).toBe(100);
    });

    it('accepts a custom positive integer for lines', () => {
      const result = logsSubscribeSchema.safeParse({ processName: 'portos', lines: 250 });
      expect(result.success).toBe(true);
      expect(result.data.lines).toBe(250);
    });

    it('rejects lines above the 10000 cap', () => {
      expect(logsSubscribeSchema.safeParse({ processName: 'p', lines: 99999 }).success).toBe(false);
    });

    it('rejects non-integer or non-positive lines', () => {
      expect(logsSubscribeSchema.safeParse({ processName: 'p', lines: 0 }).success).toBe(false);
      expect(logsSubscribeSchema.safeParse({ processName: 'p', lines: -1 }).success).toBe(false);
      expect(logsSubscribeSchema.safeParse({ processName: 'p', lines: 1.5 }).success).toBe(false);
    });
  });

  describe('errorRecoverSchema', () => {
    it('accepts a code with default empty context', () => {
      const result = errorRecoverSchema.safeParse({ code: 'E_FOO' });
      expect(result.success).toBe(true);
      expect(result.data.context).toEqual({});
    });

    it('accepts an arbitrary record context', () => {
      const result = errorRecoverSchema.safeParse({ code: 'E_FOO', context: { extra: 1, msg: 'x' } });
      expect(result.success).toBe(true);
      expect(result.data.context).toEqual({ extra: 1, msg: 'x' });
    });

    it('rejects empty code', () => {
      expect(errorRecoverSchema.safeParse({ code: '' }).success).toBe(false);
    });
  });

  describe('shell schemas', () => {
    it('shellInputSchema accepts sessionId + data string', () => {
      expect(shellInputSchema.safeParse({ sessionId: 's1', data: 'ls\n' }).success).toBe(true);
    });

    it('shellInputSchema allows empty data string', () => {
      expect(shellInputSchema.safeParse({ sessionId: 's1', data: '' }).success).toBe(true);
    });

    it('shellInputSchema rejects missing sessionId', () => {
      expect(shellInputSchema.safeParse({ data: 'ls' }).success).toBe(false);
    });

    it('shellResizeSchema accepts a valid resize payload', () => {
      expect(shellResizeSchema.safeParse({ sessionId: 's1', cols: 80, rows: 24 }).success).toBe(true);
    });

    it('shellResizeSchema rejects cols/rows beyond the 500 cap', () => {
      expect(shellResizeSchema.safeParse({ sessionId: 's1', cols: 501, rows: 24 }).success).toBe(false);
      expect(shellResizeSchema.safeParse({ sessionId: 's1', cols: 80, rows: 999 }).success).toBe(false);
    });

    it('shellResizeSchema rejects zero or negative dimensions', () => {
      expect(shellResizeSchema.safeParse({ sessionId: 's1', cols: 0, rows: 24 }).success).toBe(false);
      expect(shellResizeSchema.safeParse({ sessionId: 's1', cols: 80, rows: -1 }).success).toBe(false);
    });

    it('shellSessionIdSchema and shellStopSchema accept the same shape', () => {
      expect(shellSessionIdSchema.safeParse({ sessionId: 'abc' }).success).toBe(true);
      expect(shellStopSchema.safeParse({ sessionId: 'abc' }).success).toBe(true);
    });
  });

  describe('app schemas', () => {
    it('appUpdateSchema and appStandardizeSchema require appId', () => {
      expect(appUpdateSchema.safeParse({ appId: 'foo' }).success).toBe(true);
      expect(appStandardizeSchema.safeParse({ appId: 'foo' }).success).toBe(true);
      expect(appUpdateSchema.safeParse({}).success).toBe(false);
      expect(appStandardizeSchema.safeParse({}).success).toBe(false);
    });

    it('appDeploySchema defaults flags to an empty array', () => {
      const result = appDeploySchema.safeParse({ appId: 'foo' });
      expect(result.success).toBe(true);
      expect(result.data.flags).toEqual([]);
    });

    it('appDeploySchema accepts whitelisted deploy flags', () => {
      const result = appDeploySchema.safeParse({ appId: 'foo', flags: ['--ios', '--skip-tests'] });
      expect(result.success).toBe(true);
      expect(result.data.flags).toEqual(['--ios', '--skip-tests']);
    });

    it('appDeploySchema rejects unknown flags', () => {
      const result = appDeploySchema.safeParse({ appId: 'foo', flags: ['--rm-rf-everything'] });
      expect(result.success).toBe(false);
    });

    it('appDeploySchema rejects more than 20 flags', () => {
      const tooMany = Array(21).fill('--ios');
      expect(appDeploySchema.safeParse({ appId: 'foo', flags: tooMany }).success).toBe(false);
    });
  });
});

describe('validateSocketData helper', () => {
  function makeSocket() {
    return { emit: vi.fn() };
  }

  it('returns parsed data on success and does not emit', () => {
    const socket = makeSocket();
    const data = validateSocketData(detectStartSchema, { path: '/x' }, socket, 'detect:start');
    expect(data).toEqual({ path: '/x' });
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('applies schema defaults to the returned data', () => {
    const socket = makeSocket();
    const data = validateSocketData(
      logsSubscribeSchema,
      { processName: 'portos' },
      socket,
      'logs:subscribe'
    );
    expect(data.lines).toBe(100);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('returns null and emits a structured error on failure', () => {
    const socket = makeSocket();
    const result = validateSocketData(detectStartSchema, { path: '' }, socket, 'detect:start');
    expect(result).toBeNull();
    expect(socket.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = socket.emit.mock.calls[0];
    expect(event).toBe('detect:start:error');
    expect(payload.message).toBe('Validation failed');
    expect(Array.isArray(payload.details)).toBe(true);
    expect(payload.details[0]).toEqual(
      expect.objectContaining({ path: 'path', message: expect.any(String) })
    );
  });

  it('includes nested field paths in error details', () => {
    const socket = makeSocket();
    const result = validateSocketData(
      shellResizeSchema,
      { sessionId: 's1', cols: 80, rows: 9999 },
      socket,
      'shell:resize'
    );
    expect(result).toBeNull();
    const [, payload] = socket.emit.mock.calls[0];
    expect(payload.details.some(d => d.path === 'rows')).toBe(true);
  });
});
