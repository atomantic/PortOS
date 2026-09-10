import { beforeEach, describe, expect, it, vi } from 'vitest';

const findOrOpenPage = vi.fn();
const isAuthPage = vi.fn();
const evaluateOnPage = vi.fn();
const listCdpPages = vi.fn();
vi.mock('./browserService.js', () => ({ findOrOpenPage, isAuthPage, evaluateOnPage, listCdpPages }));

const tryReadFile = vi.fn();
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return { ...actual, tryReadFile };
});

const { testSelectors } = await import('./messagePlaywrightSync.js');

const OPEN_PAGE = { url: 'https://outlook.office.com/mail/', webSocketDebuggerUrl: 'ws://x' };

describe('testSelectors', () => {
  beforeEach(() => {
    findOrOpenPage.mockReset();
    isAuthPage.mockReset();
    evaluateOnPage.mockReset();
    tryReadFile.mockReset();
  });

  it('reports no-browser when no CDP tab could be found or opened', async () => {
    findOrOpenPage.mockResolvedValue(null);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('no-browser');
    expect(result.results).toEqual({});
    expect(isAuthPage).not.toHaveBeenCalled();
  });

  it('reports auth-required without evaluating selectors when the tab is a login redirect', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(true);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('auth-required');
    expect(evaluateOnPage).not.toHaveBeenCalled();
  });

  it('reports no-selectors when the provider has none configured', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(false);
    tryReadFile.mockResolvedValue(JSON.stringify({}));

    const result = await testSelectors('outlook');

    expect(result.status).toBe('no-selectors');
    expect(evaluateOnPage).not.toHaveBeenCalled();
  });

  it('reports ok when every configured selector matches at least one element', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(false);
    tryReadFile.mockResolvedValue(JSON.stringify({ outlook: { messageRow: "[role='listbox'] [role='option']" } }));
    evaluateOnPage.mockResolvedValue(12);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('ok');
    expect(result.results.messageRow).toEqual({ selector: "[role='listbox'] [role='option']", matches: 12 });
  });

  it('reports partial when at least one configured selector matches zero elements', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(false);
    tryReadFile.mockResolvedValue(JSON.stringify({
      outlook: { messageRow: "[role='listbox'] [role='option']", extra: '.gone' },
    }));
    evaluateOnPage.mockResolvedValueOnce(3).mockResolvedValueOnce(0);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('partial');
    expect(result.results.extra).toEqual({ selector: '.gone', matches: 0 });
  });

  it('treats a failed evaluation (null) as zero matches rather than throwing', async () => {
    findOrOpenPage.mockResolvedValue(OPEN_PAGE);
    isAuthPage.mockReturnValue(false);
    tryReadFile.mockResolvedValue(JSON.stringify({ outlook: { messageRow: "[role='listbox'] [role='option']" } }));
    evaluateOnPage.mockResolvedValue(null);

    const result = await testSelectors('outlook');

    expect(result.status).toBe('partial');
    expect(result.results.messageRow.matches).toBe(0);
  });
});
