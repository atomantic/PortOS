import { afterEach, expect, it, vi } from 'vitest';
import { installStandaloneDownloadHandler, assetDownloadUrl } from './standaloneDownload.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

it('leaves native downloads alone on desktop, without file sharing, and for external or modified links', () => {
  const onDownload = vi.fn();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.stubGlobal('navigator', { share: vi.fn(), canShare: () => true });
  document.body.innerHTML = '<a href="/data/videos/clip.mp4" download>Download</a>';
  const click = (options) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...options });
    const anchor = document.querySelector('a');
    anchor.addEventListener('click', event => {
      expect(event.defaultPrevented).toBe(false);
      event.preventDefault();
    }, { once: true });
    anchor.dispatchEvent(event);
  };
  let off = installStandaloneDownloadHandler(onDownload);
  click();
  off();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  vi.stubGlobal('navigator', {});
  off = installStandaloneDownloadHandler(onDownload);
  click();
  off();
  vi.stubGlobal('navigator', { share: vi.fn(), canShare: () => true });
  off = installStandaloneDownloadHandler(onDownload);
  click({ ctrlKey: true });
  document.querySelector('a').href = 'https://example.org/clip.mp4';
  click();
  off();
  expect(onDownload).not.toHaveBeenCalled();
});

it('adds attachment semantics only to local data URLs and preserves cache parameters', () => {
  expect(assetDownloadUrl('/data/videos/clip.mp4?_t=2')).toBe('/data/videos/clip.mp4?_t=2&download=1');
  expect(assetDownloadUrl('https://example.org/clip.mp4')).toBe('https://example.org/clip.mp4');
  expect(assetDownloadUrl('/api/music-video/example/sharing-copy/download')).toBe('/api/music-video/example/sharing-copy/download');
});
