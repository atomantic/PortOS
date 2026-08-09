import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToUrlPinned = vi.fn();
const closeCdpPage = vi.fn();
vi.mock('./browserService.js', () => ({ navigateToUrlPinned, closeCdpPage }));

const { fixedXUrl, openXHandoff, verifyFinalXPath } = await import('./xBrowser.js');

describe('X browser handoffs', () => {
  beforeEach(() => {
    navigateToUrlPinned.mockReset();
    closeCdpPage.mockReset();
    closeCdpPage.mockResolvedValue(undefined);
  });

  it('builds only the named fixed-origin destinations', () => {
    expect(fixedXUrl('profile', 'example_user')).toBe('https://x.com/example_user');
    expect(fixedXUrl('people', 'example_user')).toBe('https://x.com/search?q=example_user&src=typed_query&f=user');
    expect(fixedXUrl('latest', 'example_user')).toBe('https://x.com/search?q=from%3Aexample_user+-filter%3Areplies&src=typed_query&f=live');
    expect(fixedXUrl('compose', 'A bounded draft')).toContain('https://x.com/compose/post?text=A+bounded+draft');
    expect(() => fixedXUrl('profile', '../example')).toThrow('Invalid X username');
    expect(() => fixedXUrl('arbitrary', 'example_user')).toThrow('Unsupported X browser destination');
  });

  it('keeps a compose handoff open only after same-origin path verification', async () => {
    navigateToUrlPinned.mockResolvedValue({ id: 'page-1', url: 'https://x.com/compose/post?text=A+draft' });
    await expect(openXHandoff({ kind: 'compose', value: 'A draft' })).resolves.toMatchObject({
      pageId: 'page-1',
      url: 'https://x.com/compose/post?text=A+draft',
    });
    expect(navigateToUrlPinned).toHaveBeenCalledWith(expect.stringContaining('https://x.com/compose/post'), expect.objectContaining({ closeAfterRead: false }));

    expect(() => verifyFinalXPath('https://x.com/example_user', 'https://example.com/example_user')).toThrow('left the fixed origin');
    expect(() => verifyFinalXPath('https://x.com/example_user', 'https://x.com/another_user')).toThrow('different page than the one requested');
  });

  it('closes the tab it owns when the handoff lands on a redirected page', async () => {
    // `closeAfterRead: false` hands tab ownership to openXHandoff; the caller
    // never learns the page id when verification throws, so failing to close
    // here leaked a Chrome tab on every redirected compose/profile handoff.
    navigateToUrlPinned.mockResolvedValue({ id: 'page-2', url: 'https://x.com/i/flow/login' });
    await expect(openXHandoff({ kind: 'profile', value: 'example_user' }))
      .rejects.toThrow('different page than the one requested');
    expect(closeCdpPage).toHaveBeenCalledWith('page-2');
  });

  it('does not close the tab on a verified handoff, and survives a failed close', async () => {
    navigateToUrlPinned.mockResolvedValue({ id: 'page-3', url: 'https://x.com/example_user' });
    await expect(openXHandoff({ kind: 'profile', value: 'example_user' })).resolves.toMatchObject({ pageId: 'page-3' });
    expect(closeCdpPage).not.toHaveBeenCalled();

    // A close that itself fails must not mask the verification error.
    closeCdpPage.mockRejectedValue(new Error('CDP socket closed'));
    navigateToUrlPinned.mockResolvedValue({ id: 'page-4', url: 'https://x.com/other_user' });
    await expect(openXHandoff({ kind: 'profile', value: 'example_user' }))
      .rejects.toThrow('different page than the one requested');
  });
});
