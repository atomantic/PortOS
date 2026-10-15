// Mobile downloads use a visible preparation step, followed by a fresh tap to
// share/save. Fetching a large video can outlive Safari's transient activation;
// never call navigator.share automatically after the network request.

export function isStandalonePwa() {
  if (typeof window === 'undefined') return false;
  return window.navigator.standalone === true
    || Boolean(window.matchMedia?.('(display-mode: standalone)').matches);
}

const MIME_BY_EXT = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
};

function filenameFor(anchor, url) {
  const named = anchor.getAttribute('download');
  if (named) return named;
  const last = decodeURIComponent(url.pathname.split('/').pop() || '');
  return last || 'download';
}

// Ask the static mount for an attachment while leaving preview URLs inline.
export function assetDownloadUrl(href) {
  if (!href) return href;
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/data/')) return href;
  url.searchParams.set('download', '1');
  return `${url.pathname}${url.search}${url.hash}`;
}

// The share sheet needs the whole file in the browser's memory first. A phone
// cannot hold a full-length final render (hundreds of MB), so anything larger
// is refused here and the user is pointed at the native download instead.
export const SHARE_SHEET_MAX_BYTES = 100 * 1024 * 1024;

const tooLarge = (bytes) => Object.assign(new Error('Too large for the share sheet'), { code: 'DOWNLOAD_TOO_LARGE', bytes });

export async function prepareDownload({ url, filename }, signal, onProgress) {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers?.get?.('content-length')) || null;
  if (total > SHARE_SHEET_MAX_BYTES) {
    res.body?.cancel?.().catch(() => {});
    throw tooLarge(total);
  }
  let blob;
  const reader = res.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let received = 0;
    onProgress?.({ received, total });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      // No Content-Length (chunked): stop as soon as the file proves too big.
      // Its real size is unknown, so report none rather than the bytes read.
      if (received > SHARE_SHEET_MAX_BYTES) {
        reader.cancel().catch(() => {});
        throw tooLarge(total);
      }
      onProgress?.({ received, total });
    }
    blob = new Blob(chunks, { type: res.headers?.get?.('content-type') || '' });
  } else {
    blob = await res.blob();
  }
  const ext = filename.split('.').pop()?.toLowerCase();
  const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : (MIME_BY_EXT[ext] || blob.type);
  const file = new File([blob], filename, { type });
  if (!navigator.canShare?.({ files: [file] })) throw new Error('This file cannot be saved with the share sheet. Use the browser download below.');
  return file;
}

// Returns an uninstall function. Capture phase so it runs before the browser's
// default download navigation.
export function installStandaloneDownloadHandler(onDownload) {
  const mobile = isStandalonePwa() || window.matchMedia?.('(pointer: coarse)')?.matches;
  if (!mobile || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return () => {};
  const onClick = (event) => {
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target?.closest?.('a[download][href]');
    if (!anchor || anchor.hasAttribute('data-native-download')) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    onDownload({ url: url.href, filename: filenameFor(anchor, url) });
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
