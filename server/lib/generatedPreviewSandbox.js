/** Browser-safe containment for generated HTML. The trusted outer document owns
 * the navigation policy; generated code never shares its DOM or origin.
 * srcdoc boots under frame-src 'none', but a child's URL navigation is blocked.
 */
export const GENERATED_PREVIEW_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline' data:", "style-src 'unsafe-inline'",
  'img-src data: blob:', 'media-src data: blob:', 'font-src data: blob:',
  "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "worker-src 'none'",
  "base-uri 'none'", "form-action 'none'", "manifest-src 'none'",
].join('; ');

const literal = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

export const MUSIC_VIDEO_PREVIEW_MESSAGES = {
  fromChild: ['portos-mv:loaded', 'portos-mv:request', 'portos-mv:seeked', 'portos-mv:error'],
  toChild: ['portos-mv:manifest', 'portos-mv:asset', 'portos-mv:seek', 'portos-mv:film-look', 'portos-mv:title-card'],
};

export function buildGeneratedPreviewSandbox(html, { revision, fromChild, toChild }) {
  // Install the guards before ANY provider markup, including markup before its head.
  const guarded = `<script>for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker', 'WebSocket']) {
    Object.defineProperty(globalThis, key, { configurable: false, writable: false,
      value: function() { throw new Error(key + ' is disabled in previews'); } });
  }</script>${html}`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${GENERATED_PREVIEW_CSP}"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style></head><body><script>(() => {
    const revision = ${literal(revision)};
    const fromChild = new Set(${literal(fromChild)});
    const toChild = new Set(${literal(toChild)});
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-scripts';
    frame.allow = 'autoplay';
    frame.referrerPolicy = 'no-referrer';
    frame.srcdoc = ${literal(guarded)};
    let active = true;
    let loaded = false;
    const stop = () => { active = false; window.removeEventListener('message', relay); };
    const relay = (event) => {
      if (!active || !event.data || typeof event.data !== 'object') return;
      if (event.source === parent && toChild.has(event.data.type)) {
        frame.contentWindow.postMessage(event.data, '*');
      } else if (event.source === frame.contentWindow && fromChild.has(event.data.type)) {
        parent.postMessage({ ...event.data, previewRevision: revision }, '*');
      }
    };
    // A second document never inherits a bridge, even for a non-network navigation.
    frame.addEventListener('load', () => { if (loaded) stop(); loaded = true; });
    window.addEventListener('message', relay);
    window.addEventListener('pagehide', stop, { once: true });
    document.body.append(frame);
  })();</script></body></html>`;
}
