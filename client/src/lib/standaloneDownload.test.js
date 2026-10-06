// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installStandaloneDownloadHandler } from './standaloneDownload.js';

describe('installStandaloneDownloadHandler', () => {
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  it('shares a same-origin a[download] instead of navigating when standalone', async () => {
    const share = vi.fn().mockResolvedValue();
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x'], { type: 'video/mp4' }) }));
    const off = installStandaloneDownloadHandler();
    document.body.innerHTML = '<a id="a" href="/data/videos/clip.mp4" download>d</a>';
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('a').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(share).toHaveBeenCalled());
    expect(share.mock.calls[0][0].files[0].name).toBe('clip.mp4');
    off();
  });

  it('leaves clicks alone outside standalone mode', () => {
    Object.defineProperty(window.navigator, 'standalone', { value: false, configurable: true });
    const off = installStandaloneDownloadHandler();
    document.body.innerHTML = '<a id="a" href="/x.mp4" download>d</a>';
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('a').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    off();
  });
});
