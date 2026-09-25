import { describe, expect, it } from 'vitest';
import { localReviewBridgeRequest } from './localReviewBridge.js';

describe('localReviewBridgeRequest', () => {
  it('keeps claim review isolated even if a caller clears the redundant flag', () => {
    expect(localReviewBridgeRequest({ kind: 'claim-review', backend: 'provider:example', toolFree: false, timeoutMs: 42 }, '/checkout'))
      .toEqual({ kind: 'claim-review', backend: 'provider:example', toolFree: true, timeoutMs: 42, cwd: '/checkout' });
  });

  it('preserves the ordinary review policy and ignores invalid timeout overrides', () => {
    expect(localReviewBridgeRequest({ backend: 'provider:example', timeoutMs: -1 }, '/checkout'))
      .toEqual({ backend: 'provider:example', cwd: '/checkout' });
  });
});
