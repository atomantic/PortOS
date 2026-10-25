/**
 * Freeze the actual preview tree, including CSS fitting/transforms and SVG filters.
 * Media becomes decoded pixels before async rasterization, so a later seek cannot
 * replace the selected frame. The resulting SVG is used only as an inert image.
 */
export async function capturePreviewFrame(root, { iframeImages = new Map() } = {}) {
  if (!root) throw new Error('Preview unavailable');
  const box = root.getBoundingClientRect();
  const width = Math.ceil(box.width);
  const height = Math.ceil(box.height);
  if (!width || !height || width * height > 16777216) throw new Error('Preview size unavailable');
  for (const video of root.querySelectorAll('video[data-preview-video]')) {
    const surface = getComputedStyle(video.parentElement);
    if (surface.display === 'none' || surface.visibility === 'hidden' || Number(surface.opacity) === 0) continue;
    if (video.dataset.previewError) throw new Error(video.dataset.previewError);
    if (video.seeking || video.dataset.pausedFrame !== String(video.currentTime)) throw new Error('Video frame is still loading');
  }
  const raster = (source, w, h) => {
    if (!w || !h) throw new Error('Preview media has not decoded');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, Math.sqrt(16777216 / (w * h)));
    canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!ctx) throw new Error('Frame capture unavailable');
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  };
  const capturedNodes = new Set();
  const freeze = (node) => {
    capturedNodes.add(node);
    if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
    if (node.nodeType !== Node.ELEMENT_NODE || ['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT'].includes(node.tagName)) return null;
    const style = getComputedStyle(node);
    const hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
      || (node.tagName === 'VIDEO' && node.getAttribute('aria-hidden') === 'true');
    const media = ['IMG', 'VIDEO', 'CANVAS', 'IFRAME'].includes(node.tagName);
    const copy = media ? document.createElement(hidden ? 'div' : 'img') : node.cloneNode(false);
    for (const attribute of [...copy.attributes]) {
      if (/^on/i.test(attribute.name)) copy.removeAttribute(attribute.name);
    }
    for (const property of style) {
      // Computed local SVG filter URLs include the live document's address.
      const value = style.getPropertyValue(property).replace(/url\(["']?[^)"']*#([^)"']+)["']?\)/g, 'url(#$1)');
      copy.style.setProperty(property, value);
    }
    copy.style.animation = 'none'; copy.style.transition = 'none';
    if (hidden) return copy;
    if (media) {
      if (node.tagName === 'IFRAME') {
        const png = iframeImages.get(node);
        if (!png) throw new Error('Lyric frame unavailable');
        copy.src = png;
      } else if (node.tagName === 'VIDEO') {
        if (node.readyState < 2 || node.seeking) throw new Error('Video frame is still loading');
        copy.src = raster(node, node.videoWidth, node.videoHeight);
      } else if (node.tagName === 'CANVAS') copy.src = raster(node, node.width, node.height);
      else {
        if (!node.complete) throw new Error('Image frame is still loading');
        copy.src = raster(node, node.naturalWidth, node.naturalHeight);
      }
      return copy;
    }
    for (const child of node.childNodes) {
      const frozen = freeze(child);
      if (frozen) copy.appendChild(frozen);
    }
    return copy;
  };
  const frozen = freeze(root);
  frozen.style.position = 'relative'; frozen.style.margin = '0';
  frozen.style.left = '0'; frozen.style.top = '0';
  frozen.style.width = `${box.width}px`; frozen.style.height = `${box.height}px`;
  const markup = new XMLSerializer().serializeToString(frozen);
  // The extra column proves foreignObject actually rendered; unsupported browsers
  // must fail rather than upload a valid but blank PNG. It is cropped from output.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 1}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width + 1}px;height:${height}px">${markup}<div style="position:absolute;left:${width}px;bottom:0;width:1px;height:1px;background:rgb(13,231,97)"></div></div></foreignObject></svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  // Media is frozen synchronously, but resizing or a late filter/effect render
  // during decode/PNG encoding must not upload a stale preview revision.
  let changed = false;
  // Hidden preload subtrees are omitted by freeze and cannot change the picture.
  const affectsPicture = records => records.some(({ target }) => capturedNodes.has(target));
  const observer = new MutationObserver(records => { changed ||= affectsPicture(records); });
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  let timer;
  try {
    try {
      await Promise.race([image.decode(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Frame capture timed out')), 5000); })]);
    } catch (error) { image.src = ''; throw error; }
    finally { clearTimeout(timer); }
    const canvas = document.createElement('canvas');
    canvas.width = width + 1; canvas.height = height;
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!ctx) throw new Error('Frame capture unavailable');
    ctx.drawImage(image, 0, 0);
    const probe = ctx.getImageData(width, height - 1, 1, 1).data;
    if (probe[0] !== 13 || probe[1] !== 231 || probe[2] !== 97 || probe[3] !== 255) throw new Error('This browser cannot capture the preview');
    const output = document.createElement('canvas');
    output.width = width; output.height = height;
    const paint = output.getContext('2d', { colorSpace: 'srgb' });
    if (!paint) throw new Error('Frame capture unavailable');
    // The figure's black ground sits outside the film-look filter.
    paint.fillStyle = '#000'; paint.fillRect(0, 0, width, height);
    paint.drawImage(canvas, 0, 0);
    const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Frame capture failed');
    const currentBox = root.getBoundingClientRect();
    if (changed || affectsPicture(observer.takeRecords()) || !root.isConnected
      || currentBox.width !== box.width || currentBox.height !== box.height) throw new Error('Preview changed during capture');
    return blob;
  } finally { observer.disconnect(); }
}

/** Capture-only bridge for the known canvas-based lyric overlay, including its title card. */
export function lyricFrameCaptureBridge() {
  addEventListener('message', (event) => {
    const request = event.data;
    if (event.source !== parent || request?.type !== 'portos-mv:capture-lyrics'
      || typeof request.id !== 'string' || request.id.length > 100 || !Number.isFinite(request.t)) return;
    try {
      const output = document.createElement('canvas');
      output.width = innerWidth; output.height = innerHeight;
      if (!output.width || !output.height || output.width * output.height > 16777216) throw new Error('Invalid lyric frame');
      const ctx = output.getContext('2d', { colorSpace: 'srgb' });
      const layers = [...document.querySelectorAll('canvas')];
      if (!ctx || !layers.length) throw new Error('Lyric frame unavailable');
      for (const canvas of layers) {
        const style = getComputedStyle(canvas);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        const box = canvas.getBoundingClientRect();
        ctx.globalAlpha = Number(style.opacity);
        const scale = style.objectFit === 'contain' ? Math.min(box.width / canvas.width, box.height / canvas.height)
          : style.objectFit === 'cover' ? Math.max(box.width / canvas.width, box.height / canvas.height) : null;
        const width = scale == null ? box.width : canvas.width * scale;
        const height = scale == null ? box.height : canvas.height * scale;
        ctx.save(); ctx.beginPath(); ctx.rect(box.left, box.top, box.width, box.height); ctx.clip();
        ctx.drawImage(canvas, box.left + (box.width - width) / 2, box.top + (box.height - height) / 2, width, height);
        ctx.restore();
      }
      const png = output.toDataURL('image/png');
      if (png.length > 24000000) throw new Error('Lyric frame is too large');
      parent.postMessage({ type: 'portos-mv:captured-lyrics', id: request.id, t: request.t, png }, '*');
    } catch {
      parent.postMessage({ type: 'portos-mv:captured-lyrics', id: request.id, t: request.t, error: true }, '*');
    }
  });
}
