import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToUrlPinned = vi.fn();
vi.mock('./browserService.js', () => ({ navigateToUrlPinned }));

const { fixedXUrl, openXHandoff, verifyFinalXPath } = await import('./xBrowser.js');

describe('X browser handoffs', () => {
  beforeEach(() => navigateToUrlPinned.mockReset());

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
});
