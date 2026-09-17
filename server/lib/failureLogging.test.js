/**
 * Fire-and-forget failures must retain their source location (#6934, #7549).
 */

import { describe, it, expect, vi } from 'vitest';
import { logFailureWithStack } from './failureLogging.js';

describe('logFailureWithStack', () => {
  it('includes an Error stack alongside the failure message', () => {
    const error = vi.fn();

    logFailureWithStack('❌ Backup scheduler init failed', new Error('database unavailable'), error);

    expect(error).toHaveBeenCalledWith(
      '❌ Backup scheduler init failed: database unavailable',
      expect.stringContaining('Error: database unavailable'),
    );
  });

  it('supports a custom logger without dropping the stack', () => {
    const warn = vi.fn();
    const error = new Error('restore failed');

    logFailureWithStack('⚠️ tailcat restore failed', error, warn);

    expect(warn).toHaveBeenCalledWith(
      '⚠️ tailcat restore failed: restore failed',
      expect.stringContaining('Error: restore failed'),
    );
  });

  it('falls back to console.error and String(error) for a non-Error value', () => {
    const originalConsoleError = console.error;
    const spy = vi.fn();
    console.error = spy;
    try {
      logFailureWithStack('❌ Something failed', 'plain string reason');
    } finally {
      console.error = originalConsoleError;
    }

    expect(spy).toHaveBeenCalledWith('❌ Something failed: plain string reason', '');
  });
});
