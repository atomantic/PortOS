// iOS Safari zooms the whole page when a focused field's font-size is under
// 16px, and stays zoomed after blur — most PortOS fields are text-sm/text-xs, so
// on an iPhone every focus pushed the layout (and the field's own Send/Save
// button) off-screen. `maximum-scale=1` suppresses only that focus zoom on iOS:
// since iOS 10 WebKit ignores it for user pinch-zoom. Other engines (Android
// Chrome) honor it as a pinch-zoom lock, so it is applied only where
// `-webkit-touch-callout` exists — a property only iOS/iPadOS WebKit ships, and
// unlike the user agent it is not rewritten by iPadOS desktop mode.
function isIosWebKit(win = globalThis.window) {
  return Boolean(win?.navigator?.maxTouchPoints > 0 && win.CSS?.supports?.('-webkit-touch-callout', 'none'));
}

export function suppressIosFocusZoom(win = globalThis.window) {
  if (!isIosWebKit(win)) return false;
  const meta = win.document?.querySelector('meta[name="viewport"]');
  const content = meta?.getAttribute('content') || '';
  if (!meta || /maximum-scale/i.test(content)) return false;
  meta.setAttribute('content', `${content}, maximum-scale=1`);
  return true;
}
