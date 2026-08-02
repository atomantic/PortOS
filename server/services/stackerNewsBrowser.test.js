import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToUrlPinned = vi.fn();
const closeCdpPage = vi.fn();
vi.mock('./browserService.js', () => ({ navigateToUrlPinned, closeCdpPage }));
const { getStackerNewsBrowserIdentity, openStackerNewsHandoff } = await import('./stackerNewsBrowser.js');

describe('Stacker News CDP handoff', () => {
  beforeEach(() => { navigateToUrlPinned.mockReset(); closeCdpPage.mockReset(); });

  it('uses fixed Stacker News URLs and blocks an identity mismatch before opening a destination', async () => {
    navigateToUrlPinned.mockResolvedValue({ id: 'page-1', url: 'https://stacker.news', evalResult: { username: 'wrong_user' } });
    await expect(openStackerNewsHandoff({ kind: 'item', value: '42', expectedUsername: 'example_user' })).rejects.toThrow('not the selected account');
    expect(navigateToUrlPinned).toHaveBeenCalledTimes(1);
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news');
    expect(navigateToUrlPinned.mock.calls[0][1].evaluateExpression).toContain('__NEXT_DATA__');
  });

  it('opens only an internally constructed item URL after identity verification', async () => {
    navigateToUrlPinned
      .mockResolvedValueOnce({ id: 'identity', url: 'https://stacker.news', evalResult: { username: 'example_user' } })
      .mockResolvedValueOnce({ id: 'item', url: 'https://stacker.news/items/42' });
    await expect(openStackerNewsHandoff({ kind: 'item', value: '42', expectedUsername: 'example_user' })).resolves.toMatchObject({ pageId: 'item' });
    expect(navigateToUrlPinned.mock.calls[1][0]).toBe('https://stacker.news/items/42');
    expect(navigateToUrlPinned.mock.calls[1][1]).not.toHaveProperty('evaluateExpression');
  });

  // The identity read is scratch: without teardown every check (and every
  // handoff, which checks first) leaves another stacker.news tab behind. That
  // teardown is `navigateToUrlPinned`'s job now — supplying `evaluateExpression`
  // IS the request for it (#3365) — so what this asserts is the delegation:
  // the identity nav opts in, the handoff nav (the tab the user keeps) does not,
  // and this module closes nothing itself.
  it('delegates identity-tab teardown to the pinned navigation and leaves ONLY the handoff tab open', async () => {
    navigateToUrlPinned
      .mockResolvedValueOnce({ id: 'identity', url: 'https://stacker.news', evalResult: { username: 'example_user' } })
      .mockResolvedValueOnce({ id: 'item', url: 'https://stacker.news/items/42' });
    await openStackerNewsHandoff({ kind: 'item', value: '42', expectedUsername: 'example_user' });
    expect(navigateToUrlPinned.mock.calls[0][1].evaluateExpression).toBeTruthy();
    expect(navigateToUrlPinned.mock.calls[1][1]).not.toHaveProperty('evaluateExpression');
    expect(closeCdpPage).not.toHaveBeenCalled();
  });

  it('delegates identity-tab teardown on a standalone identity check', async () => {
    navigateToUrlPinned.mockResolvedValue({ id: 'identity', url: 'https://stacker.news', evalResult: { username: 'example_user' } });
    await expect(getStackerNewsBrowserIdentity()).resolves.toEqual({ username: 'example_user', url: 'https://stacker.news' });
    expect(navigateToUrlPinned.mock.calls[0][1].evaluateExpression).toBeTruthy();
    expect(closeCdpPage).not.toHaveBeenCalled();
  });
});
