import { describe, expect, it } from 'vitest';
import { createUnexpectedFetchGuard } from './networkGuard.js';

describe('unexpected test fetch guard', () => {
  it('stops a request, identifies its test and path, and omits query values', async () => {
    const guard = createUnexpectedFetchGuard(() => 'example test');
    await expect(guard.fetch('/api/example?token=private-value')).rejects.toThrow('example test: /api/example');
    await expect(guard.fetch(new URL('https://example.com/api/example?secret=another-value'))).rejects.toThrow();
    const error = guard.takeError();
    expect(error.message).toContain('example test: /api/example (2x)');
    expect(error.message).not.toMatch(/private-value|another-value|example\.com/);
    expect(guard.takeError()).toBeNull();
  });

  it('bounds the report when a test makes many distinct requests', async () => {
    const guard = createUnexpectedFetchGuard(() => 'many requests');
    for (let n = 0; n < 7; n += 1) await expect(guard.fetch(`/api/item-${n}`)).rejects.toThrow();
    const error = guard.takeError();
    expect(error.message).toContain('/api/item-4');
    expect(error.message).toContain('and 2 more');
    expect(error.message).not.toContain('/api/item-6');
  });
});
