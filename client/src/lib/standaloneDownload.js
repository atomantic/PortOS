// iOS Home Screen (standalone) PWAs have no browser chrome: a tap on
// `<a download>` navigates the whole app to Quick Look's file preview, which has
// no back affordance, so the user must swipe-kill and relaunch. In that mode we
// intercept same-origin `a[download]` clicks, fetch the bytes, and hand them to
// the native share sheet (Save Image / Save Video / Files) — the app never
// navigates. Everywhere else the default download behavior is untouched.

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

export async function shareDownload(anchor) {
  const url = new URL(anchor.href, window.location.href);
  const filename = filenameFor(anchor, url);
  const res = await fetch(url.href, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const ext = filename.split('.').pop()?.toLowerCase();
  const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : (MIME_BY_EXT[ext] || blob.type);
  const file = new File([blob], filename, { type });
  if (!navigator.canShare?.({ files: [file] })) throw new Error('share unsupported');
  await navigator.share({ files: [file] });
}

// Returns an uninstall function. Capture phase so it runs before the browser's
// default download navigation.
export function installStandaloneDownloadHandler() {
  if (!isStandalonePwa() || typeof navigator.share !== 'function') return () => {};
  const onClick = (event) => {
    if (event.defaultPrevented || event.button > 0) return;
    const anchor = event.target?.closest?.('a[download][href]');
    if (!anchor) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    shareDownload(anchor).catch((err) => {
      // User dismissing the share sheet is not an error.
      if (err?.name === 'AbortError') return;
      console.error(`❌ Download share failed: ${err.message}`);
    });
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
