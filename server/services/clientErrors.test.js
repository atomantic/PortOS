import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./review.js', () => ({
  createItem: vi.fn(),
}));

const review = await import('./review.js');
const { recordClientError, _resetForTests } = await import('./clientErrors.js');

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  review.createItem.mockImplementation(async ({ title, metadata }) => ({
    id: `item-${metadata?.referenceId ?? title}`,
    title,
    metadata,
  }));
});

describe('recordClientError', () => {
  it('forwards the first report to Review Hub as an alert with a referenceId', async () => {
    const result = await recordClientError({
      type: 'error',
      message: 'Cannot read properties of undefined',
      stack: 'TypeError: x\n    at Foo (foo.js:1:1)',
      url: 'https://portos/dashboard',
      source: '/assets/index.js',
      line: 42,
      column: 7,
    });

    expect(result.accepted).toBe(true);
    expect(review.createItem).toHaveBeenCalledTimes(1);
    const arg = review.createItem.mock.calls[0][0];
    expect(arg.type).toBe('alert');
    expect(arg.title).toMatch(/^Client error: /);
    expect(arg.metadata.category).toBe('client-error');
    expect(arg.metadata.referenceId).toMatch(/^client-error:[0-9a-f]{16}$/);
  });

  it('redacts api-key-shaped secrets in the message and stack', async () => {
    await recordClientError({
      type: 'error',
      message: 'fetch failed with apiKey="sk-abcdef0123456789abcdef0123" and details',
      stack: 'Error\n    at AuthorizedRequest (api.js:5:9) bearer abcdef0123456789abcdef',
    });

    const arg = review.createItem.mock.calls[0][0];
    expect(arg.title).toContain('[REDACTED]');
    expect(arg.description).toContain('[REDACTED]');
    expect(arg.description).not.toContain('sk-abcdef0123456789abcdef0123');
  });

  it('strips the query string from the captured page URL', async () => {
    await recordClientError({
      type: 'error',
      message: 'boom',
      url: 'https://portos/secret?token=keepout',
    });

    const arg = review.createItem.mock.calls[0][0];
    expect(arg.description).toContain('URL: https://portos/secret');
    expect(arg.description).not.toContain('token=keepout');
  });

  it('drops duplicate reports within the dedup window', async () => {
    const payload = {
      type: 'error',
      message: 'same error',
      stack: 'Error: same error\n    at foo (foo.js:1:1)\n    at bar (bar.js:2:2)',
    };
    const first = await recordClientError(payload);
    expect(first.accepted).toBe(true);

    // Wait past the 1s rate-limit so the dedup branch (not rate-limit) is exercised.
    const realDateNow = Date.now;
    const fakeNow = realDateNow() + 2000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);

    const second = await recordClientError(payload);
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(review.createItem).toHaveBeenCalledTimes(1);

    Date.now = realDateNow;
  });

  it('drops reports that arrive faster than the 1/sec throttle', async () => {
    const first = await recordClientError({
      type: 'error',
      message: 'err A',
      stack: 'Error: A\n    at a (a.js:1:1)',
    });
    expect(first.accepted).toBe(true);

    const second = await recordClientError({
      type: 'error',
      message: 'err B',
      stack: 'Error: B\n    at b (b.js:1:1)',
    });
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('rate-limited');
    expect(review.createItem).toHaveBeenCalledTimes(1);
  });

  it('truncates oversize messages and stacks rather than passing them through', async () => {
    await recordClientError({
      type: 'error',
      message: 'm'.repeat(2000),
      stack: 's'.repeat(20000),
    });
    const arg = review.createItem.mock.calls[0][0];
    expect(arg.title.length).toBeLessThan(200);
    expect(arg.description.length).toBeLessThan(5000);
  });

  it('returns a failure marker when the Review Hub write fails', async () => {
    review.createItem.mockRejectedValueOnce(new Error('disk full'));
    const result = await recordClientError({ type: 'error', message: 'boom' });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('review-hub-write-failed');
  });

  it('throttles subsequent calls even when the previous Review Hub write failed', async () => {
    review.createItem.mockRejectedValueOnce(new Error('disk full'));
    const first = await recordClientError({
      type: 'error',
      message: 'first failing error',
      stack: 'Error: first\n    at foo (a.js:1:1)',
    });
    expect(first.reason).toBe('review-hub-write-failed');

    const second = await recordClientError({
      type: 'error',
      message: 'second distinct error',
      stack: 'Error: second\n    at bar (b.js:1:1)',
    });
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('rate-limited');
    expect(review.createItem).toHaveBeenCalledTimes(1);
  });

  it('strips the query string from the source script URL', async () => {
    await recordClientError({
      type: 'error',
      message: 'boom',
      source: '/assets/index-abc.js?token=keepout',
    });
    const arg = review.createItem.mock.calls[0][0];
    expect(arg.description).toContain('Source: /assets/index-abc.js');
    expect(arg.description).not.toContain('token=keepout');
    expect(arg.metadata.source).toBe('/assets/index-abc.js');
  });

  it('accepts the same error again once its dedup window has expired', async () => {
    const payload = {
      type: 'error',
      message: 'recurring error',
      stack: 'Error: recurring\n    at foo (foo.js:1:1)',
    };
    const first = await recordClientError(payload);
    expect(first.accepted).toBe(true);

    // Jump past the 24h dedup window AND past the 1s throttle.
    const realDateNow = Date.now;
    const ONE_DAY_AND_CHANGE = 25 * 60 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(realDateNow() + ONE_DAY_AND_CHANGE);

    const second = await recordClientError(payload);
    expect(second.accepted).toBe(true);
    expect(review.createItem).toHaveBeenCalledTimes(2);

    Date.now = realDateNow;
  });

  it('strips a `#fragment` from URL fields too (OAuth implicit-grant tokens)', async () => {
    await recordClientError({
      type: 'error',
      message: 'boom',
      url: 'https://portos/callback#access_token=keepout',
    });
    const arg = review.createItem.mock.calls[0][0];
    expect(arg.description).toContain('URL: https://portos/callback');
    expect(arg.description).not.toContain('access_token');
  });

  describe('browser-extension errors', () => {
    it('never reaches the Review Hub when thrown by an injected content script', async () => {
      const result = await recordClientError({
        type: 'error',
        message: "Cannot read properties of null (reading 'ethereum')",
        source: 'chrome-extension://examplewalletextensionid00000000/inpage.js',
        url: 'https://portos/dashboard',
      });

      expect(result).toEqual({ accepted: false, reason: 'extension' });
      expect(review.createItem).not.toHaveBeenCalled();
    });

    it('does not spend the throttle slot, so a real error right behind it still lands', async () => {
      // The whole reason the filter runs BEFORE the throttle gate: an
      // extension error accepted at T would drop a genuine PortOS error at
      // T+<1s as `rate-limited`, losing it permanently.
      await recordClientError({
        type: 'unhandledrejection',
        message: 'Failed to connect to MetaMask',
      });
      const real = await recordClientError({
        type: 'error',
        message: 'Genuine PortOS failure',
        source: '/assets/index.js',
      });

      expect(real.accepted).toBe(true);
      expect(review.createItem).toHaveBeenCalledTimes(1);
      expect(review.createItem.mock.calls[0][0].title).toContain('Genuine PortOS failure');
    });

    it('still detects the frame when truncation would have cut it off', async () => {
      // Why detection runs on the RAW payload: sanitize() caps the stack at
      // MAX_STACK_CHARS (4000), so an unusually long first line pushes the
      // originating frame past the cut and a post-sanitize check would let the
      // extension error through as if it were ours.
      const stack = [
        `TypeError: ${'x'.repeat(5000)}`,
        '    at inject (chrome-extension://examplewalletextensionid00000000/inpage.js:1:1)',
      ].join('\n');

      const result = await recordClientError({ type: 'error', message: 'boom', stack });

      expect(result.reason).toBe('extension');
      expect(review.createItem).not.toHaveBeenCalled();
    });

    it('does NOT drop a real PortOS error that merely ran through extension code', async () => {
      // The extension frame is below ours, so PortOS threw it — it must reach
      // the Review Hub rather than be silently swallowed.
      const result = await recordClientError({
        type: 'error',
        message: "Cannot read properties of undefined (reading 'id')",
        stack: [
          "TypeError: Cannot read properties of undefined (reading 'id')",
          '    at renderRow (https://portos/assets/index-abc.js:10:5)',
          '    at wrappedFetch (chrome-extension://examplewalletextensionid00000000/inpage.js:1:1)',
        ].join('\n'),
      });

      expect(result.accepted).toBe(true);
      expect(review.createItem).toHaveBeenCalledTimes(1);
    });

    it('does NOT filter `crypto.randomUUID is not a function` — that is our own bug', async () => {
      // Insecure-origin crash from PortOS's own code (see client/src/lib/uuid.js).
      // It superficially resembles extension noise; filtering it would hide a
      // real crash that fires from every toast.
      const result = await recordClientError({
        type: 'unhandledrejection',
        message: 'crypto.randomUUID is not a function',
        url: 'http://example-host.ts.net:5554/apps/portos-demo',
      });

      expect(result.accepted).toBe(true);
      expect(review.createItem).toHaveBeenCalledTimes(1);
    });
  });
});
